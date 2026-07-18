/**
 * TaskController — orchestrates a single Task (sub-agent) execution.
 *
 * Responsibilities:
 * - Agent discovery and validation (via AgentDiscoveryAdapter)
 * - Spawn permission checks (depth, can_spawn allowlist)
 * - Record allocation (via MetadataAdapter)
 * - Session lifecycle (via SessionAdapter)
 * - Prompt execution and result formatting
 * - Error handling (returns structured error results, never throws)
 *
 * The class is stateless; all runtime dependencies are injected via
 * adapter interfaces in TaskExecuteContext.
 */

import { readFileSync } from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentDiagnostic, AgentMode } from "./agents.js";
import { formatAgentList, resolveAgentMode } from "./agents.js";
import { formatContextUsageLine, readSubagentContextUsage, type SubagentContextUsage } from "./context-usage.js";
import { createRunCorrelationId, makeNoopDebugLogger } from "./debug-logger.js";
import { checkTaskAllowed, childPolicy, type DepthPolicyState } from "./depth-policy.js";
import type { MetadataFile, MetadataStore, SubagentRecord, TerminalOutcome } from "./metadata.js";
import {
	extractOutput,
	extractTerminalOutput,
	FINAL_RESPONSE_REQUIRED_MAX_ATTEMPTS,
	FINAL_RESPONSE_REQUIRED_MESSAGE,
	getTerminalDiagnosticFromMessages,
} from "./output-extraction.js";
import type {
	AbortSummaryResult,
	AsyncRunResult,
	ModelResolver,
	ResolvedModel,
	SessionSetupContext,
} from "./session-manager.js";

/**
 * Default maximum runtime for a Task sub-agent execution, in minutes.
 *
 * Keep this as a production default-only value unless a use-case clearly
 * requires configurability; the Task tool remains intentionally simple.
 */
export const DEFAULT_TASK_RUNTIME_TIMEOUT_MINUTES = 30;

/**
 * Default Task sub-agent runtime timeout in milliseconds.
 */
export const DEFAULT_TASK_RUNTIME_TIMEOUT_MS = DEFAULT_TASK_RUNTIME_TIMEOUT_MINUTES * 60 * 1000;

export const TASK_RUNTIME_TIMEOUT_ERROR_CODE = "execution_timeout";

// ---------------------------------------------------------------------------
// Adapter interfaces (injectable, testable without concrete classes)
// ---------------------------------------------------------------------------

/** What the controller needs from agent discovery. */
export interface AgentDiscoveryAdapter {
	discover(): {
		agents: AgentConfig[];
		diagnostics: readonly AgentDiagnostic[];
	};
}

/** What the controller (and SessionSetupContext) needs from the metadata store. */
export interface MetadataAdapter {
	load(): MetadataFile;
	allocateRecord(agentName: string, parentAgentId?: string, depth?: number): Promise<SubagentRecord>;
	findRecord(id: string): SubagentRecord | undefined;
	touchRecord(id: string): void;
	/** Required by session manager for session directory resolution. */
	readonly ctx: { sessionDir: string };
	/** Persist an update to a record (required by session manager). */
	upsertRecord(record: SubagentRecord): void;
}

