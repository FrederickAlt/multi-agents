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
}

/** Typed subset of the parent runtime state needed by the TaskController. */
export interface RuntimeContext {
	parentAgentId?: string;
	/** Current position in the agent tree (Root = 0, child = 1, …). */
	treeDepth: number;
	/** Spawn-policy state for the current agent. */
	depthPolicy: DepthPolicyState;
	store?: MetadataAdapter;
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
	output?: string;
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

	/**
	 * Extract the last assistant text content from a message array.
	 */
	static getFinalTextFromMessages(messages: any[]): string {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg?.role !== "assistant") continue;
			const content = Array.isArray(msg.content) ? msg.content : [];
			for (const part of content) {
				if (part?.type === "text" && typeof part.text === "string") return part.text;
			}
		}
		return "";
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

		// a. Agent discovery (via injected adapter)
		let agents: AgentConfig[];
		const warnings: string[] = [];
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
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: `Task failed during agent discovery: ${message}` }],
				details: { warnings, error: message },
			};
		}

		// b. Resolve agent (and possibly record for resume)
		let metadata: MetadataFile;
		try {
			metadata = metadataStore.load();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: `Task failed while loading metadata: ${message}` }],
				details: { warnings, error: message },
			};
		}

		const resolved = TaskController.resolveTaskAgent(params, metadata, agents);
		if (!resolved.ok) {
			return {
				content: [{ type: "text", text: resolved.errorText }],
				details: { warnings, error: resolved.errorCode },
			};
		}
		const { agent } = resolved;
		let record = resolved.record;

		// c. Check task permission via DepthPolicy
		const taskCheck = checkTaskAllowed(runtime.depthPolicy, agent.name);
		if (!taskCheck.allowed) {
			return {
				content: [{ type: "text", text: taskCheck.error! }],
				details: { warnings, agentType: agent.name, error: taskCheck.code },
			};
		}

		// d. Allocate record if not resuming
		if (!record) {
			try {
				record = await metadataStore.allocateRecord(
					agent.name,
					runtime.parentAgentId,
					runtime.treeDepth + 1,
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
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
				};

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
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
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
					const promptRace = [] as Array<
						Promise<
							| { type: "completed" }
							| { type: "failed"; error: unknown }
							| { type: "timeout" }
							| { type: "aborted" }
						>
					>;
					if (!context.signal?.aborted) {
						const promptResult = Promise.resolve().then(() => session.prompt(params.prompt)).then(
							() => ({ type: "completed" as const }),
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
						throw new Error("Task execution was aborted.");
					}
					if (promptOrTimeout.type === "failed") {
						throw promptOrTimeout.error;
					}

					const output = TaskController.getFinalTextFromMessages(session.messages as any[]);
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
					const warningText =
						warnings.length > 0
							? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`
							: "";
					return {
						content: [
							{
								type: "text",
								text: `${record!.displayName} (${record!.id}) failed. Use resume: "${record!.id}" to retry or continue this agent.\n\n${message}${warningText}`,
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
				} finally {
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
}
