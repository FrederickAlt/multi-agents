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
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { DefaultResourceLoader, Model } from "@mariozechner/pi-coding-agent";
import type {
	AgentConfig,
	AgentDiagnostic,
} from "./agents.js";
import { formatAgentList } from "./agents.js";
import {
	type DepthPolicyState,
	checkTaskAllowed,
	childPolicy,
} from "./depth-policy.js";
import type { MetadataFile, MetadataStore, SubagentRecord } from "./metadata.js";
import type {
	ModelResolver,
	SessionSetupContext,
} from "./session-manager.js";
import {
	FINAL_RESPONSE_REQUIRED_MAX_ATTEMPTS,
	FINAL_RESPONSE_REQUIRED_MESSAGE,
	extractOutput,
	extractTerminalOutput,
	getFinalTextFromMessages,
} from "./output-extraction.js";
import {
	createRunCorrelationId,
	makeNoopDebugLogger,
} from "./debug-logger.js";

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
	disposeSession(id: string): void;
	/**
	 * Wait for a tracked session to reach `agent_end`, resolving when the
	 * agent finishes. Resolves immediately if the session already ended
	 * or is no longer tracked.
	 */
	waitForSessionEnd(id: string): Promise<void>;
	/** Store the output/error result of a completed async session. */
	storeAsyncResult(id: string, result: { output: string; error?: string; warnings: string[]; abortReason?: string }): void;
	/** Finalize async completion and apply lifecycle transitions and cleanup. */
	finalizeAsyncRun(
		id: string,
		result: { output: string; error?: string; warnings: string[]; abortReason?: string },
		options?: { allowOverwrite?: boolean },
	): void;
	/** Retrieve a previously stored async result. */
	getAsyncResult(id: string): { output: string; error?: string; warnings: string[]; abortReason?: string } | undefined;
	/** Wait until a completed async session result has been stored. */
	waitForAsyncResult(id: string, signal?: AbortSignal): Promise<void>;
	/** Clear a consumed async result from memory. */
	clearAsyncResult(id: string): void;
	/** Mark a session as having an in-flight async prompt. */
	markAsyncRunning(id: string): void;
	/** Check whether a session has an in-flight async prompt. */
	isAsyncRunning(id: string): boolean;
	/** Check whether a tracked session has already reached agent_end. */
	isCompleted(id: string): boolean;
	/** Check if there is an open session for the given record ID. */
	hasOpenSession(id: string): boolean;
	/**
	 * Send a soft-kill instruction to a running async session.
	 * Aborts the current prompt, then sends a kill message as a new prompt
	 * giving the agent one more turn to produce a final answer.
	 */
	sendKillMessage(id: string, timeoutMinutes: number): void;
	/**
	 * Hard-abort a session immediately.
	 * The transcript persists on disk for later resume.
	 */
	abortSession(id: string): void;
	/**
	 * Check whether a kill flow (soft-kill or hard-abort) is in progress for the
	 * given session ID.
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
	fallbackModel?: Model;
	modelRegistry?: any;
	createResourceLoaderFactory: (
		agent: AgentConfig,
		childRuntime: RuntimeContext,
	) => Promise<DefaultResourceLoader>;
	/** Optional streaming update callback (used for progress emission). */
	onUpdate?: (partial: TaskResult) => void;
	/**
	 * Optional callback to consume terminal wait_for_agent IDs (completed / killed)
	 * from external notification tracking systems.
	 */
	consumeWaitForAgentIds?: (agentIds: string[]) => void;
}

/** Status of a single agent within a wait_for_agent result. */
export type AgentWaitStatus = 'completed' | 'running' | 'timed_out_still_running' | 'killed' | 'unknown';

/** Internal run-state used to classify Agent runs consistently for Task and wait_for_agent. */
type AgentRunState =
	| 'result_ready_memory'
	| 'result_ready_transcript'
	| 'running_async'
	| 'running_open'
	| 'killed'
	| 'unknown';