/** What the controller needs from the session manager. */
export interface SessionAdapter {
	getOrCreateSession(
		record: SubagentRecord,
		agent: AgentConfig,
		warnings: string[],
		context: SessionSetupContext,
	): Promise<any>;
	withRecordRunLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
	disposeSession(id: string): Promise<void>;
	/**
	 * Wait for a tracked session to reach `agent_end`, resolving when the
	 * agent finishes. Resolves immediately if the session already ended
	 * or is no longer tracked.
	 */
	waitForSessionEnd(id: string, signal?: AbortSignal): Promise<void>;
	/** Store the output/error result of a completed async session. */
	storeAsyncResult(id: string, result: AsyncRunResult): void;
	/** Finalize async completion and apply lifecycle transitions and cleanup. */
	finalizeAsyncRun(id: string, result: AsyncRunResult, options?: { allowOverwrite?: boolean }): void;
	/** Retrieve a previously stored async result. */
	getAsyncResult(id: string): AsyncRunResult | undefined;
	/** Wait until a completed async session result has been stored. */
	waitForAsyncResult(id: string, signal?: AbortSignal): Promise<void>;
	/** Clear a consumed async result from memory. */
	clearAsyncResult(id: string): void;
	/** Mark a session as having an in-flight async prompt. */
	markAsyncRunning(id: string): void;
	clearAsyncRunning?(id: string): void;
	/** Check whether a session has an in-flight async prompt. */
	isAsyncRunning(id: string): boolean;
	/** Check whether a tracked session has already reached agent_end. */
	isCompleted(id: string): boolean;
	/** Check if there is an open session for the given record ID. */
	hasOpenSession(id: string): boolean;
	/**
	 * Request that a running async session produce a final answer.
	 */
	sendKillMessage(id: string, timeoutMinutes: number): void;
	/**
	 * Request a bounded no-tools final summary before forced abort.
	 */
	requestAbortSummary?(
		id: string,
		timeoutOrSignal?: number | AbortSignal,
		signal?: AbortSignal,
	): Promise<AbortSummaryResult>;
	/**
	 * Forcibly abort a session immediately.
	 * The transcript persists on disk for later resume.
	 */
	abortSession(id: string): void;
	/**
	 * Check whether a finish request or forced abort is in progress for the given session ID.
	 */
	isKillInProgress(id: string): boolean;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters the LLM passes when invoking the Task tool. */
export interface TaskExecuteParams {
	description: string;
	prompt: string;
	subagent_type: string;
	resume?: string;
	cwd?: string;
	/** Optional execution mode. Omitted values use fast mode. */
	mode?: AgentMode;
	/** When false, spawns the sub-agent and returns immediately with agent details. Default true. */
	blocking?: boolean;
}

/** Typed subset of the parent runtime state needed by the TaskController. */
export interface RuntimeContext {
	parentAgentId?: string;
	/** Current position in the agent tree (Root = 0, child = 1, …). */
	treeDepth: number;
	/** Spawn-policy state for the current agent. */
	depthPolicy: DepthPolicyState;
	store?: MetadataAdapter;
	logger?: import("./debug-logger.js").DebugLogger;
}

/**
 * All runtime dependencies injected into TaskController.execute().
 *
 * Adapts concrete Pi platform classes through narrow interfaces so
 * the controller can be tested with fakes.
 */
export interface TaskExecuteContext {
	cwd: string;
	signal?: AbortSignal;
	runtime: RuntimeContext;
	agentDiscovery: AgentDiscoveryAdapter;
	metadataStore: MetadataAdapter;
	sessionManager: SessionAdapter;
	modelResolver: ModelResolver;
	fallbackModel?: ResolvedModel;
	modelRegistry?: any;
	createResourceLoaderFactory: (
		agent: AgentConfig,
		childRuntime: RuntimeContext,
		effectiveCwd: string,
		onWarnings?: (warnings: string[]) => void,
	) => Promise<DefaultResourceLoader | TaskResourceLoaderSetup>;
	/** Optional streaming update callback (used for progress emission). */
	onUpdate?: (partial: TaskResult) => void;
	/**
	 * Optional callback to consume terminal wait_for_agent IDs (completed / aborted)
	 * from external notification tracking systems.
	 */
	consumeWaitForAgentIds?: (agentIds: string[]) => void;
}

/** A child loader plus the Pi settings object that decided its project trust. */
export interface TaskResourceLoaderSetup {
	resourceLoader: DefaultResourceLoader;
	settingsManager: SettingsManager;
}

/** Status of a single agent within a wait_for_agent result. */
export type AgentWaitStatus = "completed" | "running" | "timed_out_still_running" | "killed" | "unknown";

/** Internal run-state used to classify Agent runs consistently for Task and wait_for_agent. */
type AgentRunState =
	| "result_ready_memory"
	| "result_ready_transcript"
	| "running_async"
	| "running_open"
	| "killed"
	| "unknown";

interface AgentRunSnapshot {
	id: string;
	displayName?: string;
	agentType?: string;
	sessionFile?: string;
	state: AgentRunState;
	output?: string;
	error?: string;
	abortReason?: string;
	terminalOutcome?: TerminalOutcome;
	terminalError?: string;
	terminalAt?: string;
	contextUsage?: SubagentContextUsage;
	warnings?: string[];
}

/** Per-agent structured result returned by waitForAgent. */
export interface AgentWaitResult {
	id: string;
	displayName?: string;
	agentType?: string;
	status: AgentWaitStatus;
	output?: string;
	error?: string;
	abortReason?: string;
	terminalOutcome?: TerminalOutcome;
	terminalError?: string;
	terminalAt?: string;
	contextUsage?: SubagentContextUsage;
	warnings?: string[];
	sessionFile?: string;
}

/** Per-execution metadata about a Task result. */
export interface TaskDetails {
	id?: string;
	displayName?: string;
	agentType?: string;
	description?: string;
	resumed?: boolean;
	sessionFile?: string;
	warnings: string[];
	error?: string;
	abortReason?: string;
	terminalOutcome?: TerminalOutcome;
	terminalError?: string;
	terminalAt?: string;
	contextUsage?: SubagentContextUsage;
	output?: string;
	/** Per-agent results from wait_for_agent (multi-agent retrieval). */
	agents?: AgentWaitResult[];
}

/** Structured result returned by TaskController.execute(). */
export type TaskResult = AgentToolResult<TaskDetails>;

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

function findAgent(agents: AgentConfig[], name: string): AgentConfig | undefined {
	return agents.find((agent) => agent.name === name);
}

function isPendingToolDiagnostic(text: string | undefined): boolean {
	return /^Last transcript activity: assistant was executing tool\b/.test(text ?? "");
}

function readSessionHeaderCwd(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	try {
		const firstLine = readFileSync(sessionFile, "utf-8").split("\n")[0];
		if (!firstLine?.trim()) return undefined;
		const header = JSON.parse(firstLine) as { type?: unknown; cwd?: unknown };
		return header.type === "session" && typeof header.cwd === "string" && header.cwd.trim() ? header.cwd : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// TaskController
// ---------------------------------------------------------------------------

export class TaskController {
	// ---- Static utility methods ----

	/**
	 * Resolve the AgentConfig (and optionally a SubagentRecord for
	 * resume) from the task parameters and metadata store.
	 */
	static resolveTaskAgent(
		params: { subagent_type: string; resume?: string },
		store: MetadataFile,
		agents: AgentConfig[],
	): { ok: true; record?: SubagentRecord; agent: AgentConfig } | { ok: false; errorText: string; errorCode: string } {
		let record: SubagentRecord | undefined;
		let agent: AgentConfig | undefined;

		if (params.resume) {
			record = store.records.find((item) => item.id === params.resume);
			if (!record) {
				const known = store.records.map((item) => `${item.id} (${item.displayName})`).join(", ") || "none";
				return {
					ok: false,
					errorText: `Unknown sub-agent ID "${params.resume}". Known agents: ${known}`,
					errorCode: "unknown_resume_id",
				};
			}
			agent = findAgent(agents, record.agentType);
			if (!agent) {
				const available = formatAgentList(agents, 30).text;
				return {
					ok: false,
					errorText: `Sub-agent "${params.resume}" (${record.displayName}) uses agent type "${record.agentType}" which is no longer available. Available: ${available}`,
					errorCode: "unknown_agent_type",
				};
			}
		} else {
			agent = findAgent(agents, params.subagent_type);
			if (!agent) {
				const available = formatAgentList(agents, 30).text;
				return {
					ok: false,
					errorText: `Unknown sub-agent type "${params.subagent_type}". Available: ${available}`,
					errorCode: "unknown_agent_type",
				};
			}
		}

		return { ok: true, record, agent };
	}

	static extractOutput = extractOutput;
	static extractTerminalOutput = extractTerminalOutput;

	private static async _ensureFinalResponse(
		session: any,
	): Promise<{ text: string; source: "assistant" | "diagnostic" | "none" }> {
		let terminal = extractTerminalOutput(session.messages as any[]);
		for (let attempt = 0; terminal.source === "none" && attempt < FINAL_RESPONSE_REQUIRED_MAX_ATTEMPTS; attempt++) {
			await session.prompt(FINAL_RESPONSE_REQUIRED_MESSAGE);
			terminal = extractTerminalOutput(session.messages as any[]);
		}
		return terminal;
	}

	/**
	 * Classify a single sub-agent run from stored metadata and session state.
	 */
	private static inferTerminalOutcomeFromResult(
		err: string | undefined,
		sessionMessages: any[] | undefined,
	): TerminalOutcome {
		if (err === undefined) {
			const terminalDiagnostic = sessionMessages ? getTerminalDiagnosticFromMessages(sessionMessages) : "";
			if (!terminalDiagnostic) {
				const lastAssistant = sessionMessages
					? [...sessionMessages].reverse().find((message) => message?.role === "assistant")
					: undefined;
				if (lastAssistant?.stopReason === "aborted") return "aborted";
				if (lastAssistant?.stopReason === "error") return "crashed";
				return "crashed";
			}
			if (/aborted|abort/i.test(terminalDiagnostic)) return "aborted";
			if (/killed|terminate/i.test(terminalDiagnostic)) return "aborted";
			return "crashed";
		}
		if (err === "killed") return "aborted";
		if (err === "abort_request_failed") return "abort_request_failed";
		const lastAssistant = sessionMessages
			? [...sessionMessages].reverse().find((message) => message?.role === "assistant")
			: undefined;
		const stopReason = lastAssistant?.stopReason;
		if (stopReason === "aborted") return "aborted";
		if (/aborted|abort/i.test(err)) return "aborted";
		return "crashed";
	}

	private static persistTerminalOutcome(
		metadataStore: Pick<MetadataStore, "upsertRecord">,
		record: SubagentRecord,
		terminalOutcome: TerminalOutcome | undefined,
		terminalError?: string,
		abortReason?: string,
		contextUsage?: SubagentContextUsage,
	): SubagentRecord {
		const terminalAt =
			terminalOutcome === undefined
				? undefined
				: terminalOutcome === record.terminalOutcome && record.terminalAt
					? record.terminalAt
					: new Date().toISOString();
		const nextRecord: SubagentRecord = {
			...record,
			terminalOutcome,
			terminalError,
			abortReason,
			terminalAt,
			contextUsage,
		};
		if (typeof (metadataStore as { upsertRecord?: (record: SubagentRecord) => void }).upsertRecord === "function") {
			metadataStore.upsertRecord(nextRecord);
		}
		return nextRecord;
	}

	private static classifyRunSnapshot(record: SubagentRecord, sessionManager: SessionAdapter): AgentRunSnapshot {
		const base: Omit<
			AgentRunSnapshot,
			"state" | "output" | "error" | "abortReason" | "warnings" | "terminalOutcome" | "terminalError" | "terminalAt"
		> = {
			id: record.id,
			displayName: record.displayName,
			agentType: record.agentType,
			sessionFile: record.sessionFile,
			contextUsage: record.contextUsage,
		};

		const asyncResult = sessionManager.getAsyncResult(record.id);
		if (asyncResult) {
			const pendingToolDiagnostic = isPendingToolDiagnostic(asyncResult.output);
			const rawTerminalOutcome =
				asyncResult.terminalOutcome ||
				(asyncResult.error
					? TaskController.inferTerminalOutcomeFromResult(asyncResult.error, undefined)
					: asyncResult.output
						? "completed"
						: record.terminalOutcome);
			const terminalOutcome =
				pendingToolDiagnostic && rawTerminalOutcome === "completed"
					? record.terminalOutcome === "aborted" || record.terminalOutcome === "timed_out"
						? record.terminalOutcome
						: "crashed"
					: rawTerminalOutcome;
			const terminalError = asyncResult.terminalError ?? (pendingToolDiagnostic ? asyncResult.output : undefined);
			return {
				...base,
				state:
					asyncResult.error === "killed" || (terminalOutcome === "aborted" && asyncResult.abortReason)
						? "killed"
						: "result_ready_memory",
				output: asyncResult.output,
				error: asyncResult.error ?? (pendingToolDiagnostic ? asyncResult.output : undefined),
				abortReason: asyncResult.abortReason,
				terminalOutcome: terminalOutcome,
				terminalError,
				terminalAt: asyncResult.terminalAt ?? record.terminalAt,
				contextUsage: asyncResult.contextUsage ?? record.contextUsage,
				warnings: asyncResult.warnings,
			};
		}

		if (sessionManager.isAsyncRunning(record.id)) {
			return {
				...base,
				state: "running_async",
				...(record.terminalOutcome ? { terminalOutcome: record.terminalOutcome } : {}),
				...(record.terminalError ? { terminalError: record.terminalError } : {}),
				...(record.abortReason ? { abortReason: record.abortReason } : {}),
				...(record.terminalAt ? { terminalAt: record.terminalAt } : {}),
			};
		}

		if (sessionManager.isCompleted(record.id)) {
			const persisted = TaskController.extractOutputFromSessionFile(record.sessionFile);
			const terminalOutcome =
				record.terminalOutcome ??
				(persisted?.source === "diagnostic"
					? TaskController.inferTerminalOutcomeFromResult(persisted.text, undefined)
					: undefined);
			return {
				...base,
				state: "result_ready_transcript",
				...(persisted ? { output: persisted.text } : {}),
				...(persisted?.source === "diagnostic" ? { error: persisted.text } : {}),
				...(terminalOutcome ? { terminalOutcome } : {}),
				...(record.terminalError || (persisted?.source === "diagnostic" ? { terminalError: persisted.text } : {})
					? {
							terminalError: record.terminalError ?? persisted?.text,
						}
					: {}),
				...(record.abortReason ? { abortReason: record.abortReason } : {}),
				...(record.terminalAt ? { terminalAt: record.terminalAt } : {}),
			};
		}

		if (sessionManager.hasOpenSession(record.id)) {
			return {
				...base,
				state: "running_open",
				...(record.terminalOutcome ? { terminalOutcome: record.terminalOutcome } : {}),
				...(record.terminalError ? { terminalError: record.terminalError } : {}),
				...(record.terminalAt ? { terminalAt: record.terminalAt } : {}),
			};
		}

		if (record.sessionFile) {
			const persisted = TaskController.extractOutputFromSessionFile(record.sessionFile);
			if (persisted !== undefined) {
				const terminalOutcome =
					record.terminalOutcome ??
					(persisted.source === "diagnostic"
						? TaskController.inferTerminalOutcomeFromResult(persisted.text, undefined)
						: undefined);
				return {
					...base,
					state: "result_ready_transcript",
					...(persisted ? { output: persisted.text } : {}),
					...(persisted.source === "diagnostic" ? { error: persisted.text } : {}),
					...(terminalOutcome ? { terminalOutcome } : {}),
					...(record.terminalError || (persisted?.source === "diagnostic" ? { terminalError: persisted.text } : {})
						? {
								terminalError: record.terminalError ?? persisted?.text,
							}
						: {}),
					...(record.abortReason ? { abortReason: record.abortReason } : {}),
					...(record.terminalAt ? { terminalAt: record.terminalAt } : {}),
				};
			}
			// Session file exists but has no assistant text or error diagnostic.
			return {
				...base,
				state: "result_ready_transcript",
				...(record.terminalOutcome ? { terminalOutcome: record.terminalOutcome } : {}),
				...(record.terminalError ? { terminalError: record.terminalError } : {}),
				...(record.abortReason ? { abortReason: record.abortReason } : {}),
				...(record.terminalAt ? { terminalAt: record.terminalAt } : {}),
			};
		}

		return {
			id: record.id,
			state: "unknown",
			...(record.terminalOutcome ? { terminalOutcome: record.terminalOutcome } : {}),
			...(record.terminalError ? { terminalError: record.terminalError } : {}),
			...(record.abortReason ? { abortReason: record.abortReason } : {}),
			...(record.terminalAt ? { terminalAt: record.terminalAt } : {}),
		};
	}

	private static classifyRunSnapshotFromId(
		agentId: string,
		metadataStore: MetadataAdapter,
		sessionManager: SessionAdapter,
	): AgentRunSnapshot {
		let record: SubagentRecord | undefined;
		try {
			record = metadataStore.findRecord(agentId);
		} catch {
			// fall through to unknown
		}

		if (!record) {
			return { id: agentId, state: "unknown" };
		}

		return TaskController.classifyRunSnapshot(record, sessionManager);
	}

	private static toAgentWaitResult(snapshot: AgentRunSnapshot): AgentWaitResult {
		if (snapshot.state === "running_async" || snapshot.state === "running_open") {
			return {
				id: snapshot.id,
				displayName: snapshot.displayName,
				agentType: snapshot.agentType,
				status: "running",
				terminalOutcome: snapshot.terminalOutcome,
				terminalError: snapshot.terminalError,
				terminalAt: snapshot.terminalAt,
				contextUsage: snapshot.contextUsage,
				sessionFile: snapshot.sessionFile,
			};
		}

		if (snapshot.state === "killed") {
			return {
				id: snapshot.id,
				displayName: snapshot.displayName,
				agentType: snapshot.agentType,
				status: "killed",
				output: snapshot.output,
				error: snapshot.error,
				abortReason: snapshot.abortReason,
				terminalOutcome: snapshot.terminalOutcome,
				terminalError: snapshot.terminalError,
				terminalAt: snapshot.terminalAt,
				contextUsage: snapshot.contextUsage,
				warnings: snapshot.warnings,
				sessionFile: snapshot.sessionFile,
			};
		}

		if (snapshot.state === "result_ready_memory" || snapshot.state === "result_ready_transcript") {
			return {
				id: snapshot.id,
				displayName: snapshot.displayName,
				agentType: snapshot.agentType,
				status: "completed",
				output: snapshot.output,
				error: snapshot.error,
				abortReason: snapshot.abortReason,
				terminalOutcome: snapshot.terminalOutcome,
				terminalError: snapshot.terminalError,
				terminalAt: snapshot.terminalAt,
				contextUsage: snapshot.contextUsage,
				warnings: snapshot.warnings,
				sessionFile: snapshot.sessionFile,
			};
		}

		return {
			id: snapshot.id,
			status: "unknown",
			terminalOutcome: snapshot.terminalOutcome,
			terminalError: snapshot.terminalError,
			terminalAt: snapshot.terminalAt,
			contextUsage: snapshot.contextUsage,
		};
	}

	// ---- Instance methods ----

	/**
	 * Execute a single Task (sub-agent) invocation.
	 *
	 * All runtime state is passed via `context`; the controller itself
	 * is stateless. Setup errors (discovery, metadata, resource-loader
	 * creation, session creation, lock acquisition) are caught and
	 * returned as structured error results — this method never throws.
	 */
	async execute(params: TaskExecuteParams, context: TaskExecuteContext): Promise<TaskResult> {
		const requestedCwd = params.cwd || context.cwd;
		const {
			runtime,
			agentDiscovery,
			metadataStore,
			sessionManager,
			modelResolver,
			fallbackModel,
			modelRegistry,
			createResourceLoaderFactory,
			onUpdate,
		} = context;
		const logger = runtime.logger ?? makeNoopDebugLogger();

		// a. Agent discovery (via injected adapter)
		let agents: AgentConfig[];
		const warnings: string[] = [];
		const runLogger = logger.child({
			component: "task_controller",
			runId: createRunCorrelationId("task"),
			treeDepth: runtime.treeDepth,
			parentAgentId: runtime.parentAgentId,
			subagentType: params.subagent_type,
			resumed: Boolean(params.resume),
			mode: params.mode ?? "fast",
			blocking: params.blocking !== false,
			cwdLength: requestedCwd.length,
		});
		runLogger.info("task_run_start", {
			promptLength: params.prompt.length,
			descriptionLength: params.description.length,
		});
		runLogger.debug("task_discovery_start");
		try {
			const discovery = agentDiscovery.discover();
			agents = discovery.agents;

			for (const d of discovery.diagnostics) {
				if (d.level === "warn") {
					warnings.push(`[AgentRegistry] ${d.filePath}: ${d.reason}`);
				}
			}
			const errors = discovery.diagnostics.filter((d) => d.level === "error");
			if (errors.length > 0) {
				warnings.push(
					`Some agent definitions were skipped due to errors:\n${errors
						.map((d) => `- ${d.filePath}: ${d.reason}`)
						.join("\n")}`,
				);
			}
			runLogger.debug("task_discovery_completed", {
				agentCount: agents.length,
				warningCount: warnings.length,
				diagnosticCount: discovery.diagnostics.length,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			runLogger.error("task_discovery_failed", { error: message, treeDepth: runtime.treeDepth });
			return {
				content: [{ type: "text", text: `Task failed during agent discovery: ${message}` }],
				details: { warnings, error: message },
			};
		}

		// b. Resolve agent (and possibly record for resume)
		let metadata: MetadataFile;
		try {
			metadata = metadataStore.load();
			runLogger.debug("task_metadata_load_success", {
				recordCount: metadata.records.length,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			runLogger.error("task_metadata_load_failed", { error: message });
			return {
				content: [{ type: "text", text: `Task failed while loading metadata: ${message}` }],
				details: { warnings, error: message },
			};
		}

		const resolved = TaskController.resolveTaskAgent(params, metadata, agents);
		if (!resolved.ok) {
			runLogger.warn("task_agent_resolution_failed", {
				errorCode: resolved.errorCode,
				resumeRequested: Boolean(params.resume),
			});
			return {
				content: [{ type: "text", text: resolved.errorText }],
				details: { warnings, error: resolved.errorCode },
			};
		}
		runLogger.debug("task_agent_resolution_success", {
			agentType: resolved.agent.name,
			resume: Boolean(params.resume),
			hasParent: Boolean(runtime.parentAgentId),
		});
		const { agent } = resolved;
		const mode = params.mode ?? "fast";
		const modeConfig = resolveAgentMode(agent, mode);
		// Keep the discovered definition immutable, but pass the selected mode to
		// session creation as the effective model/effort pair.
		const sessionAgent: AgentConfig = {
			...agent,
			model: modeConfig.model,
			reasoningEffort: modeConfig.reasoningEffort,
		};
		let record = resolved.record;
		const effectiveCwd = record
			? record.cwd || readSessionHeaderCwd(record.sessionFile) || requestedCwd
			: requestedCwd;

		// c. Check task permission via DepthPolicy
		const taskCheck = checkTaskAllowed(runtime.depthPolicy, agent.name);
		if (!taskCheck.allowed) {
			runLogger.warn("task_depth_policy_rejected", {
				agentType: agent.name,
				reason: taskCheck.code,
				rootDepthLimit: runtime.depthPolicy.rootDepthLimit,
			});
			return {
				content: [{ type: "text", text: taskCheck.error! }],
				details: { warnings, agentType: agent.name, error: taskCheck.code },
			};
		}
		runLogger.debug("task_depth_policy_allowed", { agentType: agent.name, allowed: taskCheck.allowed });

		// d. Allocate record if not resuming
		if (!record) {
			runLogger.debug("task_record_allocation_start", {
				agentType: agent.name,
				depth: runtime.treeDepth + 1,
				parentAgentId: runtime.parentAgentId,
			});
			try {
				record = await metadataStore.allocateRecord(agent.name, runtime.parentAgentId, runtime.treeDepth + 1);
				record.cwd = effectiveCwd;
				metadataStore.upsertRecord(record);
				runLogger.info("task_record_allocated", {
					recordId: record?.id,
					displayName: record?.displayName,
					depth: record?.depth,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				runLogger.error("task_record_allocation_failed", {
					agentType: agent.name,
					error: message,
				});
				return {
					content: [{ type: "text", text: `Task failed during record allocation: ${message}` }],
					details: { warnings, agentType: agent.name, error: message },
				};
			}
		}

		const recordId = record.id;

		// e. Run serialised within the record lock
		try {
			return await sessionManager.withRecordRunLock(recordId, async () => {
				// Re-read record in case another concurrent path updated it
				record = metadataStore.findRecord(recordId) ?? record!;

				// Build the child runtime for the sub-agent
				const childTreeDepth = record!.depth;
				const childRuntime: RuntimeContext = {
					parentAgentId: record!.id,
					treeDepth: childTreeDepth,
					depthPolicy: childPolicy(runtime.depthPolicy, agent, childTreeDepth),
					store: metadataStore,
					logger: runLogger,
				};

				const rejectUnconsumedAsyncResult = (snapshot: AgentRunSnapshot): TaskResult | undefined => {
					if (!params.resume || (snapshot.state !== "result_ready_memory" && snapshot.state !== "killed")) {
						return undefined;
					}
					runLogger.warn("task_resume_blocked_unconsumed_result", {
						recordId: record?.id,
						runState: snapshot.state,
					});
					return {
						content: [
							{
								type: "text",
								text: `${record!.displayName} (${record!.id}) has completed async output waiting to be consumed. Use wait_for_agent with agent_id "${record!.id}" before resuming it again.`,
							},
						],
						details: {
							id: record!.id,
							displayName: record!.displayName,
							agentType: record!.agentType,
							description: params.description,
							resumed: true,
							sessionFile: record!.sessionFile,
							warnings,
							error: "async_result_unconsumed",
						},
					};
				};

				const preRunSnapshot = TaskController.classifyRunSnapshot(record!, sessionManager);
				const preRunRejection = rejectUnconsumedAsyncResult(preRunSnapshot);
				if (preRunRejection) return preRunRejection;

				const clearTerminalOutcome = (): SubagentRecord => {
					const refreshed = metadataStore.findRecord(record!.id) ?? record!;
					const nextRecord = TaskController.persistTerminalOutcome(metadataStore, refreshed, undefined);
					record = nextRecord;
					return nextRecord;
				};

				// Obtain the resource loader via the injected factory
				const reportWarnings = (entries: string[]) => {
					if (!entries || entries.length === 0) return;
					warnings.push(...entries);
				};
				let resourceLoader: DefaultResourceLoader;
				let childSettingsManager: SettingsManager | undefined;
				try {
					const loaderSetup = await createResourceLoaderFactory(agent, childRuntime, effectiveCwd, reportWarnings);
					if ("resourceLoader" in loaderSetup) {
						resourceLoader = loaderSetup.resourceLoader;
						childSettingsManager = loaderSetup.settingsManager;
					} else {
						resourceLoader = loaderSetup;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						content: [
							{
								type: "text",
								text: `${record!.displayName} (${record!.id}) failed to initialise resource loader. Use resume: "${record!.id}" to retry.\n\n${message}`,
							},
						],
						details: {
							id: record!.id,
							displayName: record!.displayName,
							agentType: record!.agentType,
							description: params.description,
							resumed: Boolean(params.resume),
							sessionFile: record!.sessionFile,
							warnings,
							error: message,
						},
					};
				}

				let session: any;
				const hadOpenSessionBeforeSetup = sessionManager.hasOpenSession(record!.id);
				runLogger.debug("task_session_setup_started", {
					recordId: record?.id,
					hadOpenSession: hadOpenSessionBeforeSetup,
					agentModel: sessionAgent.model || "default",
					agentReasoningEffort: sessionAgent.reasoningEffort,
					mode,
					agentToolNames: sessionAgent.tools ? sessionAgent.tools.length : undefined,
				});
				try {
					session = await sessionManager.getOrCreateSession(record!, sessionAgent, warnings, {
						metadataStore,
						cwd: effectiveCwd,
						fallbackModel,
						modelResolver,
						modelRegistry,
						settingsManager: childSettingsManager,
						createResourceLoader: async () => resourceLoader,
					});
					runLogger.info("task_session_setup_completed", {
						recordId: record!.id,
						resumed: Boolean(params.resume),
					});
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					runLogger.error("task_session_setup_failed", {
						recordId: record!.id,
						error: message,
					});
					return {
						content: [
							{
								type: "text",
								text: `${record!.displayName} (${record!.id}) failed to create session. Use resume: "${record!.id}" to retry.\n\n${message}`,
							},
						],
						details: {
							id: record!.id,
							displayName: record!.displayName,
							agentType: record!.agentType,
							description: params.description,
							resumed: Boolean(params.resume),
							sessionFile: record!.sessionFile,
							warnings,
							error: message,
						},
					};
				}

				const setupRunSnapshot = TaskController.classifyRunSnapshot(record!, sessionManager);
				const setupRunRejection = rejectUnconsumedAsyncResult(setupRunSnapshot);
				if (setupRunRejection) {
					runLogger.warn("task_run_blocked_unconsumed_result_after_setup", { recordId: record!.id });
					if (!hadOpenSessionBeforeSetup) {
						try {
							await sessionManager.disposeSession(record!.id);
						} catch {
							/* best-effort cleanup for rejected setup */
						}
					}
					return setupRunRejection;
				}

				const blocking = params.blocking !== false;

				if (!blocking) {
					runLogger.debug("task_run_async_start", {
						recordId: record!.id,
						resumed: Boolean(params.resume),
						hasOpenSession: sessionManager.hasOpenSession(record!.id),
					});
					// Async resume while the same record is already running is a steering
					// request, not a second prompt. Queue it explicitly so AgentSession
					// does not reject with "already processing" and so the original async
					// run remains the owner of the final wait_for_agent result.
					const runSnapshot = TaskController.classifyRunSnapshot(record!, sessionManager);
					if (params.resume && runSnapshot.state === "running_async") {
						const isStreaming =
							typeof session?.isStreaming === "boolean"
								? session.isStreaming
								: typeof session?.agent?.state?.isStreaming === "boolean"
									? session.agent.state.isStreaming
									: undefined;
						if (isStreaming === false) {
							runLogger.warn("task_async_steer_blocked_not_streaming", {
								recordId: record!.id,
							});
							return {
								content: [
									{
										type: "text",
										text: `${record!.displayName} (${record!.id}) is finalizing its async result and cannot be steered. Use wait_for_agent with agent_id "${record!.id}" to retrieve output, then resume it again if more work is needed.`,
									},
								],
								details: {
									id: record!.id,
									displayName: record!.displayName,
									agentType: record!.agentType,
									description: params.description,
									resumed: true,
									sessionFile: record!.sessionFile,
									warnings,
									error: "async_finalizing",
								},
							};
						}
						runLogger.info("task_async_steer_attempt", {
							recordId: record!.id,
							hasSteerHelper: typeof session.steer === "function",
						});
						try {
							if (typeof session.steer === "function") {
								await session.steer(params.prompt);
							} else {
								await session.prompt(params.prompt, { streamingBehavior: "steer" });
							}
							runLogger.info("task_async_steer_success", { recordId: record!.id });
							return {
								content: [
									{
										type: "text",
										text: `${record!.displayName} (${record!.id}) steered. Use wait_for_agent with agent_id "${record!.id}" to retrieve output.`,
									},
								],
								details: {
									id: record!.id,
									displayName: record!.displayName,
									agentType: record!.agentType,
									description: params.description,
									resumed: true,
									sessionFile: record!.sessionFile,
									warnings,
								},
							};
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							runLogger.warn("task_async_steer_failed", { recordId: record!.id, error: message });
							const refreshedRecord = metadataStore.findRecord(record!.id);
							if (refreshedRecord) {
								record = TaskController.persistTerminalOutcome(
									metadataStore,
									refreshedRecord,
									"abort_request_failed",
									message,
									"steer_failed",
								);
							}
							return {
								content: [
									{
										type: "text",
										text: `${record!.displayName} (${record!.id}) failed to queue steering message. Use wait_for_agent with agent_id "${record!.id}" to retrieve output from the original run.\n\n${message}`,
									},
								],
								details: {
									id: record!.id,
									displayName: record!.displayName,
									agentType: record!.agentType,
									description: params.description,
									resumed: true,
									sessionFile: record!.sessionFile,
									warnings,
									error: message,
									terminalOutcome: "abort_request_failed",
								},
							};
						}
					}

					// Async path: start prompt in background, return immediately.
					// The session stays tracked; `wait_for_agent` retrieves output later.
					clearTerminalOutcome();
					sessionManager.markAsyncRunning(record!.id);
					runLogger.debug("task_async_marked_running", {
						recordId: record!.id,
					});

					let asyncAbortContextUsage: SubagentContextUsage | undefined;
					let asyncAbortContextUsageCaptured = false;
					let asyncAbortRequested = false;
					let asyncPromptStarted = false;
					const abort = () => {
						runLogger.warn("task_async_signal_abort", { recordId: record!.id });
						asyncAbortRequested = true;
						asyncAbortContextUsage = readSubagentContextUsage(session);
						asyncAbortContextUsageCaptured = true;
						if (asyncPromptStarted) {
							try {
								void Promise.resolve(session?.abort()).catch((error: unknown) => {
									runLogger.warn("task_async_abort_failed", {
										recordId: record!.id,
										error: error instanceof Error ? error.message : String(error),
									});
								});
							} catch (error) {
								runLogger.warn("task_async_abort_failed", {
									recordId: record!.id,
									error: error instanceof Error ? error.message : String(error),
								});
							}
						}
					};
					if (context.signal?.aborted) {
						abort();
						const message = "Task execution was aborted.";
						const baseRecord = metadataStore.findRecord(record!.id) ?? record!;
						record = TaskController.persistTerminalOutcome(
							metadataStore,
							baseRecord,
							"aborted",
							message,
							"parent_signal",
							asyncAbortContextUsage,
						);
						sessionManager.finalizeAsyncRun(record.id, {
							output: "",
							error: message,
							terminalOutcome: "aborted",
							terminalError: message,
							terminalAt: record.terminalAt,
							abortReason: "parent_signal",
							contextUsage: asyncAbortContextUsage,
							warnings,
						});
						return {
							content: [{ type: "text", text: message }],
							details: {
								id: record.id,
								displayName: record.displayName,
								agentType: record.agentType,
								description: params.description,
								resumed: Boolean(params.resume),
								sessionFile: record.sessionFile,
								warnings,
								error: message,
								terminalOutcome: "aborted",
							},
						};
					}
					context.signal?.addEventListener("abort", abort, { once: true });

					let asyncFinished = false;
					let unsubscribeFromSession = () => {};
					const finish = (
						resolved: boolean,
						errorMessage: string | undefined,
						terminal?: { text: string; source: "assistant" | "diagnostic" | "none" },
					) => {
						if (asyncFinished) return;
						asyncFinished = true;
						try {
							unsubscribeFromSession();
						} catch (error) {
							runLogger.warn("task_async_unsubscribe_failed", {
								recordId: record!.id,
								error: error instanceof Error ? error.message : String(error),
							});
						}
						context.signal?.removeEventListener("abort", abort);
						try {
							metadataStore.touchRecord(record!.id);
						} catch {
							/* best-effort */
						}
						const baseRecord = metadataStore.findRecord(record!.id);
						if (!baseRecord) {
							return;
						}
						const contextUsage = asyncAbortContextUsageCaptured
							? asyncAbortContextUsage
							: readSubagentContextUsage(session);
						if (resolved) {
							const extracted = terminal ?? TaskController.extractTerminalOutput(session.messages as any[]);
							const terminalOutcome =
								extracted.source === "assistant"
									? "completed"
									: extracted.source === "diagnostic"
										? TaskController.inferTerminalOutcomeFromResult(extracted.text, session.messages as any[])
										: undefined;
							record = TaskController.persistTerminalOutcome(
								metadataStore,
								baseRecord,
								terminalOutcome,
								extracted.source === "diagnostic" ? extracted.text : undefined,
								undefined,
								contextUsage,
							);
							sessionManager.finalizeAsyncRun(record!.id, {
								output: extracted.text,
								...(extracted.source === "diagnostic" ? { error: extracted.text } : {}),
								terminalOutcome,
								terminalError: extracted.source === "diagnostic" ? extracted.text : undefined,
								terminalAt: record?.terminalAt,
								contextUsage,
								warnings,
							});
							runLogger.info("task_async_completed", {
								recordId: record!.id,
								outputLength: extracted.text.length,
								hasError: extracted.source === "diagnostic",
							});
						} else {
							const extracted = TaskController.extractOutput(session.messages as any[], errorMessage);
							const terminalOutcome = TaskController.inferTerminalOutcomeFromResult(
								errorMessage,
								session.messages as any[],
							);
							record = TaskController.persistTerminalOutcome(
								metadataStore,
								baseRecord,
								terminalOutcome,
								extracted.source === "diagnostic" ? extracted.text : errorMessage,
								undefined,
								contextUsage,
							);
							sessionManager.finalizeAsyncRun(record!.id, {
								output: extracted.text,
								error: errorMessage,
								terminalOutcome,
								terminalError: extracted.source === "diagnostic" ? extracted.text : errorMessage,
								terminalAt: record?.terminalAt,
								contextUsage,
								abortReason: terminalOutcome === "aborted" ? "async_result" : undefined,
								warnings,
							});
							runLogger.warn("task_async_failed", {
								recordId: record!.id,
								error: errorMessage,
								outputLength: extracted.text.length,
							});
						}
					};

					const finalizeAsyncFailure = (error: unknown) => {
						const wasFinished = asyncFinished;
						asyncFinished = true;
						if (!wasFinished) {
							try {
								unsubscribeFromSession();
							} catch {
								/* Best-effort listener cleanup. */
							}
							context.signal?.removeEventListener("abort", abort);
						}
						const failureMessage = error instanceof Error ? error.message : String(error);
						const message = failureMessage || "Sub-agent async finalization failed unexpectedly.";
						runLogger.error("task_async_finalization_failed", {
							recordId: record?.id,
							error: message,
						});

						if (!record?.id) return;
						try {
							if (sessionManager.getAsyncResult(record.id)) return;
						} catch {
							/* Continue with the fallback if result inspection fails. */
						}

						let output = "";
						try {
							output = TaskController.extractOutput(session.messages as any[], message).text;
						} catch {
							/* Best-effort partial output extraction. */
						}
						let contextUsage: SubagentContextUsage | undefined;
						try {
							contextUsage = readSubagentContextUsage(session);
						} catch {
							/* Best-effort context usage extraction. */
						}
						try {
							sessionManager.finalizeAsyncRun(record.id, {
								output,
								error: message,
								terminalOutcome: TaskController.inferTerminalOutcomeFromResult(
									message,
									session.messages as any[],
								),
								terminalError: message,
								contextUsage,
								warnings,
							});
						} catch (fallbackError) {
							runLogger.error("task_async_finalization_fallback_failed", {
								recordId: record.id,
								error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
							});
						}
					};
					const safeFinish = (
						resolved: boolean,
						errorMessage: string | undefined,
						terminal?: { text: string; source: "assistant" | "diagnostic" | "none" },
					) => {
						try {
							finish(resolved, errorMessage, terminal);
						} catch (error) {
							finalizeAsyncFailure(error);
						}
					};

					// A provider can terminate the agent with a diagnostic without settling
					// prompt(). Finalize from the lifecycle event so wait_for_agent is woken.
					unsubscribeFromSession = session.subscribe((event: any) => {
						if (event?.type !== "agent_end" || asyncFinished) return;
						try {
							const terminal = TaskController.extractTerminalOutput(session.messages as any[]);
							if (terminal.source === "diagnostic") {
								safeFinish(false, terminal.text);
							}
						} catch (error) {
							finalizeAsyncFailure(error);
						}
					});
					if (asyncFinished) {
						try {
							unsubscribeFromSession();
						} catch (error) {
							finalizeAsyncFailure(error);
						}
					}

					Promise.resolve()
						.then(() => {
							if (asyncAbortRequested) throw new Error("Task execution was aborted.");
							asyncPromptStarted = true;
							return session.prompt(params.prompt);
						})
						.then(() => TaskController._ensureFinalResponse(session))
						.then(
							(terminal) => safeFinish(true, undefined, terminal),
							(err: unknown) => {
								const message = err instanceof Error ? err.message : String(err);
								safeFinish(false, message);
							},
						)
						.catch((error: unknown) => finalizeAsyncFailure(error));

					return {
						content: [
							{
								type: "text",
								text: `${record!.displayName} (${record!.id}) started. Use wait_for_agent with agent_id "${record!.id}" to retrieve output.`,
							},
						],
						details: {
							id: record!.id,
							displayName: record!.displayName,
							agentType: record!.agentType,
							description: params.description,
							resumed: Boolean(params.resume),
							sessionFile: record!.sessionFile,
							warnings,
						},
					};
				}

				// Blocking path (existing behaviour)
				runLogger.debug("task_blocking_path", {
					recordId: record!.id,
				});
				const emit = (text: string) => {
					onUpdate?.({
						content: [{ type: "text", text }],
						details: {
							id: record!.id,
							displayName: record!.displayName,
							agentType: record!.agentType,
							description: params.description,
							resumed: Boolean(params.resume),
							sessionFile: record!.sessionFile,
							warnings,
						},
					});
				};

				let runtimeTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
				let unsubscribeBlockingLifecycle = () => {};
				const clearRuntimeTimeout = () => {
					if (runtimeTimeoutHandle !== undefined) {
						clearTimeout(runtimeTimeoutHandle);
						runtimeTimeoutHandle = undefined;
					}
				};
				let abortContextUsage: SubagentContextUsage | undefined;
				let abortContextUsageCaptured = false;
				const abortTask = () => {
					clearRuntimeTimeout();
					abortContextUsage = readSubagentContextUsage(session);
					abortContextUsageCaptured = true;
					try {
						void Promise.resolve(session?.abort()).catch((error: unknown) => {
							runLogger.warn("task_blocking_abort_failed", {
								recordId: record!.id,
								error: error instanceof Error ? error.message : String(error),
							});
						});
					} catch (error) {
						runLogger.warn("task_blocking_abort_failed", {
							recordId: record!.id,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				};

				let onAbort: (() => void) | undefined;
				const externalAbortResult = context.signal
					? new Promise<{ type: "aborted" }>((resolve) => {
							onAbort = () => {
								abortTask();
								resolve({ type: "aborted" });
							};
							if (context.signal?.aborted) {
								onAbort();
							} else {
								context.signal?.addEventListener("abort", onAbort, { once: true });
							}
						})
					: undefined;

				const capturedAbortContextUsage = () =>
					abortContextUsageCaptured ? { captured: true, value: abortContextUsage } : undefined;
				const persistBlockingTerminal = (
					terminalOutcome: TerminalOutcome | undefined,
					terminalError?: string,
					abortReason?: string,
					capturedContextUsage?: { captured: boolean; value: SubagentContextUsage | undefined },
				): SubagentContextUsage | undefined => {
					const contextUsage = capturedContextUsage?.captured
						? capturedContextUsage.value
						: readSubagentContextUsage(session);
					const refreshed = metadataStore.findRecord(record!.id) ?? record!;
					record = TaskController.persistTerminalOutcome(
						metadataStore,
						refreshed,
						terminalOutcome,
						terminalError,
						abortReason,
						contextUsage,
					);
					return contextUsage;
				};

				try {
					emit(`${record!.displayName} (${record!.id}) running...`);

					// Guard against double-prompt when async is already in-flight
					const runSnapshot = TaskController.classifyRunSnapshot(record!, sessionManager);
					if (runSnapshot.state === "running_async") {
						runLogger.warn("task_blocking_rejected_async_in_flight", {
							recordId: record!.id,
						});
						return {
							content: [
								{
									type: "text",
									text: `${record!.displayName} (${record!.id}) is still running asynchronously. Use wait_for_agent with agent_id "${record!.id}" to retrieve output.`,
								},
							],
							details: {
								id: record!.id,
								displayName: record!.displayName,
								agentType: record!.agentType,
								description: params.description,
								resumed: Boolean(params.resume),
								sessionFile: record!.sessionFile,
								warnings,
								error: "async_in_flight",
							},
						};
					}

					clearTerminalOutcome();
					unsubscribeBlockingLifecycle = session.subscribe((event: any) => {
						if (
							event?.type === "agent_start" ||
							event?.type === "turn_start" ||
							event?.type === "turn_end" ||
							event?.type === "agent_end"
						) {
							runLogger.debug("task_blocking_agent_event", {
								recordId: record!.id,
								eventType: event.type,
							});
						}
					});
					const promptRace = [] as Array<
						Promise<
							| { type: "completed"; terminal: { text: string; source: "assistant" | "diagnostic" | "none" } }
							| { type: "failed"; error: unknown }
							| { type: "timeout" }
							| { type: "aborted" }
						>
					>;
					if (!context.signal?.aborted) {
						const promptResult = Promise.resolve()
							.then(() => {
								runLogger.info("task_blocking_prompt_start", {
									recordId: record!.id,
									promptLength: params.prompt.length,
									timeoutMs: DEFAULT_TASK_RUNTIME_TIMEOUT_MS,
								});
								return session.prompt(params.prompt);
							})
							.then(() => {
								runLogger.info("task_blocking_prompt_resolved", { recordId: record!.id });
								return TaskController._ensureFinalResponse(session);
							})
							.then(
								(terminal) => {
									runLogger.info("task_blocking_final_response_resolved", {
										recordId: record!.id,
										source: terminal.source,
									});
									return { type: "completed" as const, terminal };
								},
								(error: unknown) => {
									runLogger.warn("task_blocking_prompt_rejected", {
										recordId: record!.id,
										error: error instanceof Error ? error.message : String(error),
									});
									return { type: "failed" as const, error };
								},
							);
						promptRace.push(promptResult);
						const timeoutResult = new Promise<{ type: "timeout" }>((resolve) => {
							runtimeTimeoutHandle = setTimeout(() => {
								abortTask();
								resolve({ type: "timeout" });
							}, DEFAULT_TASK_RUNTIME_TIMEOUT_MS);
						});
						promptRace.push(timeoutResult);
					}
					if (externalAbortResult) {
						promptRace.push(externalAbortResult);
					}

					const promptOrTimeout = await Promise.race(promptRace);
					clearRuntimeTimeout();
					if (promptOrTimeout.type === "timeout") {
						runLogger.warn("task_blocking_timeout", {
							recordId: record!.id,
							minutes: DEFAULT_TASK_RUNTIME_TIMEOUT_MINUTES,
						});
						const contextUsage = persistBlockingTerminal(
							"timed_out",
							TASK_RUNTIME_TIMEOUT_ERROR_CODE,
							"task_runtime_timeout",
							capturedAbortContextUsage(),
						);
						const message = `Task execution exceeded the ${DEFAULT_TASK_RUNTIME_TIMEOUT_MINUTES}-minute runtime limit. Use resume: "${record!.id}" to continue this agent.`;
						const warningText =
							warnings.length > 0 ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
						return {
							content: [
								{
									type: "text",
									text: `${record!.displayName} (${record!.id}) timed out. ${message}\n${formatContextUsageLine(contextUsage)}${warningText}`,
								},
							],
							details: {
								id: record!.id,
								displayName: record!.displayName,
								agentType: record!.agentType,
								description: params.description,
								resumed: Boolean(params.resume),
								sessionFile: record!.sessionFile,
								warnings,
								error: TASK_RUNTIME_TIMEOUT_ERROR_CODE,
								abortReason: "task_runtime_timeout",
								terminalOutcome: "timed_out",
								terminalError: TASK_RUNTIME_TIMEOUT_ERROR_CODE,
								terminalAt: record?.terminalAt,
								contextUsage,
							},
						};
					}
					if (promptOrTimeout.type === "aborted") {
						runLogger.warn("task_blocking_aborted", { recordId: record!.id });
						throw new Error("Task execution was aborted.");
					}
					if (promptOrTimeout.type === "failed") {
						runLogger.error("task_blocking_prompt_failed", {
							recordId: record!.id,
							error:
								promptOrTimeout.error instanceof Error
									? promptOrTimeout.error.message
									: String(promptOrTimeout.error),
						});
						throw promptOrTimeout.error;
					}

					if (promptOrTimeout.terminal.source === "diagnostic") {
						runLogger.warn("task_blocking_diagnostic", {
							recordId: record!.id,
							outputLength: promptOrTimeout.terminal.text.length,
						});
						throw new Error(promptOrTimeout.terminal.text || "The sub-agent stopped with a diagnostic.");
					}
					if (promptOrTimeout.terminal.source === "none") {
						const contextUsage = persistBlockingTerminal(
							undefined,
							undefined,
							undefined,
							capturedAbortContextUsage(),
						);
						const warningText =
							warnings.length > 0 ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
						return {
							content: [
								{
									type: "text",
									text: `${record!.displayName} (${record!.id}) is no longer running, but no final assistant output was captured. Use resume: "${record!.id}" to continue this agent.\n${formatContextUsageLine(contextUsage)}\n\nNo final assistant output was captured.${warningText}`,
								},
							],
							details: {
								id: record!.id,
								displayName: record!.displayName,
								agentType: record!.agentType,
								description: params.description,
								resumed: Boolean(params.resume),
								sessionFile: record!.sessionFile,
								warnings,
								contextUsage,
							},
						};
					}

					const output = promptOrTimeout.terminal.text;
					const contextUsage = persistBlockingTerminal(
						"completed",
						undefined,
						undefined,
						capturedAbortContextUsage(),
					);
					runLogger.info("task_blocking_completed", {
						recordId: record!.id,
						outputLength: output.length,
						hasWarnings: warnings.length > 0,
					});
					const header = `${record!.displayName} (${record!.id}) completed. Use resume: "${record!.id}" to continue this agent.`;
					const warningText =
						warnings.length > 0 ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
					return {
						content: [
							{
								type: "text",
								text: `${header}\n${formatContextUsageLine(contextUsage)}\n\n${output || "(no output)"}${warningText}`,
							},
						],
						details: {
							id: record!.id,
							displayName: record!.displayName,
							agentType: record!.agentType,
							description: params.description,
							resumed: Boolean(params.resume),
							sessionFile: record!.sessionFile,
							warnings,
							terminalOutcome: "completed",
							terminalAt: record?.terminalAt,
							contextUsage,
							output,
						},
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const terminalError = message || "sub-agent stopped unexpectedly.";
					runLogger.error("task_blocking_crashed", {
						recordId: record!.id,
						error: terminalError,
						outputLength: session?.messages?.length,
					});
					const extracted = TaskController.extractOutput(session.messages as any[], terminalError);
					const terminalOutcome = TaskController.inferTerminalOutcomeFromResult(
						terminalError,
						session.messages as any[],
					);
					const contextUsage = persistBlockingTerminal(
						terminalOutcome,
						terminalError,
						terminalOutcome === "aborted" ? "task_blocking_abort" : undefined,
						capturedAbortContextUsage(),
					);
					const warningText =
						warnings.length > 0 ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
					let contentText: string;
					if (extracted.source === "assistant") {
						contentText = `${record!.displayName} (${record!.id}) stopped with an error after producing partial output. Use resume: "${record!.id}" to retry or continue.\n${formatContextUsageLine(contextUsage)}\n\n${extracted.text}${warningText}`;
					} else if (extracted.source === "diagnostic") {
						contentText = `${record!.displayName} (${record!.id}) stopped with an error. Use resume: "${record!.id}" to retry or continue this agent.\n${formatContextUsageLine(contextUsage)}\n\n${extracted.text}${warningText}`;
					} else {
						contentText = `${record!.displayName} (${record!.id}) stopped with an error. Use resume: "${record!.id}" to retry or continue this agent.\n${formatContextUsageLine(contextUsage)}\n\nThe sub-agent stopped without producing any output.${warningText}`;
					}
					return {
						content: [
							{
								type: "text",
								text: contentText,
							},
						],
						details: {
							id: record!.id,
							displayName: record!.displayName,
							agentType: record!.agentType,
							description: params.description,
							resumed: Boolean(params.resume),
							sessionFile: record!.sessionFile,
							warnings,
							error: terminalError,
							terminalOutcome,
							terminalError,
							terminalAt: record?.terminalAt,
							contextUsage,
							...(extracted.source === "assistant" ? { output: extracted.text } : {}),
						},
					};
				} finally {
					try {
						unsubscribeBlockingLifecycle();
					} catch {
						/* best-effort listener cleanup */
					}
					runLogger.debug("task_blocking_completed_cleanup", { recordId: record!.id });
					if (context.signal && onAbort) {
						context.signal.removeEventListener("abort", onAbort);
					}
					clearRuntimeTimeout();
					try {
						metadataStore.touchRecord(record!.id);
					} catch {
						/* best-effort */
					}
					try {
						await sessionManager.disposeSession(record!.id);
					} catch {
						/* may already be disposed */
					}
				}
			});
		} catch (err) {
			// Catch failures from withRecordRunLock itself (lock acquisition).
			const message = err instanceof Error ? err.message : String(err);
			runLogger.error("task_lock_failed", {
				recordId: record?.id,
				error: message,
			});
			return {
				content: [
					{ type: "text", text: `${record!.displayName} (${record!.id}) failed during execution: ${message}` },
				],
				details: {
					id: record!.id,
					displayName: record!.displayName,
					agentType: record!.agentType,
					description: params.description,
					resumed: Boolean(params.resume),
					sessionFile: record!.sessionFile,
					warnings,
					error: message,
				},
			};
		}
	}

	/**
	 * Read terminal output or diagnostics from a persisted session file.
	 */
	static readOutputFromSessionFile(sessionFile: string): string | undefined {
		const extracted = TaskController.extractOutputFromSessionFile(sessionFile);
		return extracted?.text;
	}

	private static extractOutputFromSessionFile(
		sessionFile: string,
	): { text: string; source: "assistant" | "diagnostic" } | undefined {
		try {
			const raw = readFileSync(sessionFile, "utf-8").trim();
			if (!raw) return undefined;
			const messages: any[] = [];
			const lines = raw.split("\n");
			for (const line of lines) {
				try {
					const entry = JSON.parse(line);
					if (entry.type === "message") messages.push(entry.message);
				} catch {
					/* skip malformed lines */
				}
			}
			const extracted = TaskController.extractTerminalOutput(messages);
			if (extracted.source === "assistant" || extracted.source === "diagnostic") {
				return { text: extracted.text, source: extracted.source };
			}
			return undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Wait for one or more previously spawned sub-agents to finish and return
	 * their output.
	 *
	 * For each listed agent ID the result includes a structured status:
	 * - `completed`: finished and output was captured (async or from persisted session)
	 * - `running`: still in-flight at the time of return
	 * - `timed_out_still_running`: was still running when the timeout expired
	 * - `killed`: compatibility status for a timeout escalation that ended in final-summary abort or forced-abort fallback; transcript persists for resume
	 * - `unknown`: the agent ID has no corresponding record
	 *
	 * When multiple IDs are supplied the default behavior is to return as soon
	 * as any listed running agent finishes or the timeout expires.
	 * Already-completed agents cause an immediate return. If opts.wait_all is
	 * true, the call waits until all listed running agents finish or the timeout
	 * expires.
	 *
	 * After async output is consumed any in-memory session resources held only
	 * for that run are disposed; the session file remains on disk for resume.
	 *
	 * @param agentIds  List of hex agent IDs to wait on (required).
	 * @param opts.timeout  Minutes to wait before returning a status update (default 5).
	 * @param opts.wait_all  When true, waits for all listed running agents to finish
	 *   before returning. Default false (return when any finishes).
	 * @param opts.kill_on_timeout  Compatibility-named timeout escalation: request
	 *   a final answer within the same timeout duration, then cancel in-flight work,
	 *   wait briefly for session/tool completion, attempt a no-tools final summary,
	 *   and forcibly abort as the fallback.
	 * @param context  Injected runtime dependencies.
	 */
	async waitForAgent(
		agentIds: string[],
		opts: { timeout?: number; wait_all?: boolean; kill_on_timeout?: boolean },
		context: TaskExecuteContext,
	): Promise<TaskResult> {
		const { metadataStore, sessionManager, runtime } = context;
		const logger = runtime?.logger ?? makeNoopDebugLogger();
		const runLogger = logger.child({
			component: "wait_for_agent",
			runId: createRunCorrelationId("wait"),
		});
		const warnings: string[] = [];

		runLogger.info("wait_for_agent_start", {
			agentCountRequested: agentIds?.length,
			waitAll: opts.wait_all === true,
			killOnTimeout: opts.kill_on_timeout === true,
		});

		// Validate input
		if (!agentIds || agentIds.length === 0) {
			runLogger.warn("wait_for_agent_missing_ids");
			return {
				content: [{ type: "text", text: "wait_for_agent requires at least one agent_id." }],
				details: { warnings, error: "missing_agent_ids" },
			};
		}

		const timeoutMinutes = opts.timeout ?? 5;
		const timeoutMs = timeoutMinutes * 60 * 1000;
		const waitAll = opts.wait_all === true;

		// ---- Helpers ----

		/** Build a single AgentWaitResult for a given agent ID. */
		const buildResult = (agentId: string): AgentWaitResult => {
			return TaskController.toAgentWaitResult(
				TaskController.classifyRunSnapshotFromId(agentId, metadataStore, sessionManager),
			);
		};

		/** Deduplicate IDs while preserving order. */
		const uniqueIds = [...new Set(agentIds)];
		const cancelledWaitResult = (): TaskResult => ({
			content: [
				{ type: "text", text: "wait_for_agent was cancelled; no further timeout escalation will be started." },
			],
			details: {
				warnings,
				error: "wait_cancelled",
				agents: uniqueIds.map(buildResult),
			},
		});
		if (context.signal?.aborted) return cancelledWaitResult();

		const persistAgentTerminalResult = (agent: AgentWaitResult): void => {
			if (agent.status !== "completed" && agent.status !== "killed") {
				return;
			}
			const record = metadataStore.findRecord(agent.id);
			if (!record) {
				return;
			}

			const terminalError = agent.terminalError ?? agent.error;
			const outcome =
				agent.terminalOutcome ||
				(terminalError
					? TaskController.inferTerminalOutcomeFromResult(terminalError, undefined)
					: agent.output
						? "completed"
						: undefined);
			TaskController.persistTerminalOutcome(
				metadataStore,
				record,
				outcome,
				terminalError,
				agent.abortReason,
				agent.contextUsage ?? record.contextUsage,
			);
		};

		const persistTimeoutOutcome = (
			agentId: string,
			terminalOutcome: TerminalOutcome,
			terminalError?: string,
			abortReason?: string,
		): void => {
			const record = metadataStore.findRecord(agentId);
			if (!record) {
				return;
			}
			TaskController.persistTerminalOutcome(metadataStore, record, terminalOutcome, terminalError, abortReason);
		};

		/**
		 * Consume completed / aborted IDs from external state (e.g. pending reminders)
		 * when wait_for_agent has already returned terminal data for them.
		 */
		const consumeTerminalResults = (agents: AgentWaitResult[]) => {
			const completedOrKilled = agents.filter((agent) => agent.status === "completed" || agent.status === "killed");
			if (completedOrKilled.length > 0) {
				runLogger.debug("wait_for_agent_consume_terminal", {
					count: completedOrKilled.length,
				});
				for (const agent of completedOrKilled) {
					persistAgentTerminalResult(agent);
					sessionManager.clearAsyncResult(agent.id);
				}
				if (context.consumeWaitForAgentIds) {
					context.consumeWaitForAgentIds(completedOrKilled.map((agent) => agent.id));
				}
			}
		};

		const formatWaitResult = (agents: AgentWaitResult[]) => {
			consumeTerminalResults(agents);
			return this._formatWaitResult(agents, warnings);
		};

		// ---- First pass: classify all agents ----
		const firstResults = uniqueIds.map(buildResult);
		runLogger.debug("wait_for_agent_initial_classify", {
			agentCount: firstResults.length,
			completedCount: firstResults.filter((r) => r.status === "completed").length,
			runningCount: firstResults.filter((r) => r.status === "running").length,
			unknownCount: firstResults.filter((r) => r.status === "unknown").length,
			timedOutCount: firstResults.filter((r) => r.status === "timed_out_still_running").length,
		});

		const hasTerminalResult = firstResults.some((r) => r.status === "completed" || r.status === "killed");
		const runningIds = firstResults.filter((r) => r.status === "running").map((r) => r.id);

		// If any agent already has terminal output, return immediately unless the
		// caller asked to wait for all remaining running agents.
		if (!waitAll && hasTerminalResult) {
			runLogger.debug("wait_for_agent_returning_terminal", {
				mode: "existing_terminal_fast_path",
				agentCount: firstResults.length,
			});
			return formatWaitResult(firstResults);
		}

		// If no agents are running (all unknown), return immediately.
		if (runningIds.length === 0) {
			runLogger.debug("wait_for_agent_no_running", {
				agentCount: firstResults.length,
			});
			return formatWaitResult(firstResults);
		}

		// ---- Second pass: wait for one or all running agents to finish ----
		try {
			const waitAbortController = new AbortController();
			const waitForReady = (id: string) =>
				(sessionManager.isAsyncRunning(id)
					? sessionManager.waitForAsyncResult(id, waitAbortController.signal)
					: sessionManager.waitForSessionEnd(id, waitAbortController.signal)
				).then(() => id);

			const waitPromises = runningIds.map(waitForReady);
			const waitCompletion = waitAll
				? Promise.all(waitPromises).then(() => "__all_completed__")
				: Promise.race(waitPromises);

			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			const timeoutPromise = new Promise<string>((resolve) => {
				timeoutHandle = setTimeout(() => resolve("__timeout__"), timeoutMs);
			});
			let removeParentAbortListener = () => {};
			const parentCancellation = new Promise<string>((resolve) => {
				if (context.signal?.aborted) {
					resolve("__cancelled__");
					return;
				}
				const onAbort = () => resolve("__cancelled__");
				context.signal?.addEventListener("abort", onAbort, { once: true });
				removeParentAbortListener = () => context.signal?.removeEventListener("abort", onAbort);
			});

			let winner: string;
			try {
				winner = await Promise.race([waitCompletion, timeoutPromise, parentCancellation]);
			} finally {
				if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
				removeParentAbortListener();
				waitAbortController.abort();
			}
			runLogger.debug("wait_for_agent_wait_race", {
				winner,
				waitAll,
				ids: runningIds,
			});
			if (winner === "__cancelled__") return cancelledWaitResult();

			// Yield to the microtask queue so finish() can run storeAsyncResult
			// before we re-classify.
			await new Promise<void>((resolve) => {
				queueMicrotask(resolve);
			});

			if (winner === "__timeout__") {
				if (context.signal?.aborted) return cancelledWaitResult();
				runLogger.warn("wait_for_agent_timed_out", {
					timeoutMs,
					timedIds: runningIds,
				});
				const timeoutResults = uniqueIds.map((id) => {
					const r = buildResult(id);
					if (r.status === "running") {
						persistTimeoutOutcome(id, "timed_out", undefined, "wait_for_agent_timeout");
						return {
							...r,
							status: "timed_out_still_running" as const,
							terminalOutcome: "timed_out" as const,
							abortReason: "wait_for_agent_timeout",
						};
					}
					return r;
				});

				const timedOutIds = timeoutResults.filter((r) => r.status === "timed_out_still_running").map((r) => r.id);

				// If kill_on_timeout is enabled, request a final answer, then move through
				// bounded final-summary/forced-abort fallback if the agent remains running.
				const killOnTimeout = opts.kill_on_timeout === true;
				if (killOnTimeout && timedOutIds.length > 0) {
					if (context.signal?.aborted) return cancelledWaitResult();
					runLogger.warn("wait_for_agent_kill_escalation_started", {
						count: timedOutIds.length,
						windowMinutes: timeoutMinutes,
					});
					// Send a finish request to each timed-out agent.
					for (const id of timedOutIds) {
						if (context.signal?.aborted) return cancelledWaitResult();
						try {
							runLogger.warn("wait_for_agent_soft_kill_sent", { agentId: id });
							sessionManager.sendKillMessage(id, timeoutMinutes);
							persistTimeoutOutcome(id, "timed_out", "Finish request sent.", "wait_for_agent_finish_request");
						} catch (error) {
							persistTimeoutOutcome(
								id,
								"abort_request_failed",
								error instanceof Error ? error.message : String(error),
								"wait_for_agent_soft_kill_failed",
							);
						}
					}

					// Wait for all agents to finish, or for a real result to be stored. An
					// abort_request_failed diagnostic means the finish request was not accepted;
					// keep waiting for original output or the abort window.
					const killAbortController = new AbortController();
					const waitForFinishResult = async (id: string) => {
						await Promise.race([
							sessionManager.waitForSessionEnd(id, killAbortController.signal),
							sessionManager.waitForAsyncResult(id, killAbortController.signal),
						]);
						const result = sessionManager.getAsyncResult(id);
						if (result && result.terminalOutcome !== "abort_request_failed") {
							return id;
						}
						await sessionManager.waitForSessionEnd(id, killAbortController.signal);
						return id;
					};
					const killCompleted = Promise.all(timedOutIds.map(waitForFinishResult)).then(
						() => "__kill_completed__" as const,
					);
					let killTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
					const killTimeoutPromise = new Promise<"__kill_timeout__">((resolve) => {
						killTimeoutHandle = setTimeout(() => resolve("__kill_timeout__"), timeoutMs);
					});
					let removeKillAbortListener = () => {};
					const killCancellation = new Promise<"__cancelled__">((resolve) => {
						if (context.signal?.aborted) {
							resolve("__cancelled__");
							return;
						}
						const onAbort = () => resolve("__cancelled__");
						context.signal?.addEventListener("abort", onAbort, { once: true });
						removeKillAbortListener = () => context.signal?.removeEventListener("abort", onAbort);
					});

					let killResult: "__kill_completed__" | "__kill_timeout__" | "__cancelled__";
					try {
						killResult = await Promise.race([killCompleted, killTimeoutPromise, killCancellation]);
					} finally {
						if (killTimeoutHandle !== undefined) clearTimeout(killTimeoutHandle);
						removeKillAbortListener();
						killAbortController.abort();
					}
					runLogger.debug("wait_for_agent_kill_wait_result", {
						killResult,
					});
					if (killResult === "__cancelled__") return cancelledWaitResult();

					// Track which agents were explicitly forcibly aborted.
					const hardAbortedIds = new Set<string>();

					if (killResult === "__kill_timeout__") {
						runLogger.warn("wait_for_agent_kill_timeout_hit", {
							timedOutIds,
						});
						const stillRunningIds = timedOutIds.filter((id) => {
							const r = buildResult(id);
							return (
								r.status === "running" ||
								r.status === "timed_out_still_running" ||
								(r.terminalOutcome === "abort_request_failed" && sessionManager.hasOpenSession(id))
							);
						});
						const pendingSummaryResults = Promise.all(
							stillRunningIds.map(async (id) => {
								if (!sessionManager.requestAbortSummary) {
									return [
										id,
										{ status: "unavailable", toolOverrideApplied: false } as AbortSummaryResult,
									] as const;
								}
								try {
									const summary = context.signal
										? await sessionManager.requestAbortSummary(id, context.signal)
										: await sessionManager.requestAbortSummary(id);
									return [id, summary] as const;
								} catch (error) {
									return [
										id,
										{
											status: "failed",
											error: error instanceof Error ? error.message : String(error),
											toolOverrideApplied: false,
										} as AbortSummaryResult,
									] as const;
								}
							}),
						);
						let removeSummaryAbortListener = () => {};
						const summaryCancellation = new Promise<"__cancelled__">((resolve) => {
							if (context.signal?.aborted) {
								resolve("__cancelled__");
								return;
							}
							const onAbort = () => resolve("__cancelled__");
							context.signal?.addEventListener("abort", onAbort, { once: true });
							removeSummaryAbortListener = () => context.signal?.removeEventListener("abort", onAbort);
						});
						let summaryResults: Awaited<typeof pendingSummaryResults> | "__cancelled__";
						try {
							summaryResults = await Promise.race([pendingSummaryResults, summaryCancellation]);
						} finally {
							removeSummaryAbortListener();
						}
						if (summaryResults === "__cancelled__" || context.signal?.aborted) {
							return cancelledWaitResult();
						}

						for (const [id, summary] of summaryResults) {
							runLogger.warn("wait_for_agent_abort_summary_result", {
								agentId: id,
								status: summary.status,
								toolOverrideApplied: summary.toolOverrideApplied,
							});
							if (summary.status === "summarized") {
								persistTimeoutOutcome(id, "aborted", undefined, "final_summary");
								continue;
							}
							if (context.signal?.aborted) return cancelledWaitResult();
							try {
								runLogger.warn("wait_for_agent_hard_abort", { agentId: id });
								sessionManager.abortSession(id);
								hardAbortedIds.add(id);
								persistTimeoutOutcome(
									id,
									"aborted",
									"Agent forcibly aborted after timeout.",
									"wait_for_agent_abort_timeout",
								);
							} catch {
								/* best-effort */
							}
						}
						// Yield after aborts so finish() handlers run.
						await new Promise<void>((resolve) => {
							queueMicrotask(resolve);
						});
					}

					// Yield while any pending handlers settle after either completion or timeout.
					await new Promise<void>((resolve) => {
						queueMicrotask(resolve);
					});

					// Re-classify: completed agents stay completed; forcibly aborted agents use the compatibility status.
					const escalationResults = uniqueIds.map((id) => {
						const r = buildResult(id);
						if (hardAbortedIds.has(id)) {
							return {
								...r,
								status: "killed" as const,
								error: r.error ?? "aborted",
								abortReason: "wait_for_agent_abort_timeout",
								terminalOutcome: "aborted" as const,
							};
						}
						return r;
					});
					runLogger.warn("wait_for_agent_kill_results", {
						timedOutCount: timedOutIds.length,
						abortedCount: hardAbortedIds.size,
					});
					return formatWaitResult(escalationResults);
				}

				// Non-escalation path (or no timed-out agents): return immediately
				runLogger.warn("wait_for_agent_timeout_results", {
					timedOutCount: timeoutResults.filter((r) => r.status === "timed_out_still_running").length,
					completedCount: timeoutResults.filter((r) => r.status === "completed").length,
				});
				return formatWaitResult(timeoutResults);
			}

			// An agent finished — re-classify all
			const finalResults = uniqueIds.map((id) => {
				const r = buildResult(id);
				// Still-open sessions that were running remain "running"
				return r;
			});
			runLogger.info("wait_for_agent_final_results", {
				completedCount: finalResults.filter((r) => r.status === "completed").length,
				runningCount: finalResults.filter((r) => r.status === "running").length,
			});
			return formatWaitResult(finalResults);
		} catch (error) {
			if (context.signal?.aborted) return cancelledWaitResult();
			runLogger.error("wait_for_agent_failure", {
				error: error instanceof Error ? error.message : String(error),
			});
			// Best-effort: return whatever we have
			const fallbackResults = uniqueIds.map((id) => {
				try {
					return buildResult(id);
				} catch {
					return { id, status: "unknown" as const };
				}
			});
			return formatWaitResult(fallbackResults);
		}
	}

	/** Format per-agent results into a TaskResult with a human-readable summary. */
	private _formatWaitResult(agents: AgentWaitResult[], warnings: string[]): TaskResult {
		const lines: string[] = [];

		const completed = agents.filter((a) => a.status === "completed");
		const running = agents.filter((a) => a.status === "running");
		const timedOut = agents.filter((a) => a.status === "timed_out_still_running");
		const killed = agents.filter((a) => a.status === "killed");
		const unknown = agents.filter((a) => a.status === "unknown");

		// Top-level details (backwards-compatible with single-agent callers)
		const first = agents[0];
		const topLevel: TaskDetails = { warnings, agents };
		if (first) {
			topLevel.id = first.id;
			topLevel.displayName = first.displayName;
			topLevel.agentType = first.agentType;
			topLevel.sessionFile = first.sessionFile;
			topLevel.terminalOutcome = first.terminalOutcome;
			topLevel.terminalError = first.terminalError;
			topLevel.terminalAt = first.terminalAt;
			topLevel.contextUsage = first.contextUsage;
		}

		const formatDiagnostic = (a: AgentWaitResult): string | undefined => {
			if (a.error) {
				return a.error;
			}
			if (a.terminalError) {
				return a.terminalError;
			}
			return undefined;
		};
		const setWarnings = (a: AgentWaitResult) => {
			topLevel.warnings = [...warnings, ...(a.warnings ?? [])];
		};

		if (agents.length === 1) {
			// Single-agent: use the old-style detailed output for backwards compat
			const a = agents[0];
			const displayName = a.displayName || a.agentType || a.id;
			const outcome = a.terminalOutcome;
			const terminalSummary = formatDiagnostic(a);
			const noFinalOutputSummary =
				terminalSummary && !/^(aborted|killed)$/i.test(terminalSummary)
					? terminalSummary
					: "No final assistant output was captured.";
			const contextLine = formatContextUsageLine(a.contextUsage);
			if (a.status === "completed") {
				if (outcome === "aborted") {
					topLevel.error = terminalSummary ?? "sub-agent terminated before producing final output.";
					topLevel.abortReason = a.abortReason;
					setWarnings(a);
					if (a.output) {
						topLevel.output = a.output;
						lines.push(
							`${displayName} (${a.id}) was aborted before producing a final assistant result. The transcript was preserved. Use resume: "${a.id}" to continue this agent.`,
						);
						lines.push(contextLine);
						lines.push("");
						lines.push(a.output);
					} else {
						lines.push(
							`${displayName} (${a.id}) was aborted before producing a final assistant result. The transcript was preserved. Use resume: "${a.id}" to continue this agent.`,
						);
						lines.push(contextLine);
						lines.push("");
						lines.push(noFinalOutputSummary);
					}
				} else if (outcome === "abort_request_failed") {
					topLevel.error = terminalSummary ?? "Unable to queue a request to finish the run.";
					topLevel.abortReason = a.abortReason;
					setWarnings(a);
					lines.push(
						`${displayName} (${a.id}) could not queue the finish request. The transcript was preserved and can be resumed with resume: "${a.id}".`,
					);
					lines.push(contextLine);
					lines.push("");
					lines.push(a.output || "No final assistant output was captured.");
					if (terminalSummary && terminalSummary !== a.output) {
						lines.push("");
						lines.push(terminalSummary);
					}
				} else if (outcome === "crashed") {
					if (a.output) {
						lines.push(
							`${displayName} (${a.id}) stopped with an error after producing partial output. Use resume: "${a.id}" to retry or continue this agent.`,
						);
						lines.push(contextLine);
						lines.push("");
						lines.push(a.output);
						topLevel.output = a.output;
					} else {
						lines.push(
							`${displayName} (${a.id}) stopped with an error before producing output. Use resume: "${a.id}" to retry or continue this agent.`,
						);
						lines.push(contextLine);
						lines.push("");
						lines.push(terminalSummary || "No final assistant output was captured.");
					}
					topLevel.error = terminalSummary || "sub-agent stopped unexpectedly.";
					topLevel.abortReason = a.abortReason;
					setWarnings(a);
				} else if (outcome === "timed_out") {
					topLevel.error = terminalSummary;
					topLevel.abortReason = a.abortReason;
					setWarnings(a);
					lines.push(
						`${displayName} (${a.id}) timed out. The transcript was preserved and can be resumed with resume: "${a.id}".`,
					);
					lines.push(contextLine);
					lines.push("");
					lines.push(a.output || terminalSummary || "No final assistant output was captured.");
				} else if (!a.output) {
					setWarnings(a);
					lines.push(
						`${displayName} (${a.id}) is no longer running, but no final assistant output was captured. The transcript was preserved and can be resumed with resume: "${a.id}".`,
					);
					lines.push(contextLine);
					lines.push("");
					lines.push("No final assistant output was captured.");
				} else {
					setWarnings(a);
					topLevel.output = a.output;
					lines.push(`${displayName} (${a.id}) completed. Use resume: "${a.id}" to continue this agent.`);
					lines.push(contextLine);
					lines.push("");
					lines.push(a.output);
				}
			} else if (a.status === "running") {
				if (a.terminalOutcome === "timed_out") {
					lines.push(
						`${displayName} (${a.id}) timed out while still running. No final assistant output captured yet.`,
					);
				} else {
					lines.push(
						`${displayName} (${a.id}) is still running. No final assistant output captured yet. Call wait_for_agent again to check.`,
					);
				}
			} else if (a.status === "timed_out_still_running") {
				lines.push(
					`${displayName} (${a.id}) timed out while still running and produced no final assistant output. Call wait_for_agent again to check.`,
				);
			} else if (a.status === "killed") {
				topLevel.error = a.error ?? "aborted";
				topLevel.abortReason = a.abortReason;
				topLevel.output = a.output;
				setWarnings(a);
				const output = a.output;
				if (output && output.length > 0) {
					lines.push(
						`${displayName} (${a.id}) was aborted while still running. Partial output may be available. The transcript was preserved. Use resume: "${a.id}" to continue this agent.`,
					);
					lines.push(contextLine);
					lines.push("");
					lines.push(output);
				} else {
					lines.push(
						`${displayName} (${a.id}) was aborted while still running. No final assistant output was captured. The transcript was preserved. Use resume: "${a.id}" to continue this agent.`,
					);
					lines.push(contextLine);
					const fallback = noFinalOutputSummary;
					if (fallback) {
						lines.push("");
						lines.push(fallback);
					}
				}
			} else {
				topLevel.error = "unknown_agent_id";
				lines.push(`Unknown agent ID "${a.id}".`);
			}
		} else {
			// Multi-agent: structured summary
			lines.push(`wait_for_agent results for ${agents.length} agent(s):`);

			if (completed.length > 0) {
				lines.push(`
## Completed (${completed.length})`);
				for (const a of completed) {
					const name = a.displayName || a.agentType || a.id;
					const state = a.output
						? a.terminalOutcome && a.terminalOutcome !== "completed"
							? a.terminalOutcome
							: "completed"
						: a.terminalOutcome && a.terminalOutcome !== "completed"
							? a.terminalOutcome
							: "no final output";
					lines.push(`- ${name} (${a.id}) [${state}]`);
					lines.push(`  ${formatContextUsageLine(a.contextUsage)}`);
					if (a.error) {
						lines.push(`  Error: ${a.error}`);
					} else if (a.output) {
						lines.push(`  ${a.output}`);
					} else {
						lines.push(`  No final assistant output was captured. Transcript preserved; use resume: "${a.id}".`);
					}
				}
			}

			if (running.length > 0) {
				lines.push(`
## Still Running (${running.length})`);
				for (const a of running) {
					const name = a.displayName || a.agentType || a.id;
					lines.push(`- ${name} (${a.id})`);
				}
			}

			if (timedOut.length > 0) {
				lines.push(`
## Timed Out, Still Running (${timedOut.length})`);
				for (const a of timedOut) {
					const name = a.displayName || a.agentType || a.id;
					lines.push(`- ${name} (${a.id})`);
				}
			}

			if (killed.length > 0) {
				lines.push(`
## Aborted (${killed.length})`);
				for (const a of killed) {
					const name = a.displayName || a.agentType || a.id;
					lines.push(`- ${name} (${a.id}) [transcript saved, resumable]`);
					lines.push(`  ${formatContextUsageLine(a.contextUsage)}`);
				}
			}

			if (unknown.length > 0) {
				lines.push(`
## Unknown IDs (${unknown.length})`);
				for (const a of unknown) {
					lines.push(`- ${a.id}`);
				}
			}
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: topLevel,
		};
	}
}
