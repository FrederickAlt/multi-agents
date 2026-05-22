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

	constructor(
		private sessionManagerProvider: SessionManagerProvider,
		private agentSessionFactory: AgentSessionFactory,
	) {}

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

		// 7. Subscribe to agent_end to update metadata timestamp
		const unsubscribe = session.subscribe((event: any) => {
			if (event.type === "agent_end") {
				record.updatedAt = new Date().toISOString();
				metadataStore.upsertRecord(record);
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