interface AgentRunSnapshot {
	id: string;
	displayName?: string;
	agentType?: string;
	sessionFile?: string;
	state: AgentRunState;
	output?: string;
	error?: string;
	abortReason?: string;
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

// ---------------------------------------------------------------------------
// TaskController
// ---------------------------------------------------------------------------

export class TaskController {
	// ---- Static utility methods ----

	/**
	 * Check whether tasking `agentName` is allowed given the current
	 * depth-policy state.
	 *
	 * @deprecated Prefer {@link checkTaskAllowed} from depth-policy.js.
	 */
	static checkSpawnAllowed(
		runtime: { depth: number; rootMaxDepth: number; can_spawn: string[] | undefined },
		agentName: string,
	): { allowed: boolean; error?: string; code?: string } {
		return checkTaskAllowed(
			{
				treeDepth: runtime.depth,
				rootDepthLimit: runtime.rootMaxDepth,
				localDepthLimit: runtime.rootMaxDepth, // old impl ignores local depth
				can_spawn: runtime.can_spawn,
			},
			agentName,
		);
	}

	/**
	 * Resolve the AgentConfig (and optionally a SubagentRecord for
	 * resume) from the task parameters and metadata store.
	 */
	static resolveTaskAgent(
		params: { subagent_type: string; resume?: string },
		store: MetadataFile,
		agents: AgentConfig[],
	):
		| { ok: true; record?: SubagentRecord; agent: AgentConfig }
		| { ok: false; errorText: string; errorCode: string } {
		let record: SubagentRecord | undefined;
		let agent: AgentConfig | undefined;

		if (params.resume) {
			record = store.records.find((item) => item.id === params.resume);
			if (!record) {
				const known =
					store.records
						.map((item) => `${item.id} (${item.displayName})`)
						.join(", ") || "none";
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

	// Re-exported from shared module for backward compatibility.
	static getFinalTextFromMessages = getFinalTextFromMessages;
	static extractOutput = extractOutput;
	static extractTerminalOutput = extractTerminalOutput;

	private static async _ensureFinalResponse(session: any): Promise<{ text: string; source: 'assistant' | 'diagnostic' | 'none' }> {
		let terminal = extractTerminalOutput(session.messages as any[]);
		for (let attempt = 0; terminal.source === 'none' && attempt < FINAL_RESPONSE_REQUIRED_MAX_ATTEMPTS; attempt++) {
			await session.prompt(FINAL_RESPONSE_REQUIRED_MESSAGE);
			terminal = extractTerminalOutput(session.messages as any[]);
		}
		return terminal;
	}

	/**
	 * Classify a single sub-agent run from stored metadata and session state.
	 */
	private static classifyRunSnapshot(record: SubagentRecord, sessionManager: SessionAdapter): AgentRunSnapshot {
		const base: Omit<AgentRunSnapshot, 'state' | 'output' | 'error' | 'abortReason' | 'warnings'> = {
			id: record.id,
			displayName: record.displayName,
			agentType: record.agentType,
			sessionFile: record.sessionFile,
		};

		const asyncResult = sessionManager.getAsyncResult(record.id);
		if (asyncResult) {
			return {
				...base,
				state: asyncResult.error === 'killed' ? 'killed' : 'result_ready_memory',
				output: asyncResult.output,
				error: asyncResult.error,
				abortReason: asyncResult.abortReason,
				warnings: asyncResult.warnings,
			};
		}

		if (sessionManager.isAsyncRunning(record.id)) {
			return { ...base, state: 'running_async' };
		}

		if (sessionManager.isCompleted(record.id)) {
			const persisted = TaskController.extractOutputFromSessionFile(record.sessionFile);
			return {
				...base,
				state: 'result_ready_transcript',
				...(persisted ? { output: persisted.text } : {}),
				...(persisted?.source === 'diagnostic' ? { error: persisted.text } : {}),
			};
		}

		if (sessionManager.hasOpenSession(record.id)) {
			return { ...base, state: 'running_open' };
		}

		if (record.sessionFile) {
			const persisted = TaskController.extractOutputFromSessionFile(record.sessionFile);
			if (persisted !== undefined) {
				return {
					...base,
					state: 'result_ready_transcript',
					...(persisted ? { output: persisted.text } : {}),
					...(persisted.source === 'diagnostic' ? { error: persisted.text } : {}),
				};
			}
			// Session file exists but has no assistant text or error diagnostic.
			return { ...base, state: 'result_ready_transcript' };
		}

		return { id: record.id, state: 'unknown' };
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
			return { id: agentId, state: 'unknown' };
		}

		return TaskController.classifyRunSnapshot(record, sessionManager);
	}

	private static toAgentWaitResult(snapshot: AgentRunSnapshot): AgentWaitResult {
		if (snapshot.state === 'running_async' || snapshot.state === 'running_open') {
			return {
				id: snapshot.id,
				displayName: snapshot.displayName,
				agentType: snapshot.agentType,
				status: 'running',
				sessionFile: snapshot.sessionFile,
			};
		}

		if (snapshot.state === 'killed') {
			return {
				id: snapshot.id,
				displayName: snapshot.displayName,
				agentType: snapshot.agentType,
				status: 'killed',
				output: snapshot.output,
				error: snapshot.error,
				abortReason: snapshot.abortReason,
				warnings: snapshot.warnings,
				sessionFile: snapshot.sessionFile,
			};
		}

		if (snapshot.state === 'result_ready_memory' || snapshot.state === 'result_ready_transcript') {
			return {
				id: snapshot.id,
				displayName: snapshot.displayName,
				agentType: snapshot.agentType,
				status: 'completed',
				output: snapshot.output,
				error: snapshot.error,
				abortReason: snapshot.abortReason,
				warnings: snapshot.warnings,
				sessionFile: snapshot.sessionFile,
			};
		}

		return { id: snapshot.id, status: 'unknown' };
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
	async execute(
		params: TaskExecuteParams,
		context: TaskExecuteContext,
	): Promise<TaskResult> {
		const effectiveCwd = params.cwd || context.cwd;
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
			blocking: params.blocking !== false,
			cwdLength: effectiveCwd.length,
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
		let record = resolved.record;

		// c. Check task permission via DepthPolicy
		const taskCheck = checkTaskAllowed(runtime.depthPolicy, agent.name);
		if (!taskCheck.allowed) {
			runLogger.warn("task_depth_policy_rejected", {
				agentType: agent.name,
				reason: taskCheck.code,
				maxDepth: runtime.depthPolicy.maxDepth,
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
				record = await metadataStore.allocateRecord(
					agent.name,
					runtime.parentAgentId,
					runtime.treeDepth + 1,
				);
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
					if (!params.resume || (snapshot.state !== 'result_ready_memory' && snapshot.state !== 'killed')) {
						return undefined;
					}
					runLogger.warn("task_resume_blocked_unconsumed_result", {
						recordId: record?.id,
						runState: snapshot.state,
					});
					return {
						content: [{ type: "text", text: `${record!.displayName} (${record!.id}) has completed async output waiting to be consumed. Use wait_for_agent with agent_id "${record!.id}" before resuming it again.` }],
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

				// Obtain the resource loader via the injected factory
				let resourceLoader: DefaultResourceLoader;
				try {
					resourceLoader = await createResourceLoaderFactory(agent, childRuntime);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `${record!.displayName} (${record!.id}) failed to initialise resource loader. Use resume: "${record!.id}" to retry.\n\n${message}` }],
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
					agentModel: agent.model || "default",
					agentToolNames: agent.tools ? agent.tools.length : undefined,
				});
				try {
					session = await sessionManager.getOrCreateSession(
						record!,
						agent,
						warnings,
						{
							metadataStore: metadataStore as MetadataStore,
							cwd: effectiveCwd,
							fallbackModel,
							modelResolver,
							modelRegistry,
							createResourceLoader: async () => resourceLoader,
						},
					);
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
						content: [{ type: "text", text: `${record!.displayName} (${record!.id}) failed to create session. Use resume: "${record!.id}" to retry.\n\n${message}` }],
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
						try { sessionManager.disposeSession(record!.id); } catch { /* best-effort cleanup for rejected setup */ }
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
					if (params.resume && runSnapshot.state === 'running_async') {
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
								content: [{ type: "text", text: `${record!.displayName} (${record!.id}) is finalizing its async result and cannot be steered. Use wait_for_agent with agent_id "${record!.id}" to retrieve output, then resume it again if more work is needed.` }],
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
							return {
								content: [{ type: "text", text: `${record!.displayName} (${record!.id}) failed to queue steering message. Use wait_for_agent with agent_id "${record!.id}" to retrieve output from the original run.\n\n${message}` }],
								details: {
									id: record!.id,
									displayName: record!.displayName,
									agentType: record!.agentType,
									description: params.description,
									resumed: true,
									sessionFile: record!.sessionFile,
									warnings,
									error: message,
								},
							};
						}
					}

					// Async path: start prompt in background, return immediately.
					// The session stays tracked; `wait_for_agent` retrieves output later.
					sessionManager.markAsyncRunning(record!.id);
					runLogger.debug("task_async_marked_running", {
					recordId: record!.id,
				});

					const abort = () => {
						runLogger.warn("task_async_signal_abort", { recordId: record!.id });
						void session?.abort();
					};
					if (context.signal?.aborted) abort();
					else context.signal?.addEventListener("abort", abort, { once: true });

					const finish = (
						resolved: boolean,
						errorMessage: string | undefined,
						terminal?: { text: string; source: 'assistant' | 'diagnostic' | 'none' },
					) => {
						context.signal?.removeEventListener("abort", abort);
						try { metadataStore.touchRecord(record!.id); } catch { /* best-effort */ }
						if (resolved) {
							const extracted = terminal ?? TaskController.extractTerminalOutput(session.messages as any[]);
							sessionManager.finalizeAsyncRun(record!.id, {
								output: extracted.text,
								...(extracted.source === 'diagnostic' ? { error: extracted.text } : {}),
								warnings,
							});
							runLogger.info("task_async_completed", {
								recordId: record!.id,
								outputLength: extracted.text.length,
								hasError: extracted.source === 'diagnostic',
							});
						} else {
							const extracted = TaskController.extractOutput(session.messages as any[], errorMessage);
							sessionManager.finalizeAsyncRun(record!.id, {
								output: extracted.text,
								error: errorMessage,
								warnings,
							});
							runLogger.warn("task_async_failed", {
								recordId: record!.id,
								error: errorMessage,
								outputLength: extracted.text.length,
							});
						}
					};

					Promise.resolve()
						.then(() => session.prompt(params.prompt))
						.then(() => TaskController._ensureFinalResponse(session))
						.then(
							(terminal) => finish(true, undefined, terminal),
							(err: unknown) => {
								const message = err instanceof Error ? err.message : String(err);
								finish(false, message);
							},
						);

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
				const clearRuntimeTimeout = () => {
					if (runtimeTimeoutHandle !== undefined) {
						clearTimeout(runtimeTimeoutHandle);
						runtimeTimeoutHandle = undefined;
					}
				};
				const abortTask = () => {
					clearRuntimeTimeout();
					void session?.abort();
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

					try {
						emit(`${record!.displayName} (${record!.id}) running...`);

						// Guard against double-prompt when async is already in-flight
						const runSnapshot = TaskController.classifyRunSnapshot(record!, sessionManager);
						if (runSnapshot.state === 'running_async') {
							runLogger.warn("task_blocking_rejected_async_in_flight", {
								recordId: record!.id,
							});
							return {
								content: [{ type: "text", text: `${record!.displayName} (${record!.id}) is still running asynchronously. Use wait_for_agent with agent_id "${record!.id}" to retrieve output.` }],
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

						const promptRace = [] as Array<
							Promise<
								| { type: "completed"; terminal: { text: string; source: 'assistant' | 'diagnostic' | 'none' } }
								| { type: "failed"; error: unknown }
								| { type: "timeout" }
								| { type: "aborted" }
							>
						>;
						if (!context.signal?.aborted) {
							const promptResult = Promise.resolve()
								.then(() => session.prompt(params.prompt))
								.then(() => TaskController._ensureFinalResponse(session))
								.then(
									(terminal) => ({ type: "completed" as const, terminal }),
									(error: unknown) => ({ type: "failed" as const, error }),
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
							const message =
								`Task execution exceeded the ${DEFAULT_TASK_RUNTIME_TIMEOUT_MINUTES}-minute runtime limit. Use resume: "${record!.id}" to continue this agent.`;
							const warningText =
								warnings.length > 0
									? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`
								: "";
							return {
								content: [{ type: "text", text: `${record!.displayName} (${record!.id}) timed out. ${message}${warningText}` }],
								details: {
									id: record!.id,
									displayName: record!.displayName,
									agentType: record!.agentType,
									description: params.description,
									resumed: Boolean(params.resume),
									sessionFile: record!.sessionFile,
									warnings,
									error: TASK_RUNTIME_TIMEOUT_ERROR_CODE,
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
								error: promptOrTimeout.error instanceof Error ? promptOrTimeout.error.message : String(promptOrTimeout.error),
							});
							throw promptOrTimeout.error;
						}

						if (promptOrTimeout.terminal.source === 'diagnostic') {
							runLogger.warn("task_blocking_diagnostic", {
								recordId: record!.id,
								outputLength: promptOrTimeout.terminal.text.length,
							});
							throw new Error(promptOrTimeout.terminal.text || "The sub-agent stopped with a diagnostic.");
						}

						const output = promptOrTimeout.terminal.text;
						runLogger.info("task_blocking_completed", {
							recordId: record!.id,
							outputLength: output.length,
							hasWarnings: warnings.length > 0,
						});
						const header = `${record!.displayName} (${record!.id}) completed. Use resume: "${record!.id}" to continue this agent.`;
						const warningText =
							warnings.length > 0
								? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`
								: "";
						return {
							content: [
								{
									type: "text",
									text: `${header}\n\n${output || "(no output)"}${warningText}`,
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
								output,
							},
						};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					runLogger.error("task_blocking_crashed", {
						recordId: record!.id,
						error: message,
						outputLength: session?.messages?.length,
					});
					const extracted = TaskController.extractOutput(session.messages as any[], message);
					const warningText =
						warnings.length > 0
							? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`
							: "";
					let contentText: string;
					if (extracted.source === 'assistant') {
						contentText = `${record!.displayName} (${record!.id}) crashed but produced partial output. Use resume: "${record!.id}" to retry or continue.\n\n${extracted.text}${warningText}`;
					} else if (extracted.source === 'diagnostic') {
						contentText = `${record!.displayName} (${record!.id}) crashed. Use resume: "${record!.id}" to retry or continue this agent.\n\n${extracted.text}${warningText}`;
					} else {
						contentText = `${record!.displayName} (${record!.id}) crashed. Use resume: "${record!.id}" to retry or continue this agent.\n\nThe sub-agent stopped without producing any output.${warningText}`;
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
							error: message,
							...(extracted.source === 'assistant' ? { output: extracted.text } : {}),
						},
					};
				} finally {
					runLogger.debug("task_blocking_completed_cleanup", { recordId: record!.id });
					if (context.signal && onAbort) {
						context.signal.removeEventListener("abort", onAbort);
					}
					clearRuntimeTimeout();
					try { metadataStore.touchRecord(record!.id); } catch { /* best-effort */ }
					try { sessionManager.disposeSession(record!.id); } catch { /* may already be disposed */ }
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
				content: [{ type: "text", text: `${record!.displayName} (${record!.id}) failed during execution: ${message}` }],
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
	): { text: string; source: 'assistant' | 'diagnostic' } | undefined {
		try {
			const raw = readFileSync(sessionFile, "utf-8").trim();
			if (!raw) return undefined;
			const messages: any[] = [];
			const lines = raw.split("\n");
			for (const line of lines) {
				try {
					const entry = JSON.parse(line);
					if (entry.type === "message") messages.push(entry.message);
				} catch { /* skip malformed lines */ }
			}
			const extracted = TaskController.extractTerminalOutput(messages);
			return extracted.source === "none" ? undefined : extracted;
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
	 * - `killed`: hard-aborted after soft-kill window expired; transcript persists for resume
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
	 * @param opts.kill_on_timeout  When true, on timeout sends a soft-kill instruction to
	 *   each still-running agent to finish within the same timeout duration.
	 *   Agents that don't finish in that kill window are hard-aborted.
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

		/**
		 * Consume completed / killed IDs from external state (e.g. pending reminders)
		 * when wait_for_agent has already returned terminal data for them.
		 */
		const consumeTerminalResults = (agents: AgentWaitResult[]) => {
			const completedOrKilled = agents
				.filter((agent) => agent.status === "completed" || agent.status === "killed")
				.map((agent) => agent.id);
			if (completedOrKilled.length > 0) {
				runLogger.debug("wait_for_agent_consume_terminal", {
					count: completedOrKilled.length,
				});
				for (const id of completedOrKilled) {
					sessionManager.clearAsyncResult(id);
				}
				if (context.consumeWaitForAgentIds) {
					context.consumeWaitForAgentIds(completedOrKilled);
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

		const hasTerminalResult = firstResults.some(r => r.status === "completed" || r.status === "killed");
		const runningIds = firstResults
			.filter(r => r.status === "running")
			.map(r => r.id);

		// If any agent already has terminal output, return immediately unless the
		// caller asked to wait for all remaining running agents.
		if (!waitAll && hasTerminalResult) {
			runLogger.debug("wait_for_agent_returning_terminal", {
				mode: "existing_terminal_fast_path",
				agentCount: firstResults.length,
			});
			// Consume async results so in-memory resources are released
			for (const r of firstResults) {
				if (r.status === "completed") {
					sessionManager.clearAsyncResult(r.id);
				}
			}
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
			const waitForReady = (id: string) => (
				sessionManager.isAsyncRunning(id)
					? sessionManager.waitForAsyncResult(id, waitAbortController.signal)
					: sessionManager.waitForSessionEnd(id)
			).then(() => id);

			const waitPromises = runningIds.map(waitForReady);
			const waitCompletion = waitAll
				? Promise.all(waitPromises).then(() => "__all_completed__")
				: Promise.race(waitPromises);

			const timeoutPromise = new Promise<string>((resolve) => {
				setTimeout(() => resolve("__timeout__"), timeoutMs);
			});

			const winner = await Promise.race([waitCompletion, timeoutPromise]);
			runLogger.debug("wait_for_agent_wait_race", {
				winner,
				waitAll,
				ids: runningIds,
			});
			waitAbortController.abort();

			// Yield to the microtask queue so finish() can run storeAsyncResult
			// before we re-classify.
			await new Promise<void>((resolve) => { queueMicrotask(resolve); });

			if (winner === "__timeout__") {
				runLogger.warn("wait_for_agent_timed_out", {
					timeoutMs,
					timedIds: runningIds,
				});
				const timeoutResults = uniqueIds.map(id => {
					const r = buildResult(id);
					if (r.status === "running") {
						return { ...r, status: "timed_out_still_running" as const };
					}
					return r;
				});

				// If kill_on_timeout is enabled, escalate to soft-kill then hard-abort.
				// Wait for all timed-out agents to finish OR until the kill window ends.
				const killOnTimeout = opts.kill_on_timeout === true;
				if (killOnTimeout) {
					const timedOutIds = timeoutResults
						.filter(r => r.status === "timed_out_still_running")
						.map(r => r.id);

					if (timedOutIds.length > 0) {
						runLogger.warn("wait_for_agent_kill_escalation_started", {
							count: timedOutIds.length,
							windowMinutes: timeoutMinutes,
						});
						// Send soft-kill instruction to each timed-out agent.
						for (const id of timedOutIds) {
							try {
								runLogger.warn("wait_for_agent_soft_kill_sent", { agentId: id });
								sessionManager.sendKillMessage(id, timeoutMinutes);
							} catch { /* best-effort */ }
						}

						// Wait for all agents to finish, or force kill when the window expires.
						const killAbortController = new AbortController();
						const killCompleted = Promise.all(
							timedOutIds.map((id) => sessionManager.waitForAsyncResult(id, killAbortController.signal).then(() => id)),
						).then(() => "__kill_completed__" as const);
						const killTimeoutPromise = new Promise<"__kill_timeout__">((resolve) => {
							setTimeout(() => resolve("__kill_timeout__"), timeoutMs);
						});

						const killResult = await Promise.race([killCompleted, killTimeoutPromise]);
						runLogger.debug("wait_for_agent_kill_wait_result", {
							killResult,
						});
						killAbortController.abort();

						// Track which agents were explicitly hard-aborted.
						const hardAbortedIds = new Set<string>();

						if (killResult === "__kill_timeout__") {
							runLogger.warn("wait_for_agent_kill_timeout_hit", {
								timedOutIds,
							});
							// Kill window expired — hard-abort still-running agents.
							for (const id of timedOutIds) {
								const r = buildResult(id);
								if (r.status === "running" || r.status === "timed_out_still_running") {
									try {
										runLogger.warn("wait_for_agent_hard_abort", { agentId: id });
										sessionManager.abortSession(id);
										hardAbortedIds.add(id);
									} catch { /* best-effort */ }
								}
							}
							// Yield after aborts so finish() handlers run.
							await new Promise<void>((resolve) => { queueMicrotask(resolve); });
						}

						// Yield while any pending handlers settle after either completion or timeout.
						await new Promise<void>((resolve) => { queueMicrotask(resolve); });

						// Re-classify: completed agents stay completed; hard-aborted agents become killed.
						const escalationResults = uniqueIds.map((id) => {
							const r = buildResult(id);
							if (hardAbortedIds.has(id)) {
								return {
									...r,
									status: "killed" as const,
									error: r.error ?? "killed",
									abortReason: "wait_for_agent_kill_timeout",
								};
							}
							return r;
						});
						runLogger.warn("wait_for_agent_kill_results", {
							timedOutCount: timedOutIds.length,
							killedCount: hardAbortedIds.size,
						});
						for (const r of escalationResults) {
							if (r.status === "completed") {
								sessionManager.clearAsyncResult(r.id);
							}
						}
						return formatWaitResult(escalationResults);
					}
				}

				// Non-escalation path (or no timed-out agents): return immediately
				for (const r of timeoutResults) {
					if (r.status === "completed") {
						sessionManager.clearAsyncResult(r.id);
					}
				}
				runLogger.warn("wait_for_agent_timeout_results", {
					timedOutCount: timeoutResults.filter((r) => r.status === "timed_out_still_running").length,
					completedCount: timeoutResults.filter((r) => r.status === "completed").length,
				});
				return formatWaitResult(timeoutResults);
			}

			// An agent finished — re-classify all
			const finalResults = uniqueIds.map(id => {
				const r = buildResult(id);
				// Still-open sessions that were running remain "running"
				return r;
			});
			runLogger.info("wait_for_agent_final_results", {
				completedCount: finalResults.filter((r) => r.status === "completed").length,
				runningCount: finalResults.filter((r) => r.status === "running").length,
			});
			for (const r of finalResults) {
				if (r.status === "completed") {
					sessionManager.clearAsyncResult(r.id);
				}
			}
			return formatWaitResult(finalResults);
		} catch (error) {
			runLogger.error("wait_for_agent_failure", {
				error: error instanceof Error ? error.message : String(error),
			});
			// Best-effort: return whatever we have
			const fallbackResults = uniqueIds.map(id => {
				try { return buildResult(id); } catch {
					return { id, status: "unknown" as const };
				}
			});
			return formatWaitResult(fallbackResults);
		}
	}

	/** Format per-agent results into a TaskResult with a human-readable summary. */
	private _formatWaitResult(
		agents: AgentWaitResult[],
		warnings: string[],
	): TaskResult {
		const lines: string[] = [];

		const completed = agents.filter(a => a.status === "completed");
		const running = agents.filter(a => a.status === "running");
		const timedOut = agents.filter(a => a.status === "timed_out_still_running");
		const killed = agents.filter(a => a.status === "killed");
		const unknown = agents.filter(a => a.status === "unknown");

		// Top-level details (backwards-compatible with single-agent callers)
		const first = agents[0];
		const topLevel: TaskDetails = { warnings, agents };
		if (first) {
			topLevel.id = first.id;
			topLevel.displayName = first.displayName;
			topLevel.agentType = first.agentType;
			topLevel.sessionFile = first.sessionFile;
		}

		if (agents.length === 1) {
			// Single-agent: use the old-style detailed output for backwards compat
			const a = agents[0];
			const displayName = a.displayName || a.agentType || a.id;
			if (a.status === "completed") {
				if (a.error !== undefined) {
					topLevel.error = a.error;
					topLevel.abortReason = a.abortReason;
					topLevel.warnings = [...warnings, ...(a.warnings ?? [])];
					const hasPartialOutput = a.output && a.output.length > 0 && a.output !== a.error;
					if (hasPartialOutput) {
						topLevel.output = a.output;
						lines.push(`${displayName} (${a.id}) crashed but produced partial output. Use resume: "${a.id}" to retry or continue this agent.`);
						lines.push("");
						lines.push(a.error);
						lines.push("");
						lines.push(a.output);
					} else {
						lines.push(`${displayName} (${a.id}) crashed. Use resume: "${a.id}" to retry or continue this agent.`);
						lines.push("");
						lines.push(a.error || "The sub-agent stopped without producing any output.");
					}
				} else {
					topLevel.output = a.output;
					topLevel.warnings = [...warnings, ...(a.warnings ?? [])];
					lines.push(`${displayName} (${a.id}) completed. Use resume: "${a.id}" to continue this agent.`);
					if (a.output) {
						lines.push("");
						lines.push(a.output);
					} else if (!a.output) {
						lines.push("");
						lines.push("(no output)");
					}
				}
			} else if (a.status === "running") {
				lines.push(`${displayName} (${a.id}) is still running. Call wait_for_agent again to check.`);
			} else if (a.status === "timed_out_still_running") {
				lines.push(`${displayName} (${a.id}) is still running (timed out waiting). Call wait_for_agent again to check.`);
			} else if (a.status === "killed") {
				topLevel.error = a.error ?? "killed";
				topLevel.abortReason = a.abortReason;
				topLevel.output = a.output;
				topLevel.warnings = [...warnings, ...(a.warnings ?? [])];
				const hasOutput = a.output && a.output.length > 0;
				if (hasOutput) {
					lines.push(`${displayName} (${a.id}) was hard-aborted after kill window expired. Partial output may be available. Use resume: "${a.id}" to continue this agent.`);
					lines.push("");
					lines.push(a.output);
				} else {
					lines.push(`${displayName} (${a.id}) was hard-aborted after kill window expired. Use resume: "${a.id}" to continue this agent.`);
				}
			} else {
				topLevel.error = "unknown_agent_id";
				lines.push(`Unknown agent ID "${a.id}".`);
			}
		} else {
			// Multi-agent: structured summary
			lines.push(`wait_for_agent results for ${agents.length} agent(s):`);

			if (completed.length > 0) {
				lines.push(`\n## Completed (${completed.length})`);
				for (const a of completed) {
					const name = a.displayName || a.agentType || a.id;
					lines.push(`- ${name} (${a.id})`);
					if (a.error !== undefined) {
						lines.push(`  Error: ${a.error}`);
					} else if (a.output) {
						lines.push(`  ${a.output}`);
					} else {
						lines.push(`  (no output captured)`);
					}
				}
			}

			if (running.length > 0) {
				lines.push(`\n## Still Running (${running.length})`);
				for (const a of running) {
					const name = a.displayName || a.agentType || a.id;
					lines.push(`- ${name} (${a.id})`);
				}
			}

			if (timedOut.length > 0) {
				lines.push(`\n## Timed Out, Still Running (${timedOut.length})`);
				for (const a of timedOut) {
					const name = a.displayName || a.agentType || a.id;
					lines.push(`- ${name} (${a.id})`);
				}
			}

			if (killed.length > 0) {
				lines.push(`\n## Hard-Aborted (${killed.length})`);
				for (const a of killed) {
					const name = a.displayName || a.agentType || a.id;
					lines.push(`- ${name} (${a.id}) [transcript saved, resumable]`);
				}
			}

			if (unknown.length > 0) {
				lines.push(`\n## Unknown IDs (${unknown.length})`);
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
