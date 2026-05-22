/**
 * SubagentSessionManager — owns sub-agent session creation, tracking, and disposal.
 *
 * Responsibilities:
 * - Track open AgentSession instances by record ID
 * - Serialize concurrent runs for the same record via a promise-based lock
 * - Create sessions: opens/creates Pi session manager files, resolves model and
 *   tools from AgentConfig, wires prompt rendering via resource loader, checks
 *   model/tool warnings, subscribes to agent_end for metadata timestamp updates,
 *   wraps dispose to unsubscribe first
 * - Dispose sessions individually or all at once
 *
 * Platform-specific operations are injected via adapters so the manager is
 * testable without live Pi sessions or an LLM.
 */

import * as fs from "node:fs";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@mariozechner/pi-coding-agent";
import type { Model, ThinkingLevel } from "@mariozechner/pi-ai";
import { extractOutput } from "./output-extraction.js";
import type { AgentConfig } from "./agents.js";
import type { MetadataStore, SubagentRecord } from "./metadata.js";

// ---------------------------------------------------------------------------
// Injectable adapter interfaces
// ---------------------------------------------------------------------------

/**
 * Adapter for opening or creating a Pi session manager file on disk.
 */
export interface SessionManagerProvider {
	openOrCreate(sessionFile: string, sessionDir: string, cwd: string): SessionManager;
}

/**
 * Adapter for creating an AgentSession instance inside a session manager.
 */
export interface AgentSessionFactory {
	create(config: {
		cwd: string;
		model: Model | undefined;
		tools: string[] | undefined;
		resourceLoader: DefaultResourceLoader;
		sessionManager: SessionManager;
		thinkingLevel: ThinkingLevel | undefined;
		modelRegistry?: any;
	}): Promise<AgentSession>;
}

/**
 * Adapter for resolving a model config string to a Model object,
 * including auth-availability checks.
 */
export interface ModelResolver {
	resolve(
		modelName: string | undefined,
		fallback: Model | undefined,
		warnings: string[],
	): Model | undefined;
}

// ---------------------------------------------------------------------------
// Default (production) adapter implementations
// ---------------------------------------------------------------------------

export class PiSessionManagerProvider implements SessionManagerProvider {
	openOrCreate(sessionFile: string, sessionDir: string, cwd: string): SessionManager {
		return fs.existsSync(sessionFile)
			? SessionManager.open(sessionFile, sessionDir, cwd)
			: SessionManager.create(cwd, sessionDir);
	}
}

export class PiAgentSessionFactory implements AgentSessionFactory {
	async create(config: {
		cwd: string;
		model: Model | undefined;
		tools: string[] | undefined;
		resourceLoader: DefaultResourceLoader;
		sessionManager: SessionManager;
		thinkingLevel: ThinkingLevel | undefined;
		modelRegistry?: any;
	}): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: config.cwd,
			model: config.model,
			tools: config.tools,
			resourceLoader: config.resourceLoader,
			sessionManager: config.sessionManager,
			thinkingLevel: config.thinkingLevel,
			// Share parent's modelRegistry so the child inherits the same
			// auth state, runtime overrides, and dynamically-registered providers.
			modelRegistry: config.modelRegistry,
		});
		// Task sub-agents are not managed by InteractiveMode/PrintMode, so the
		// usual host-level bind step would otherwise never happen. Bind here so
		// session_start/resources_discover handlers run and extensions that register
		// tools lazily (for example package-provided web tools) become available.
		await session.bindExtensions({});
		return session;
	}
}

export class PiModelResolver implements ModelResolver {
	constructor(private modelRegistry: any) {}

