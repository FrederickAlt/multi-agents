/**
 * TaskController — orchestrates a single Task (sub-agent) execution.
 *
 * Responsibilities:
 * - Agent discovery and validation (AgentRegistry)
 * - Spawn permission checks (depth, canSpawn allowlist)
 * - Record allocation via MetadataStore
 * - Session lifecycle via SubagentSessionManager
 * - Prompt execution and result formatting
 * - Error handling (returns structured error results, never throws)
 *
 * The class is stateless; all runtime dependencies are passed via the
 * TaskExecuteContext parameter to execute().
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { DefaultResourceLoader, Model } from "@mariozechner/pi-coding-agent";
import {
	AgentRegistry,
	type AgentConfig,
	type AgentScope,
	formatAgentList,
} from "./agents.js";
import type { MetadataFile, MetadataStore, SubagentRecord } from "./metadata.js";
import type {
	ModelResolver,
	SubagentSessionManager,
} from "./session-manager.js";

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
	depth: number;
	rootMaxDepth: number;
	canSpawn?: string[];
	store?: MetadataStore;
}

/**
 * All runtime dependencies injected into TaskController.execute().
 *
 * The `createResourceLoaderFactory` callback is a factory function:
 * `(agent: AgentConfig, childRuntime: RuntimeContext) => Promise<DefaultResourceLoader>`.
 * The TaskController calls it to obtain the resource loader passed to the
 * session manager for each Task execution.
 */
export interface TaskExecuteContext {
	cwd: string;
	signal?: AbortSignal;
	runtime: RuntimeContext;
	agentScope: AgentScope;
	metadataStore: MetadataStore;
	sessionManager: SubagentSessionManager;
	modelResolver: ModelResolver;
	fallbackModel?: Model;
	createResourceLoaderFactory: (
		agent: AgentConfig,
		childRuntime: RuntimeContext,
	) => Promise<DefaultResourceLoader>;
	selfPath: string;
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
	 * Check whether spawning `agentName` is allowed given the parent
	 * runtime depth and canSpawn constraints.
	 */
	static checkSpawnAllowed(
		runtime: { depth: number; rootMaxDepth: number; canSpawn: string[] | undefined },
		agentName: string,
	): { allowed: boolean; error?: string; code?: string } {
		if (runtime.depth >= runtime.rootMaxDepth) {
			return {
				allowed: false,
				error: `Cannot spawn ${agentName}: depth limit ${runtime.rootMaxDepth} has been reached.`,
				code: "depth_limit",
			};
		}
		if (runtime.canSpawn && !runtime.canSpawn.includes(agentName)) {
			return {
				allowed: false,
				error: `Cannot spawn ${agentName}: parent agent is only allowed to spawn ${runtime.canSpawn.join(", ")}.`,
				code: "spawn_not_allowed",
			};
		}
		return { allowed: true };
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
		let agent = findAgent(agents, params.subagent_type);

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
		}

		if (!agent) {
			const available = formatAgentList(agents, 30).text;
			return {
				ok: false,
				errorText: `Unknown sub-agent type "${params.subagent_type}". Available: ${available}`,
				errorCode: "unknown_agent_type",
			};
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
	 * is stateless. Errors are returned as structured results — this
	 * method never throws.
	 */
	async execute(
		params: TaskExecuteParams,
		context: TaskExecuteContext,
	): Promise<TaskResult> {
		const effectiveCwd = params.cwd || context.cwd;
		const {
			runtime,
			agentScope,
			metadataStore,
			sessionManager,
			modelResolver,
			fallbackModel,
			createResourceLoaderFactory,
			selfPath,
			onUpdate,
		} = context;

		// a. Agent discovery
		const registry = new AgentRegistry({ cwd: effectiveCwd, scope: agentScope });
		registry.discover();
		const agents = registry.agents;

		// b. Collect warnings from diagnostics
		const warnings: string[] = registry.diagnostics
			.filter((d) => d.level === "warn")
			.map((d) => `[AgentRegistry] ${d.filePath}: ${d.reason}`);
		const errors = registry.diagnostics.filter((d) => d.level === "error");
		if (errors.length > 0) {
			warnings.push(
				`Some agent definitions were skipped due to errors:\n${errors
					.map((d) => `- ${d.filePath}: ${d.reason}`)
					.join("\n")}`,
			);
		}

		// c. Resolve agent (and possibly record for resume)
		const resolved = TaskController.resolveTaskAgent(
			params,
			metadataStore.load(),
			agents,
		);
		if (!resolved.ok) {
			return {
				content: [{ type: "text", text: resolved.errorText }],
				details: { warnings, error: resolved.errorCode },
			};
		}
		const { agent } = resolved;
		let record = resolved.record;

		// d. Check spawn permission
		const spawnCheck = TaskController.checkSpawnAllowed(runtime, agent.name);
		if (!spawnCheck.allowed) {
			return {
				content: [{ type: "text", text: spawnCheck.error! }],
				details: { warnings, agentType: agent.name, error: spawnCheck.code },
			};
		}

		// e. Allocate record if not resuming
		if (!record) {
			record = await metadataStore.allocateRecord(
				agent.name,
				runtime.parentAgentId,
				runtime.depth + 1,
			);
		}

		const recordId = record.id;

		// f. Run serialised within the record lock
		return sessionManager.withRecordRunLock(recordId, async () => {
			// Re-read record in case another concurrent path updated it
			record = metadataStore.findRecord(recordId) ?? record!;

			// Build the child runtime for the sub-agent
			const childRuntime: RuntimeContext = {
				parentAgentId: record!.id,
				depth: record!.depth,
				rootMaxDepth: runtime.rootMaxDepth,
				canSpawn: agent.canSpawn ?? [],
				store: metadataStore,
			};

			// Obtain the resource loader via the injected factory
			const resourceLoader = await createResourceLoaderFactory(agent, childRuntime);

			const session = await sessionManager.getOrCreateSession(
				record!,
				agent,
				warnings,
				{
					metadataStore,
					cwd: effectiveCwd,
					fallbackModel,
					modelResolver,
					createResourceLoader: async () => resourceLoader,
				},
			);

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

			const abort = () => {
				void session?.abort();
			};
			if (context.signal?.aborted) abort();
			else context.signal?.addEventListener("abort", abort, { once: true });

			try {
				emit(`${record!.displayName} (${record!.id}) running...`);
				await session.prompt(params.prompt);
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
				context.signal?.removeEventListener("abort", abort);
				metadataStore.touchRecord(record!.id);
				// Dispose the in-memory session to prevent unbounded accumulation.
				// The session file remains on disk; resume reopens from the file.
				sessionManager.disposeSession(record!.id);
			}
		});
	}
}
