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
import { makeNoopDebugLogger, type DebugLogger } from "./debug-logger.js";

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

		const all: Model[] =
			typeof this.modelRegistry.getAll === "function"
				? this.modelRegistry.getAll()
				: [];

		const hasAuth = (m: Model): boolean => {
			if (typeof this.modelRegistry.hasConfiguredAuth !== "function") return true;
			return this.modelRegistry.hasConfiguredAuth(m);
		};

		// ---- Step 1: Exact match by model ID ----
		// Handles both bare IDs and slash-containing model IDs.
		const exactById = all.filter((c: Model) => c.id === modelName);

		if (exactById.length === 1) {
			const model = exactById[0];
			if (!hasAuth(model)) {
				warnings.push(
					`Configured model "${modelName}" is not available because its provider is not authenticated; using the current/default model.`,
				);
				return fallback;
			}
			return model;
		}

		if (exactById.length > 1) {
			// Ambiguous bare model ID — matches multiple providers.
			warnings.push(
				`Configured model "${modelName}" is ambiguous (matches multiple providers); using the current/default model.`,
			);
			return fallback;
		}

		// ---- Step 2: Canonical provider/model-id reference ----
		// Only reached when no exact model-ID match exists.
		if (modelName.includes("/")) {
			// Split on first / only to preserve slash-containing model IDs.
			const slashIdx = modelName.indexOf("/");
			const provider = modelName.slice(0, slashIdx);
			const id = modelName.slice(slashIdx + 1);
			const model = this.modelRegistry.find(provider, id);
			if (model) {
				if (!hasAuth(model)) {
					warnings.push(
						`Configured model "${modelName}" is not available because its provider is not authenticated; using the current/default model.`,
					);
					return fallback;
				}
				return model;
			}
		}

		// ---- Step 3: No match ----
		warnings.push(
			`Configured model "${modelName}" was not found; using the current/default model.`,
		);
		return fallback;
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
	private asyncResults = new Map<string, { output: string; error?: string; warnings: string[]; abortReason?: string }>();
	private asyncResultWaiters = new Map<string, Set<() => void>>();
	private asyncInFlight = new Set<string>();
	private killInProgress = new Set<string>();
	private asyncRunLifecycle = new Map<string, "running" | "soft-killing" | "hard-aborting" | "completed">();
	private _onAsyncResultReady: ((id: string) => void) | undefined;
	private readonly logger: DebugLogger;

	constructor(
		private sessionManagerProvider: SessionManagerProvider,
		private agentSessionFactory: AgentSessionFactory,
		logger?: DebugLogger,
	) {
		this.logger = logger ?? makeNoopDebugLogger();
	}

	// ---- Async result-ready callback ----

	/** Register a callback invoked after an async result has been stored. */
	setOnAsyncResultReady(cb: ((id: string) => void) | undefined): void {
		this._onAsyncResultReady = cb;
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
		const sessionLogger = this.logger.child({ component: "subagent_session_manager", recordId: record.id, agentType: agent?.name });
		const existing = this.openSessions.get(record.id);
		if (existing) {
			sessionLogger.debug("session_reused", { hasOpenSession: true });
			return existing;
		}

		const { metadataStore, cwd, fallbackModel, modelResolver, modelRegistry } = context;
		sessionLogger.info("session_create_start", {
			cwdLength: cwd.length,
			recordDepth: record.depth,
		});

		// 1. Create resource loader
		let resourceLoader: DefaultResourceLoader;
		try {
			resourceLoader = await context.createResourceLoader(agent);
			sessionLogger.info("session_resource_loader_created", {
				cwdLength: cwd.length,
				agentType: agent.name,
			});
		} catch (error) {
			sessionLogger.error("session_resource_loader_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}

		// 2. Open or create Pi session manager
		const sessionDir = metadataStore.ctx.sessionDir;
		sessionLogger.debug("session_manager_open", { sessionDir, existingFile: !!record.sessionFile });
		const piSessionManager = this.sessionManagerProvider.openOrCreate(
			record.sessionFile,
			sessionDir,
			cwd,
		);

		// 3. Persist session file back to the record
		record.sessionFile = piSessionManager.getSessionFile() ?? record.sessionFile;
		metadataStore.upsertRecord(record);
		sessionLogger.debug("session_file_persisted", { sessionFile: record.sessionFile });

		// 4. Resolve model
		const model = modelResolver.resolve(agent.model, fallbackModel, warnings);
		sessionLogger.debug("session_model_resolved", { modelHint: model?.id || model?.provider || "default" });

		// 5. Create agent session (pass parent's modelRegistry for shared auth)
		let session: AgentSession;
		try {
			session = await this.agentSessionFactory.create({
				cwd,
				model,
				tools: agent.tools,
				resourceLoader,
				sessionManager: piSessionManager,
				thinkingLevel: agent.reasoningEffort as ThinkingLevel | undefined,
				modelRegistry,
			});
		} catch (error) {
			sessionLogger.error("session_create_failed", { error: error instanceof Error ? error.message : String(error) });
			throw error;
		}
		sessionLogger.info("session_created", { sessionFile: record.sessionFile, hasTools: !!agent.tools });

		// 6. Check tool availability
		if (agent.tools) {
			const active = new Set(session.getActiveToolNames());
			let missing = 0;
			for (const tool of agent.tools) {
				if (!active.has(tool)) {
					warnings.push(`Configured tool "${tool}" is not available for ${agent.name}.`);
					missing += 1;
				}
			}
			sessionLogger.debug("session_tools_checked", { requestedTools: agent.tools.length, availableTools: active.size, missingTools: missing });
		}

		// 7. Subscribe to agent_end to update metadata timestamp and mark session completion.
		const unsubscribe = session.subscribe((event: any) => {
			if (event.type === "agent_end") {
				record.updatedAt = new Date().toISOString();
				metadataStore.upsertRecord(record);
				this.completedSessions.add(record.id);
				sessionLogger.info("session_agent_end_observed", { recordId: record.id, updatedAt: record.updatedAt });
			}
		});

		// 8. Wrap dispose to unsubscribe first
		const originalDispose = session.dispose.bind(session);
		session.dispose = () => {
			unsubscribe();
			originalDispose();
		};

		this.openSessions.set(record.id, session);
		sessionLogger.info("session_create_done", {
			openSessions: this.openSessions.size,
		});
		return session;
	}

	/**
	 * Dispose a single session by record ID and remove it from tracking.
	 * No-op if the ID is not tracked. The wrapped dispose handles
	 * unsubscribe before the real disposal.
	 */
	disposeSession(id: string): void {
		const session = this.openSessions.get(id);
		const logger = this.logger.child({ component: "subagent_session_manager", recordId: id });
		if (session) {
			logger.debug("session_dispose_start", { hasOpenSession: true });
			try {
				session.dispose();
			} catch (error) {
				logger.warn("session_dispose_error", { error: error instanceof Error ? error.message : String(error) });
			}
			this.openSessions.delete(id);
		} else {
			logger.debug("session_dispose_noop", { hasOpenSession: false });
		}
		this.completedSessions.delete(id);
		this.asyncInFlight.delete(id);
		this.asyncRunLifecycle.delete(id);
		logger.debug("session_dispose_complete");
	}

	/**
	 * Dispose all tracked sessions and clear the map.
	 * Safe to call multiple times; does not throw if a session is
	 * already disposed.
	 */
	disposeAll(): void {
		const logger = this.logger.child({ component: "subagent_session_manager" });
		logger.info("session_dispose_all_start", { count: this.openSessions.size });
		for (const [, session] of this.openSessions) {
			try {
				session.dispose();
			} catch (error) {
				logger.warn("session_dispose_error", { error: error instanceof Error ? error.message : String(error) });
				// Ignore errors from already-disposed sessions.
			}
		}
		this.openSessions.clear();
		this.completedSessions.clear();
		this.asyncResults.clear();
		this.asyncResultWaiters.clear();
		this.asyncInFlight.clear();
		this.asyncRunLifecycle.clear();
		logger.info("session_dispose_all_done", { count: this.openSessions.size });
	}

	// ---- Async completion ----

	/**
	 * Wait for a tracked session to reach `agent_end`.
	 * Resolves immediately if the session already ended or is no longer tracked.
	 */
	async waitForSessionEnd(id: string): Promise<void> {
		if (this.completedSessions.has(id)) {
			this.logger.debug("session_wait_complete_immediate", { id });
			return;
		}

		const session = this.openSessions.get(id);
		if (!session) {
			this.logger.debug("session_wait_no_session", { id });
			return;
		}

		const waitLogger = this.logger.child({ component: "subagent_session_manager", recordId: id });
		waitLogger.debug("session_wait_start");
		return new Promise<void>((resolve) => {
			const unsubscribe = session.subscribe((event: any) => {
				if (event.type === "agent_end") {
					unsubscribe();
					waitLogger.debug("session_wait_complete", { id });
					resolve();
				}
			});
		});
	}

	/** Store the output/error of a completed async sub-agent session. */
	storeAsyncResult(id: string, result: { output: string; error?: string; warnings: string[]; abortReason?: string }): void {
		this.logger.debug("session_async_result_stored", {
			recordId: id,
			outputLength: result.output.length,
			hasError: Boolean(result.error),
		});
		this.asyncResults.set(id, result);
		const waiters = this.asyncResultWaiters.get(id);
		if (waiters) {
			this.asyncResultWaiters.delete(id);
			for (const resolve of waiters) resolve();
		}
		this._onAsyncResultReady?.(id);
	}

	/** Retrieve the stored output/error from a completed async sub-agent. */
	getAsyncResult(id: string): { output: string; error?: string; warnings: string[]; abortReason?: string } | undefined {
		return this.asyncResults.get(id);
	}

	/** Wait until a completed async sub-agent result has been stored. */
	async waitForAsyncResult(id: string, signal?: AbortSignal): Promise<void> {
		if (this.asyncResults.has(id)) {
			this.logger.debug("session_wait_async_result_immediate", { recordId: id });
			return;
		}
		this.logger.debug("session_wait_async_result", { recordId: id, hasSignal: Boolean(signal) });
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			let resolveWaiter: () => void = () => {};
			let onAbort: () => void = () => {};
			const cleanup = () => {
				signal?.removeEventListener("abort", onAbort);
				const waiters = this.asyncResultWaiters.get(id);
				if (waiters) {
					waiters.delete(resolveWaiter);
					if (waiters.size === 0) this.asyncResultWaiters.delete(id);
				}
			};
			resolveWaiter = () => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve();
			};
			onAbort = () => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new Error("wait_for_async_result_cancelled"));
			};

			if (signal?.aborted) {
				onAbort();
				return;
			}

			let waiters = this.asyncResultWaiters.get(id);
			if (!waiters) {
				waiters = new Set();
				this.asyncResultWaiters.set(id, waiters);
			}
			waiters.add(resolveWaiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/**
	 * Mark async lifecycle result ownership and trigger durable cleanup.
	 *
	 * This keeps completion, result storage, state transitions, and
	 * session disposal in one place instead of callers.
	 */
	finalizeAsyncRun(
		id: string,
		result: { output: string; error?: string; warnings: string[]; abortReason?: string },
		options?: { allowOverwrite?: boolean },
	): void {
		this._finalizeAsyncRun(id, result, {
			allowOverwrite: options?.allowOverwrite,
		});
	}

	/** Mark a session ID as having an in-flight async prompt. */
	markAsyncRunning(id: string): void {
		this.logger.debug("session_async_mark_running", { recordId: id });
		this.asyncInFlight.add(id);
		this.asyncRunLifecycle.set(id, "running");
	}

	/** Clear the in-flight marker for a session ID. */
	clearAsyncRunning(id: string): void {
		this.logger.debug("session_async_clear_running", { recordId: id });
		this.asyncInFlight.delete(id);
		if (this.asyncRunLifecycle.get(id) === "running") {
			this.asyncRunLifecycle.delete(id);
		}
	}

	/** Clear a consumed async result from memory. */
	clearAsyncResult(id: string): void {
		this.logger.debug("session_async_result_cleared", { recordId: id });
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

	private _runLifecycleState(id: string): "running" | "soft-killing" | "hard-aborting" | "completed" | undefined {
		return this.asyncRunLifecycle.get(id);
	}

	private _shouldStoreRunResult(id: string, options: { allowOverwrite?: boolean; source?: "task-controller" | "soft-kill" | "hard-abort" } = {}): boolean {
		const state = this._runLifecycleState(id);
		if (state === "completed") return false;
		if (!options.allowOverwrite && this.killInProgress.has(id)) return false;
		if (!options.allowOverwrite && (state === "soft-killing" || state === "hard-aborting")) {
			return false;
		}
		if (options.allowOverwrite && state === "hard-aborting" && options.source !== "hard-abort") {
			return false;
		}
		if (!options.allowOverwrite && this.asyncResults.has(id)) {
			return false;
		}
		return true;
	}

	private _startSoftKill(id: string): boolean {
		const state = this._runLifecycleState(id);
		if (state === "completed" || state === "hard-aborting") return false;
		this.asyncRunLifecycle.set(id, "soft-killing");
		this.killInProgress.add(id);
		this.clearAsyncRunning(id);
		return true;
	}

	private _startHardAbort(id: string): boolean {
		const state = this._runLifecycleState(id);
		if (state === "completed") return false;
		this.asyncRunLifecycle.set(id, "hard-aborting");
		this.killInProgress.add(id);
		this.clearAsyncRunning(id);
		return true;
	}

	private _finalizeAsyncRun(
		id: string,
		result: { output: string; error?: string; warnings: string[]; abortReason?: string },
		options: { allowOverwrite?: boolean; source?: "task-controller" | "soft-kill" | "hard-abort" } = {},
	): void {
		this.asyncInFlight.delete(id);

		if (!this._shouldStoreRunResult(id, options)) {
			this.logger.debug("session_finalize_skipped", {
				recordId: id,
				state: this.asyncRunLifecycle.get(id),
				hasResult: this.asyncResults.has(id),
				source: options.source,
			});
			if (this.asyncRunLifecycle.get(id) === "running") {
				this.asyncRunLifecycle.delete(id);
			}
			return;
		}

		this.logger.debug("session_finalize", {
			recordId: id,
			source: options.source,
			outputLength: result.output.length,
			hasError: Boolean(result.error),
			allowOverwrite: options.allowOverwrite,
		});
		this.storeAsyncResult(id, result);
		this.completedSessions.add(id);
		this.asyncRunLifecycle.set(id, "completed");
		this.killInProgress.delete(id);
		const session = this.openSessions.get(id);
		if (session) {
			try {
				session.dispose();
			} catch (error) {
				this.logger.warn("session_finalize_dispose_error", {
					recordId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				this.openSessions.delete(id);
			}
		}
	}

	// ---- Kill / abort ----

	/**
	 * Check whether a kill flow (soft-kill or hard-abort) is currently in progress
	 * for the given session ID. Used by the async finish handler to avoid
	 * overwriting the lifecycle-owned result.
	 */
	isKillInProgress(id: string): boolean {
		return this.killInProgress.has(id);
	}

	sendKillMessage(id: string, timeoutMinutes: number): void {
		const session = this.openSessions.get(id);
		if (!session || this.asyncResults.has(id)) {
			if (!session) {
				this.logger.debug("session_send_kill_missing", { recordId: id });
			}
			if (this.asyncResults.has(id)) {
				this.logger.debug("session_send_kill_ignored_already_completed", { recordId: id });
			}
			return;
		}

		const logger = this.logger.child({ component: "subagent_session_manager", recordId: id });
		const killMessage = `[System] The parent agent requires you to finish within ${timeoutMinutes} minute(s). Please produce your final answer now.`;

		if (!this._startSoftKill(id)) {
			logger.debug("session_send_kill_not_started", { state: this._runLifecycleState(id) });
			return;
		}

		logger.info("session_send_kill_started", { timeoutMinutes });

		// Abort the current prompt; the original async handler observes
		// kill flow state and leaves result ownership to this kill flow.
		try { session.abort(); } catch { /* best-effort */ }

		// Give the agent one last turn with the kill instruction.
		session.prompt(killMessage).then(
			() => {
				// Agent finished successfully — store fresh output.
				const extracted = extractOutput(session.messages as any[]);
				logger.debug("session_send_kill_prompt_completed", { outputLength: extracted.text.length });
				this._finalizeAsyncRun(id, { output: extracted.text, warnings: [] }, { allowOverwrite: true, source: "soft-kill" });
			},
			(error: any) => {
				// Kill prompt crashed — store error + partial output.
				const message = error instanceof Error ? error.message : String(error);
				const extracted = extractOutput(session.messages as any[], message || undefined);
				logger.warn("session_send_kill_prompt_failed", { error: message });
				this._finalizeAsyncRun(
					id,
					{
						output: extracted.text,
						error: message || "The sub-agent stopped without producing any output.",
						warnings: [],
					},
					{ allowOverwrite: true, source: "soft-kill" },
				);
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
		if (!session) {
			this.logger.debug("session_hard_abort_missing", { recordId: id });
			return;
		}

		if (!this._startHardAbort(id)) {
			this.logger.debug("session_hard_abort_not_started", { recordId: id, state: this._runLifecycleState(id) });
			return;
		}

		this.logger.warn("session_hard_abort_started", { recordId: id });

		// Capture partial output before abort using shared extraction.
		const extracted = extractOutput(session.messages as any[], "killed");

		try { session.abort(); } catch { /* best-effort */ }

		this._finalizeAsyncRun(
			id,
			{
				output: extracted.text || "",
				error: "killed",
				warnings: [],
			},
			{ allowOverwrite: true, source: "hard-abort" },
		);
	}

	// ---- Run serialization ----

	/**
	 * Serialize execution for a given record ID via a promise-based lock.
	 *
	 * Ensures concurrent Task calls for the same sub-agent never interleave.
	 * The lock is cleared after the function resolves (or rejects).
	 */
	async withRecordRunLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
		this.logger.debug("session_run_lock_acquired", { recordId: id, hasQueued: this.runLocks.has(id) });
		const previous = this.runLocks.get(id) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.catch(() => undefined).then(() => current);
		this.runLocks.set(id, tail);
		await previous.catch(() => undefined);
		try {
			this.logger.debug("session_run_lock_enter", { recordId: id });
			return await fn();
		} finally {
			release();
			if (this.runLocks.get(id) === tail) {
				this.runLocks.delete(id);
			}
			this.logger.debug("session_run_lock_release", { recordId: id });
		}
	}
}