	resolve(
		modelName: string | undefined,
		fallback: Model | undefined,
		warnings: string[],
	): Model | undefined {
		if (!modelName) return undefined;
		let model: Model | undefined;

		if (modelName.includes("/")) {
			// Provider-prefixed name: look up exact provider+id
			const [provider, id] = modelName.split("/", 2);
			model = this.modelRegistry.find(provider, id);
			if (!model) {
				warnings.push(
					`Configured model "${modelName}" was not found; using the current/default model.`,
				);
				return fallback;
			}
			if (
				typeof this.modelRegistry.hasConfiguredAuth === "function" &&
				!this.modelRegistry.hasConfiguredAuth(model)
			) {
				warnings.push(
					`Configured model "${modelName}" is not available because its provider is not authenticated; using the current/default model.`,
				);
				return fallback;
			}
			return model;
		}

		// Bare model id: prefer authenticated providers, then fall back.
		// getAvailable() returns only models whose provider has auth configured;
		// getAll() returns all models regardless of auth status.
		// We search getAvailable() first because a bare id may exist under
		// multiple providers (e.g. "deepseek-v4-flash" under both "deepseek"
		// and "opencode-go") and we want the one the user can actually use.
		const available =
			typeof this.modelRegistry.getAvailable === "function"
				? this.modelRegistry.getAvailable()
				: [];
		const all: Model[] =
			typeof this.modelRegistry.getAll === "function"
				? this.modelRegistry.getAll()
				: [];

		const matchIn = (source: Model[]): Model | undefined =>
			source.find(
				(candidate: Model) =>
					candidate.id === modelName ||
					`${candidate.provider}/${candidate.id}` === modelName,
			);

		model = matchIn(available);
		if (!model) {
			model = matchIn(all);
		}

		if (!model) {
			warnings.push(
				`Configured model "${modelName}" was not found; using the current/default model.`,
			);
			return fallback;
		}

		// If we found the model in getAvailable() it's already authenticated.
		// If we fell back to getAll(), verify auth explicitly.
		if (
			typeof this.modelRegistry.hasConfiguredAuth === "function" &&
			!this.modelRegistry.hasConfiguredAuth(model)
		) {
			warnings.push(
				`Configured model "${modelName}" is not available because its provider is not authenticated; using the current/default model.`,
			);
			return fallback;
		}

		return model;
	}
}

// ---------------------------------------------------------------------------
// Per-call session setup context
// ---------------------------------------------------------------------------

/**
 * Runtime context passed to `getOrCreateSession` for each Task call.
 * Carries the per-session values that vary between calls: Pi runtime
 * objects, the active metadata store, and a factory for creating the
 * resource loader (which depends on the current agent and parent runtime).
 */
export interface SessionSetupContext {
	metadataStore: MetadataStore;
	cwd: string;
	fallbackModel?: Model;
	modelResolver: ModelResolver;
	/** The parent's ModelRegistry, so the child shares auth state and providers. */
	modelRegistry?: any;
	/**
	 * Create and reload a ResourceLoader configured for the given agent.
	 * The implementation captures any parent-runtime state needed.
	 */
	createResourceLoader(agent: AgentConfig): Promise<DefaultResourceLoader>;
}

// ---------------------------------------------------------------------------
// SubagentSessionManager
// ---------------------------------------------------------------------------

export class SubagentSessionManager {
	private openSessions = new Map<string, AgentSession>();
	private runLocks = new Map<string, Promise<void>>();
	private completedSessions = new Set<string>();
	private asyncResults = new Map<string, { output: string; error?: string; warnings: string[] }>();
	private asyncInFlight = new Set<string>();
	private killInProgress = new Set<string>();
	private _onAsyncAgentEnd: ((id: string) => void) | undefined;

	constructor(
		private sessionManagerProvider: SessionManagerProvider,
		private agentSessionFactory: AgentSessionFactory,
	) {}

	// ---- Async agent end callback ----

	/**
	 * Register a callback invoked when a session marked async-in-flight
	 * reaches `agent_end`. Called before the result is stored via
	 * `storeAsyncResult`.
	 */
	setOnAsyncAgentEnd(cb: ((id: string) => void) | undefined): void {
		this._onAsyncAgentEnd = cb;
	}

	// ---- Session tracking ----

	/** Retrieve an open session by record ID, or undefined. */
	getOpenSession(id: string): AgentSession | undefined {
		return this.openSessions.get(id);
	}

	/** Check if a session is currently open for the given record ID. */
	hasOpenSession(id: string): boolean {
		return this.openSessions.has(id);
	}

	/**
	 * Register an existing session in the open-sessions map.
	 * Primarily for tests; production code uses getOrCreateSession().
	 */
	trackSession(id: string, session: AgentSession): void {
		this.openSessions.set(id, session);
	}

	// ---- Session lifecycle ----

