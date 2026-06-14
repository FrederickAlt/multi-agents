import { DefaultResourceLoader, type ExtensionAPI, getAgentDir, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { AgentRegistry, discoverAgents } from "./agents.js";
import { formatContextUsageLine } from "./context-usage.js";
import type { DebugLogger } from "./debug-logger.js";
import { checkTaskAllowed } from "./depth-policy.js";
import { MetadataStore } from "./metadata.js";
import { PiModelResolver, type SubagentSessionManager } from "./session-manager.js";
import {
	type AgentDiscoveryAdapter,
	type RuntimeContext,
	TaskController,
	type TaskDetails,
	type TaskExecuteContext,
	type TaskExecuteParams,
	type TaskResult,
} from "./task-controller.js";

export type TaskToolRunner = (
	params: TaskExecuteParams,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: TaskResult) => void) | undefined,
	ctx: any,
	runtime: RuntimeContext,
) => Promise<TaskResult>;

export interface TaskToolRegistrationDependencies {
	getSessionManager(logger?: DebugLogger): SubagentSessionManager;
	consumeWaitForAgentIds(ids: string[]): void;
}

function updateActiveTools(targetPi: ExtensionAPI, update: (activeTools: string[]) => string[]): void {
	const api = targetPi as Partial<Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">>;
	if (typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") return;

	try {
		const activeTools = api.getActiveTools();
		const nextTools = update(activeTools);
		const unchanged =
			nextTools.length === activeTools.length && nextTools.every((name, index) => name === activeTools[index]);
		if (!unchanged) api.setActiveTools(nextTools);
	} catch {
		// getActiveTools/setActiveTools are unavailable while an inline extension
		// is loading before the AgentSession runtime is bound. In that phase there
		// cannot be a stale active Task in this runtime; post-bind calls will update
		// active tools explicitly.
	}
}

export function deactivateTaskTool(targetPi: ExtensionAPI): void {
	updateActiveTools(targetPi, (activeTools) => activeTools.filter((name) => name !== "Task"));
}

function activateTaskTool(targetPi: ExtensionAPI, includeTaskTool: boolean): void {
	updateActiveTools(targetPi, (activeTools) => {
		let result = activeTools;
		if (includeTaskTool && !result.includes("Task")) {
			result = [...result, "Task"];
		}
		if (!result.includes("wait_for_agent")) {
			result = [...result, "wait_for_agent"];
		}
		return result;
	});
}

function stripContextUsageLines(text: string): string {
	const lines = text.split(/\r?\n/);
	const firstBlankLine = lines.findIndex((line) => line.trim() === "");
	const headerEnd = firstBlankLine === -1 ? Math.min(lines.length, 3) : firstBlankLine;
	const contextLineIndex = lines.findIndex(
		(line, index) => index < headerEnd && /^\s*Context used: (?:Unknown|\d+(?:\.\d+)?%)\.\s*$/.test(line),
	);
	if (contextLineIndex === -1) return text;
	return lines.filter((_line, index) => index !== contextLineIndex).join("\n");
}

export function configureTaskToolForRuntime(
	targetPi: ExtensionAPI,
	runtime: RuntimeContext,
	runTask: TaskToolRunner,
	deps: TaskToolRegistrationDependencies,
): void {
	const discovery = discoverAgents();

	// Filter to only what THIS agent is allowed to spawn.
	// DepthPolicy is the single source of truth.
	const policy = runtime.depthPolicy;
	const allowed = discovery.agents.filter((a) => checkTaskAllowed(policy, a.name).allowed);
	const canSpawn = allowed.length > 0;

	if (!canSpawn) {
		// If this runtime previously registered Task, leaving it active would let
		// the model call a stale tool after the policy has changed. Pi has no
		// unregisterTool API, so deactivate Task when the current policy exposes
		// no spawnable targets.
		deactivateTaskTool(targetPi);
	}

	if (canSpawn) {
		const agentNames = allowed.map((a) => a.name);
		const descriptionText = allowed.map((a) => `${a.name}: ${a.description}`).join(". ");

		const params = Type.Object({
			description: Type.String({ description: "Short 3-5 word description of the task." }),
			prompt: Type.String({
				description: "Full task description for the agent to perform autonomously. The agent reports back once.",
			}),
			subagent_type: Type.Enum(agentNames, {
				description: `Which sub-agent to delegate to. ${descriptionText}`,
			}),
			resume: Type.Optional(
				Type.String({
					description: "Short hex ID of a previous sub-agent to continue.",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description: "Working directory for the sub-agent. Defaults to the parent agent's cwd.",
				}),
			),
			blocking: Type.Optional(
				Type.Boolean({
					default: true,
					description: "When false, spawns the sub-agent asynchronously and returns immediately. Default true.",
				}),
			),
		});

		targetPi.registerTool({
			name: "Task",
			label: "Task",
			description:
				"Delegate an autonomous task to a configured persistent sub-agent. Use resume to continue a previous sub-agent by ID.",
			promptSnippet: "Run or resume a configured persistent sub-agent for an autonomous task",
			promptGuidelines: [
				"Use Task to delegate independent work to a specialized sub-agent.",
				"Call Task multiple times in the same turn when independent sub-agent tasks can run in parallel.",
				"Use Task resume with a returned sub-agent ID when follow-up work needs the same transcript.",
				"Use Task with blocking:false to spawn the sub-agent asynchronously and continue working. Use wait_for_agent later to retrieve output.",
			],
			parameters: params,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				return runTask(params, signal, onUpdate, ctx, runtime);
			},
			renderCall(args, theme) {
				const resume = args.resume ? ` resume ${args.resume}` : " new";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("Task "))}${theme.fg("accent", args.subagent_type)}${theme.fg("muted", resume)}\n  ${theme.fg("dim", args.description)}`,
					0,
					0,
				);
			},
			renderResult(result, { expanded }, theme) {
				const details = result.details as TaskDetails | undefined;
				const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
				if (!expanded || !details) return new Text(text, 0, 0);
				const container = new Container();
				container.addChild(
					new Text(
						`${theme.fg("toolTitle", theme.bold(details.displayName ?? "Task"))}${details.id ? theme.fg("muted", ` ${details.id}`) : ""}`,
						0,
						0,
					),
				);
				if (details.description) container.addChild(new Text(theme.fg("dim", details.description), 0, 0));
				const hasTerminalResult =
					details.contextUsage !== undefined ||
					details.terminalOutcome !== undefined ||
					details.output !== undefined;
				if (hasTerminalResult) {
					container.addChild(new Text(theme.fg("muted", formatContextUsageLine(details.contextUsage)), 0, 0));
				}
				if (details.warnings.length > 0) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("warning", details.warnings.join("\n")), 0, 0));
				}
				container.addChild(new Spacer(1));
				const bodyText = details.output || stripContextUsageLines(text);
				container.addChild(new Markdown(bodyText || "(no output)", 0, 0, getMarkdownTheme()));
				return container;
			},
		});
	}
	activateTaskTool(targetPi, canSpawn);

	// Register wait_for_agent alongside Task for async retrieval.
	const waitForAgentParams = Type.Object({
		agent_ids: Type.Array(Type.String(), {
			description:
				"List of short hex IDs of previously spawned sub-agents to wait for. By default the call returns as soon as any listed running agent finishes.",
		}),
		timeout: Type.Optional(
			Type.Number({
				default: 5,
				description: "Minutes to wait before returning a status update. Default 5 minutes.",
			}),
		),
		wait_all: Type.Optional(
			Type.Boolean({
				default: false,
				description:
					"When true, wait until all listed running agents finish or timeout expires. Default false returns as soon as any listed agent finishes.",
			}),
		),
		kill_on_timeout: Type.Optional(
			Type.Boolean({
				default: false,
				description:
					"When true, if the wait times out, asks each still-running agent for a final answer within the same timeout. If still running, cancels in-flight work, waits up to 5s for session/tool completion, disables tools for a bounded final-summary prompt, then forcibly aborts as a fallback. Transcripts persist for resume.",
			}),
		),
	});

	targetPi.registerTool({
		name: "wait_for_agent",
		label: "Wait for Agent",
		description:
			"Wait for one or more asynchronously spawned sub-agents to finish and return their output. Also retrieves output from finished blocking agents. By default returns as soon as any listed agent finishes or timeout expires; set wait_all=true to wait for all listed agents.",
		promptSnippet: "Wait for async sub-agent(s) by ID to finish",
		promptGuidelines: [
			"Use wait_for_agent to retrieve output from sub-agent(s) spawned with Task blocking:false.",
			"Provide the agent_ids returned by the async Task calls as a list.",
			"Pass multiple IDs to wait on several agents at once — by default returns when any finishes.",
			"Set wait_all:true to wait until all listed running agents finish or timeout expires.",
			"Pass timeout (in minutes, default 5) to bound the wait.",
			"Set kill_on_timeout:true only when you want timeout escalation: request a final answer, then cancel in-flight work and attempt a no-tools final summary before forced abort fallback.",
		],
		parameters: waitForAgentParams,
		async execute(_toolCallId, wParams, _signal, _onUpdate, ctx) {
			const controller = new TaskController();

			const activeStore = runtime.store ?? MetadataStore.fromSessionManager(ctx.sessionManager, runtime.logger);
			const sm = deps.getSessionManager(runtime.logger);

			const agentDiscoveryAdapter: AgentDiscoveryAdapter = {
				discover() {
					const registry = new AgentRegistry();
					registry.discover();
					return {
						agents: registry.agents,
						diagnostics: registry.diagnostics,
					};
				},
			};

			const executeContext: TaskExecuteContext = {
				cwd: ctx.cwd,
				runtime,
				agentDiscovery: agentDiscoveryAdapter,
				metadataStore: activeStore,
				sessionManager: sm,
				modelResolver: new PiModelResolver(ctx.modelRegistry),
				fallbackModel: ctx.model,
				modelRegistry: ctx.modelRegistry,
				createResourceLoaderFactory: async () => {
					const loader = new DefaultResourceLoader({ cwd: ctx.cwd, agentDir: getAgentDir() });
					await loader.reload();
					return loader;
				},
			};

			const result = await controller.waitForAgent(
				wParams.agent_ids,
				{ timeout: wParams.timeout, wait_all: wParams.wait_all, kill_on_timeout: wParams.kill_on_timeout },
				{
					...executeContext,
					consumeWaitForAgentIds: deps.consumeWaitForAgentIds,
				},
			);

			return result;
		},

		renderCall(args, theme) {
			const ids = Array.isArray(args.agent_ids) ? args.agent_ids.join(", ") : String(args.agent_ids ?? "");
			return new Text(`${theme.fg("toolTitle", theme.bold("wait_for_agent "))}${theme.fg("muted", ids)}`, 0, 0);
		},
		renderResult(result, _opts, theme) {
			const details = result.details as TaskDetails | undefined;
			const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
			const container = new Container();
			if (details?.agents && details.agents.length > 1) {
				container.addChild(
					new Text(
						`${theme.fg("toolTitle", theme.bold("wait_for_agent"))}${theme.fg("muted", ` (${details.agents.length} agents)`)}`,
						0,
						0,
					),
				);
			} else {
				container.addChild(
					new Text(
						`${theme.fg("toolTitle", theme.bold(details?.displayName ?? "Agent"))}${details?.id ? theme.fg("muted", ` ${details.id}`) : ""}`,
						0,
						0,
					),
				);
			}
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
			return container;
		},
	});
}