	/**
	 * Get an existing session or create a new one with the full lifecycle.
	 *
	 * Lifecycle per create:
	 * 1. Create resource loader via adapter
	 * 2. Open or create Pi session manager (file on disk)
	 * 3. Set record.sessionFile and persist via MetadataStore
	 * 4. Resolve model (emits warnings for missing / unauth'd models)
	 * 5. Create AgentSession via factory
	 * 6. Check tool availability (emits warnings for missing tools)
	 * 7. Subscribe to agent_end → updates record.updatedAt in MetadataStore
	 * 8. Wrap session.dispose to unsubscribe first
	 *
	 * If a session for `record.id` is already tracked it is returned
	 * immediately (the setup context is ignored).
	 */
	async getOrCreateSession(
		record: SubagentRecord,
		agent: AgentConfig,
		warnings: string[],
		context: SessionSetupContext,
	): Promise<AgentSession> {
		const existing = this.openSessions.get(record.id);
		if (existing) return existing;

		const { metadataStore, cwd, fallbackModel, modelResolver, modelRegistry } = context;

		// 1. Create resource loader
		const resourceLoader = await context.createResourceLoader(agent);

		// 2. Open or create Pi session manager
		const sessionDir = metadataStore.ctx.sessionDir;
		const piSessionManager = this.sessionManagerProvider.openOrCreate(
			record.sessionFile,
			sessionDir,
			cwd,
		);

		// 3. Persist session file back to the record
		record.sessionFile = piSessionManager.getSessionFile() ?? record.sessionFile;
		metadataStore.upsertRecord(record);

		// 4. Resolve model
		const model = modelResolver.resolve(agent.model, fallbackModel, warnings);

		// 5. Create agent session (pass parent's modelRegistry for shared auth)
		const session = await this.agentSessionFactory.create({
			cwd,
			model,
			tools: agent.tools,
			resourceLoader,
			sessionManager: piSessionManager,
			thinkingLevel: agent.reasoningEffort as ThinkingLevel | undefined,
			modelRegistry,
		});

		// 6. Check tool availability
		if (agent.tools) {
			const active = new Set(session.getActiveToolNames());
			for (const tool of agent.tools) {
				if (!active.has(tool)) {
					warnings.push(`Configured tool "${tool}" is not available for ${agent.name}.`);
				}
			}
		}

		// 7. Subscribe to agent_end to update metadata timestamp and mark completion.
		//    When the session was spawned asynchronously also notify the callback.
		const unsubscribe = session.subscribe((event: any) => {
			if (event.type === "agent_end") {
				record.updatedAt = new Date().toISOString();
				metadataStore.upsertRecord(record);
				this.completedSessions.add(record.id);
				if (this.asyncInFlight.has(record.id)) {
					this._onAsyncAgentEnd?.(record.id);
				}
			}
		});

		// 8. Wrap dispose to unsubscribe first
		const originalDispose = session.dispose.bind(session);
		session.dispose = () => {
			unsubscribe();
			originalDispose();
		};

		this.openSessions.set(record.id, session);
		return session;
	}

	/**
	 * Dispose a single session by record ID and remove it from tracking.
	 * No-op if the ID is not tracked. The wrapped dispose handles
	 * unsubscribe before the real disposal.
	 */
	disposeSession(id: string): void {
		const session = this.openSessions.get(id);
		if (session) {
			session.dispose();
			this.openSessions.delete(id);
		}
		this.completedSessions.delete(id);
		this.asyncInFlight.delete(id);
	}

	/**
	 * Dispose all tracked sessions and clear the map.
	 * Safe to call multiple times; does not throw if a session is
	 * already disposed.
	 */
	disposeAll(): void {
		for (const [, session] of this.openSessions) {
			try {
				session.dispose();
			} catch {
				// Ignore errors from already-disposed sessions.
			}
		}
		this.openSessions.clear();
		this.completedSessions.clear();
		this.asyncResults.clear();
		this.asyncInFlight.clear();
	}

	// ---- Async completion ----

	/**
	 * Wait for a tracked session to reach `agent_end`.
	 * Resolves immediately if the session already ended or is no longer tracked.
	 */
	async waitForSessionEnd(id: string): Promise<void> {
		if (this.completedSessions.has(id)) return;

		const session = this.openSessions.get(id);
		if (!session) return;

		return new Promise<void>((resolve) => {
			const unsubscribe = session.subscribe((event: any) => {
				if (event.type === "agent_end") {
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/** Store the output/error of a completed async sub-agent session. */
	storeAsyncResult(id: string, result: { output: string; error?: string; warnings: string[] }): void {
		this.asyncResults.set(id, result);
	}

	/** Retrieve the stored output/error from a completed async sub-agent. */
	getAsyncResult(id: string): { output: string; error?: string; warnings: string[] } | undefined {
		return this.asyncResults.get(id);
	}

	/** Mark a session ID as having an in-flight async prompt. */
	markAsyncRunning(id: string): void {
		this.asyncInFlight.add(id);
	}

	/** Clear the in-flight marker for a session ID. */
	clearAsyncRunning(id: string): void {
		this.asyncInFlight.delete(id);
	}

	/** Clear a consumed async result from memory. */
	clearAsyncResult(id: string): void {
		this.asyncResults.delete(id);
	}

	/** Check whether a session has an in-flight async prompt. */
	isAsyncRunning(id: string): boolean {
		return this.asyncInFlight.has(id);
	}

	/** Check whether a tracked session has already reached agent_end. */
	isCompleted(id: string): boolean {
		return this.completedSessions.has(id);
	}

	// ---- Kill / abort ----

	/**
	 * Check whether a soft-kill is in progress for the given session ID.
	 * Used by the async finish handler to avoid disposing a session that
	 * the kill flow still needs.
	 */
	isKillInProgress(id: string): boolean {
		return this.killInProgress.has(id);
	}

	/**
	 * Send a soft-kill instruction to a running async session.
	 *
	 * Marks kill-in-progress before aborting the original prompt so that
	 * the async finish handler skips disposal. After abort, sends a kill
	 * message as a new prompt giving the agent one more turn.
	 *
	 * On completion (success or failure): clears kill-in-progress, stores
	 * the final result using shared extraction, marks completed, clears
	 * async-running, and disposes the session.
	 */
	sendKillMessage(id: string, timeoutMinutes: number): void {
		const session = this.openSessions.get(id);
		if (!session) return;

		const killMessage = `[System] The parent agent requires you to finish within ${timeoutMinutes} minute(s). Please produce your final answer now.`;

		// Clear async-in-flight before aborting so onAsyncAgentEnd callbacks do
		// not treat the soft-kill prompt handoff as regular completion.
		this.clearAsyncRunning(id);

		// Mark kill-in-progress BEFORE abort so the original finish() skips disposal.
		this.killInProgress.add(id);

		// Abort the current prompt — the original error handler fires and stores
		// partial output via storeAsyncResult, but finish() skips disposeSession
		// because killInProgress is set.
		try { session.abort(); } catch { /* best-effort */ }

		// Give the agent one last turn with the kill instruction.
		session.prompt(killMessage).then(
			() => {
				// Agent finished successfully — store fresh output.
				const extracted = extractOutput(session.messages as any[]);
				this.asyncResults.set(id, { output: extracted.text, warnings: [] });
				this._cleanupAfterKill(id, session);
			},
			(error: any) => {
				// Kill prompt crashed — store error + partial output.
				const message = error instanceof Error ? error.message : String(error);
				const extracted = extractOutput(session.messages as any[], message || undefined);
				this.asyncResults.set(id, {
					output: extracted.text,
					error: message || 'The sub-agent stopped without producing any output.',
					warnings: [],
				});
				this._cleanupAfterKill(id, session);
			},
		);
	}

	/**
	 * Hard-abort a session immediately.
	 *
	 * Marks kill-in-progress before aborting so the original async reject
	 * handler doesn't interfere. Extracts best available transcript content
	 * via shared extraction, stores the result as async output with killed
	 * status, marks the session completed, and disposes it. The transcript
	 * file persists on disk for later resume.
	 */
	abortSession(id: string): void {
		const session = this.openSessions.get(id);
		if (!session) return;

		// Mark kill-in-progress to prevent the original async reject handler
		// from storing a competing result or disposing the session.
		this.killInProgress.add(id);

		// Capture partial output before abort using shared extraction.
		const extracted = extractOutput(session.messages as any[], 'killed');

		try { session.abort(); } catch { /* best-effort */ }

		// Store partial output (or error) so wait_for_agent can return it.
		this.asyncResults.set(id, {
			output: extracted.text || '',
			error: 'killed',
			warnings: [],
		});

		// Clean up: mark completed, clear run flags, dispose session.
		// Defer killInProgress cleanup so the microtask'd reject handler
		// still sees it and skips storing a competing result.
		this.completedSessions.add(id);
		this.asyncInFlight.delete(id);
		try { session.dispose(); } catch { /* best-effort */ }
		this.openSessions.delete(id);
		queueMicrotask(() => this.killInProgress.delete(id));
	}

	/**
	 * Shared cleanup after a soft-kill prompt finishes (success or failure).
	 */
	private _cleanupAfterKill(id: string, session: AgentSession): void {
		this.completedSessions.add(id);
		this.killInProgress.delete(id);
		this.asyncInFlight.delete(id);
		try { session.dispose(); } catch { /* best-effort */ }
		this.openSessions.delete(id);
	}

	// ---- Run serialization ----

	/**
	 * Serialize execution for a given record ID via a promise-based lock.
	 *
	 * Ensures concurrent Task calls for the same sub-agent never interleave.
	 * The lock is cleared after the function resolves (or rejects).
	 */
	async withRecordRunLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.runLocks.get(id) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.catch(() => undefined).then(() => current);
		this.runLocks.set(id, tail);
		await previous.catch(() => undefined);
		try {
			return await fn();
		} finally {
			release();
			if (this.runLocks.get(id) === tail) {
				this.runLocks.delete(id);
			}
		}
	}
}
