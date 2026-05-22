/**
 * Persistent Task subagents for Pi.
 *
 * This extension intentionally exposes one model-facing tool, Task. Each Task
 * creates or resumes a real Pi AgentSession stored in normal session storage.
 */

import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	getAgentDir,
	getMarkdownTheme,
	loadProjectContextFiles,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { MetadataStore, type MetadataFile, type SubagentRecord } from "./metadata.js";
import { seedAgentConfig } from "./seeding.js";
import { type AgentConfig, AgentRegistry, discoverAgents, formatAgentList } from "./agents.js";
import { discoverPromptParts } from "./prompt-parts.js";
import { PiAgentSessionFactory, PiModelResolver, PiSessionManagerProvider, SubagentSessionManager } from "./session-manager.js";
import { TaskController, type TaskExecuteParams, type TaskExecuteContext, type TaskDetails, type TaskResult, type RuntimeContext, type AgentDiscoveryAdapter } from "./task-controller.js";
import { defaultRootPolicy, selectedRootPolicy, checkTaskAllowed } from "./depth-policy.js";
import { DEFAULT_ROOT_AGENT_NAME, resolveRootAgent } from "./root-agent.js";
import {
	buildPromptPartsFromOptions,
	renderComposedAgentSystemPrompt,
	type PromptParts,
	type RenderContext,
} from "./prompt-composition.js";

export {
	buildTemplateValues,
	renderTemplateString,
	renderPromptTemplate,
	renderSubagentSystemPrompt,
	renderComposedAgentSystemPrompt,
} from "./prompt-composition.js";
export type { PromptParts, RenderContext, SystemPromptCompositionOptions } from "./prompt-composition.js";

function findAgent(agents: AgentConfig[], name: string): AgentConfig | undefined {
	return agents.find((agent) => agent.name === name);
}

function canonicalExistingPath(p: string): string {
	if (!p || p.startsWith("<")) return p;
	const resolved = path.resolve(p);
	try {
		return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
	} catch {
		return resolved;
	}
}

function sameExtensionPath(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	if (a.startsWith("<") || b.startsWith("<")) return false;
	return canonicalExistingPath(a) === canonicalExistingPath(b);
}

export function filterExtensionsForAgent(agent: AgentConfig, selfPath: string): (base: any) => any {
	const canonicalSelfPath = canonicalExistingPath(selfPath);
	return (base: any) => {
		const allowed = agent.extensions;
		const filtered = base.extensions.filter((extension: any) => {
			const extensionPath = String(extension.path ?? "");
			const resolvedPath = String(extension.resolvedPath ?? "");
			// Keep this sub-agent's inline runtime extension. It installs the
			// before_agent_start hook that renders agent templates and prompt parts;
			// filtering it out makes children fall back to Pi's default prompt.
			if (extensionPath.startsWith("<inline:") || resolvedPath.startsWith("<inline:")) return true;
			// The parent multi-agents extension is often loaded through a symlink from
			// ~/.pi/agent/extensions. Compare canonical real paths so it is removed
			// from child sessions and cannot register a second Root-agent lifecycle.
			if (
				sameExtensionPath(extensionPath, canonicalSelfPath) ||
				sameExtensionPath(resolvedPath, canonicalSelfPath)
			) return false;
			if (!allowed) return true; // undefined → unrestricted
			if (allowed.length === 0) return false; // [] → none
			const candidates = [
				extension.path,
				extension.resolvedPath,
				extension.sourceInfo?.source,
				path.basename(extension.path ?? ""),
				path.basename(extension.resolvedPath ?? ""),
				path.basename(path.dirname(extension.resolvedPath ?? "")),
			].filter(Boolean);
			return allowed.some((name) => candidates.some((candidate) => String(candidate).includes(name)));
		});
		return { ...base, extensions: filtered };
	};
}

// Persists across extension module reloads (triggered by newSession).
// Extension-level closure variables are lost on reload because jiti uses
// moduleCache: false. globalThis survives because it's process-global.
const GLOBAL_SELECTED_AGENT_KEY = "__multi_agents_selected_main_agent";

function getGlobalSelectedAgent(): string | undefined {
	return (globalThis as any)[GLOBAL_SELECTED_AGENT_KEY];
}

function setGlobalSelectedAgent(name: string | undefined): void {
	if (name === undefined) {
		delete (globalThis as any)[GLOBAL_SELECTED_AGENT_KEY];
	} else {
		(globalThis as any)[GLOBAL_SELECTED_AGENT_KEY] = name;
	}
}

type TaskToolRunner = (
	params: TaskExecuteParams,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: TaskResult) => void) | undefined,
	ctx: any,
	runtime: RuntimeContext,
) => Promise<TaskResult>;

function updateActiveTools(
	targetPi: ExtensionAPI,
	update: (activeTools: string[]) => string[],
): void {
	const api = targetPi as Partial<Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">>;
	if (typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") return;

	try {
		const activeTools = api.getActiveTools();
		const nextTools = update(activeTools);
		const unchanged = nextTools.length === activeTools.length
			&& nextTools.every((name, index) => name === activeTools[index]);
		if (!unchanged) api.setActiveTools(nextTools);
	} catch {
		// getActiveTools/setActiveTools are unavailable while an inline extension
		// is loading before the AgentSession runtime is bound. In that phase there
		// cannot be a stale active Task in this runtime; post-bind calls will update
		// active tools explicitly.
	}
}

function deactivateTaskTool(targetPi: ExtensionAPI): void {
	updateActiveTools(targetPi, (activeTools) => activeTools.filter((name) => name !== "Task" && name !== "wait_for_agent"));
}

function activateTaskTool(targetPi: ExtensionAPI): void {
	updateActiveTools(targetPi, (activeTools) => {
		let result = activeTools;
		if (!result.includes("Task")) result = [...result, "Task"];
		if (!result.includes("wait_for_agent")) result = [...result, "wait_for_agent"];
		return result;
	});
}

export function configureTaskToolForRuntime(
	targetPi: ExtensionAPI,
	runtime: RuntimeContext,
	
	runTask: TaskToolRunner,
): void {
	const discovery = discoverAgents();

	// Filter to only what THIS agent is allowed to spawn.
	// DepthPolicy is the single source of truth.
	const policy = runtime.depthPolicy;
	const allowed = discovery.agents.filter(a => checkTaskAllowed(policy, a.name).allowed);

	// If this runtime previously registered Task, leaving it active would let
	// the model call a stale tool after the policy has changed. Pi has no
	// unregisterTool API, so deactivate Task when the current policy exposes no
	// spawnable targets.
	if (allowed.length === 0) {
		deactivateTaskTool(targetPi);
		return;
	}

	const agentNames = allowed.map(a => a.name);
	const descriptionText = allowed
		.map(a => `${a.name}: ${a.description}`)
		.join(". ");

	const params = Type.Object({
		description: Type.String({ description: "Short 3-5 word description of the task." }),
		prompt: Type.String({
			description: "Full task description for the agent to perform autonomously. The agent reports back once.",
		}),
		subagent_type: Type.Enum(agentNames, {
			description: `Which sub-agent to delegate to. ${descriptionText}`,
		}),
		resume: Type.Optional(Type.String({
			description: "Short hex ID of a previous sub-agent to continue.",
		})),
		cwd: Type.Optional(Type.String({
			description: "Working directory for the sub-agent. Defaults to the parent agent's cwd.",
		})),
		blocking: Type.Optional(Type.Boolean({
			default: true,
			description: "When false, spawns the sub-agent asynchronously and returns immediately. Default true.",
		})),
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
			"Use Task with blocking:false to spawn a sub-agent asynchronously and continue working. Use wait_for_agent later to retrieve output.",
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
			if (details.warnings.length > 0) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("warning", details.warnings.join("\n")), 0, 0));
			}
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(details.output || text, 0, 0, getMarkdownTheme()));
			return container;
		},
	});
	activateTaskTool(targetPi);

	// Register wait_for_agent alongside Task for async retrieval.
	const waitForAgentParams = Type.Object({
		agent_ids: Type.Array(Type.String(), {
			description: "List of short hex IDs of previously spawned sub-agents to wait for. The call returns as soon as any listed running agent finishes.",
		}),
		timeout: Type.Optional(Type.Number({
			default: 5,
			description: "Minutes to wait before returning a status update. Default 5 minutes.",
		})),
	});

	targetPi.registerTool({
		name: "wait_for_agent",
		label: "Wait for Agent",
		description:
			"Wait for one or more asynchronously spawned sub-agents to finish and return their output. Also retrieves output from finished blocking agents. Returns as soon as any listed agent finishes or timeout expires.",
		promptSnippet: "Wait for async sub-agent(s) by ID to finish",
		promptGuidelines: [
			"Use wait_for_agent to retrieve output from sub-agent(s) spawned with Task blocking:false.",
			"Provide the agent_ids returned by the async Task calls as a list.",
			"Pass multiple IDs to wait on several agents at once — returns when any finishes.",
			"Pass timeout (in minutes, default 5) to bound the wait.",
		],
		parameters: waitForAgentParams,
		async execute(_toolCallId, wParams, _signal, _onUpdate, ctx) {
			const controller = new TaskController();

			const activeStore = runtime.store ?? MetadataStore.fromSessionManager(ctx.sessionManager);
			const sm = getOrCreateSessionManager();

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

			return controller.waitForAgent(wParams.agent_ids, { timeout: wParams.timeout }, executeContext);
		},
		renderCall(args, theme) {
			const ids = Array.isArray(args.agent_ids) ? args.agent_ids.join(", ") : String(args.agent_ids ?? "");
			return new Text(
				`${theme.fg("toolTitle", theme.bold("wait_for_agent "))}${theme.fg("muted", ids)}`,
				0,
				0,
			);
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

// Module-level session manager singleton so both Task and wait_for_agent
// share the same tracked sessions.
let _sessionManager: SubagentSessionManager | undefined;

function getOrCreateSessionManager(): SubagentSessionManager {
	if (!_sessionManager) {
		_sessionManager = new SubagentSessionManager(
			new PiSessionManagerProvider(),
			new PiAgentSessionFactory(),
		);
	}
	return _sessionManager;
}

let seeded = false;
export default function (pi: ExtensionAPI) {
	if (!seeded) { seedAgentConfig(); seeded = true; }

	let store: MetadataStore | undefined;
	let dumpNextProviderRequest = false;
	let lastProviderSystemPrompt: string | undefined;
	let lastRootPromptParts: PromptParts | undefined;
	const selfPath = path.resolve(fileURLToPath(import.meta.url));
	const mainRuntime: RuntimeContext = {
		treeDepth: 0,
		depthPolicy: defaultRootPolicy(),
	};

	const showMessage = (ctx: { ui: { notify(message: string, type?: string): void } }, content: string, type: string = "info") => {
		ctx.ui.notify(content, type);
	};

	const configuredDefaultRootAgent = (): string => {
		const flag = pi.getFlag("defaultRootAgent");
		return typeof flag === "string" && flag.trim() ? flag.trim() : DEFAULT_ROOT_AGENT_NAME;
	};

	const resolveRootAgentForSession = (selectedAgent?: string): AgentConfig => {
		const discovery = discoverAgents();
		return resolveRootAgent({
			agents: discovery.agents,
			selectedAgent,
			defaultRootAgent: configuredDefaultRootAgent(),
		}).agent;
	};

	const formatRootAgentResolutionError = (error: unknown): string => {
		const message = error instanceof Error ? error.message : String(error);
		return `Multi-agents configuration error: ${message}`;
	};

	const activeToolDefinitions = () => {
		const activeToolNames = new Set(pi.getActiveTools());
		return pi
			.getAllTools()
			.filter((tool) => activeToolNames.has(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			}));
	};

	const renderDump = (title: string, systemPrompt: string, note?: string) => [
		`=== ${title} ===`,
		"",
		systemPrompt,
		...(note ? ["", "=== NOTE ===", "", note] : []),
		"",
		"=== TOOLS ===",
		"",
		JSON.stringify(activeToolDefinitions(), null, 2),
	].join("\n");

	const buildFallbackPromptPartsForCurrentRoot = (ctx: { cwd: string }): PromptParts => {
		let activeTools: string[] = [];
		let allTools: Array<{ name: string; description?: string }> = [];
		try {
			activeTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
			allTools = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
		} catch {
			// During early startup the ExtensionAPI may not be bound yet. The exact
			// provider-bound prompt will still be captured by /dump-prompt next.
		}
		return {
			selectedTools: activeTools,
			toolSnippets: Object.fromEntries(allTools.map((tool) => [tool.name, tool.description ?? ""])),
			promptGuidelines: [],
			contextFiles: loadProjectContextFiles({ cwd: ctx.cwd, agentDir: getAgentDir() }),
			skills: [],
			cwd: ctx.cwd,
		};
	};

	const buildPromptPartsForCurrentRoot = (ctx: { cwd: string }): PromptParts => {
		if (lastRootPromptParts?.cwd === ctx.cwd) return lastRootPromptParts;
		return buildFallbackPromptPartsForCurrentRoot(ctx);
	};

	const renderCurrentRootPromptForDump = (ctx: { cwd: string; sessionManager: any }): string => {
		const activeStore = MetadataStore.fromSessionManager(ctx.sessionManager);
		activeStore.load();
		const agent = resolveRootAgentForSession(activeStore.selectedMainAgent);
		return renderComposedAgentSystemPrompt({
			agent,
			parts: buildPromptPartsForCurrentRoot(ctx),
		}, discoverPromptParts().parts);
	};

	const makeAgentRuntimeFactory = (
		agent: AgentConfig,
		runtime: RuntimeContext,
		effectiveCwd: string,
		contextFiles?: Array<{ path: string; content: string }>,
	): ExtensionFactory => {
		return (subPi) => {
			registerTaskTool(subPi, runtime, effectiveCwd);

			// Discover prompt parts for this sub-agent's effective working directory.
			const promptPartDefs = discoverPromptParts().parts;

			subPi.on("before_agent_start", async (event) => {
				const parts = buildPromptPartsFromOptions(event.systemPromptOptions);
				if (contextFiles) parts.contextFiles = contextFiles;
				const context: RenderContext = {
					agent,
					parts,
				};
				const prompt = renderComposedAgentSystemPrompt(context, promptPartDefs, {
					baseSystemPrompt: event.systemPrompt,
					appendSystemPrompt: event.systemPromptOptions.appendSystemPrompt,
				});
				return { systemPrompt: prompt };
			});
		};
	};

	const controller = new TaskController();

	const runTask = async (
		params: { description: string; prompt: string; subagent_type: string; resume?: string; cwd?: string },
		signal: AbortSignal | undefined,
		onUpdate: ((partial: TaskResult) => void) | undefined,
		ctx: any,
		runtime: RuntimeContext,
	): Promise<TaskResult> => {
		const activeStore = runtime.store ?? MetadataStore.fromSessionManager(ctx.sessionManager);
		const sm = getOrCreateSessionManager();

		// Build adapter objects from concrete classes.
		// MetadataStore / SubagentSessionManager already satisfy their
		// respective adapter interfaces.
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
			signal,
			runtime,
			agentDiscovery: agentDiscoveryAdapter,
			metadataStore: activeStore,
			sessionManager: sm,
			modelResolver: new PiModelResolver(ctx.modelRegistry),
			fallbackModel: ctx.model,
			modelRegistry: ctx.modelRegistry,
			createResourceLoaderFactory: async (agent, childRuntime) => {
				const effectiveCwd = params.cwd || ctx.cwd;
				const agentDir = getAgentDir();
				const contextFiles = loadProjectContextFiles({ cwd: effectiveCwd, agentDir });
				const loader = new DefaultResourceLoader({
					cwd: effectiveCwd,
					agentDir,
					noContextFiles: true,
					appendSystemPromptOverride: () => [],
					extensionsOverride: filterExtensionsForAgent(agent, selfPath),
					extensionFactories: [makeAgentRuntimeFactory(agent, childRuntime, effectiveCwd, contextFiles)],
					systemPromptOverride: () => agent.systemPrompt,
				});
				await loader.reload();
				return loader;
			},
			onUpdate,
		};

		return controller.execute(params, executeContext);
	};

	function registerTaskTool(targetPi: ExtensionAPI, runtime: RuntimeContext): void {
		configureTaskToolForRuntime(targetPi, runtime, runTask);
	}

	pi.registerFlag("agent", {
		description: "Start with a configured agent persona",
		type: "string",
		default: "",
	});

	pi.registerFlag("defaultRootAgent", {
		description: "Default Root agent definition to use when no session-local /agent selection exists",
		type: "string",
		default: DEFAULT_ROOT_AGENT_NAME,
	});

	pi.on("input", async (_event, ctx) => {
		const activeStore = store ?? MetadataStore.fromSessionManager(ctx.sessionManager);
		try {
			activeStore.load();
			resolveRootAgentForSession(activeStore.selectedMainAgent);
		} catch (error) {
			showMessage(ctx, formatRootAgentResolutionError(error), "error");
			return { action: "handled" as const };
		}
		return { action: "continue" as const };
	});

	pi.on("session_start", async (_event, ctx) => {
		dumpNextProviderRequest = false;
		lastProviderSystemPrompt = undefined;
		lastRootPromptParts = undefined;
		const activeStore = MetadataStore.fromSessionManager(ctx.sessionManager);
		mainRuntime.store = activeStore;
		store = activeStore;
		activeStore.load();
		// Restore the agent set by /agent X before newSession.
		// globalThis is used because the extension module is reloaded during
		// newSession (jiti with moduleCache: false), and closure-level vars
		// are lost.
		const globalAgent = getGlobalSelectedAgent();
		if (globalAgent) {
			setGlobalSelectedAgent(undefined);
			activeStore.selectedMainAgent = globalAgent;
		}
		const flagAgent = pi.getFlag("agent");
		if (typeof flagAgent === "string" && flagAgent.trim()) {
			activeStore.selectedMainAgent = flagAgent.trim();
		}
		let rootAgent: AgentConfig;
		try {
			rootAgent = resolveRootAgentForSession(activeStore.selectedMainAgent);
		} catch (error) {
			showMessage(ctx, formatRootAgentResolutionError(error), "error");
			deactivateTaskTool(pi);
			return;
		}
		mainRuntime.treeDepth = 0;
		mainRuntime.depthPolicy = selectedRootPolicy(rootAgent);

		// Reconcile Task with the resolved Root policy so DepthPolicy
		// informs both the schema enum and active-tool availability.
		registerTaskTool(pi, mainRuntime);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		_sessionManager?.disposeAll();
		_sessionManager = undefined;
		if (event.reason === "new") {
			store?.cleanup();
			store = undefined;
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!store) store = MetadataStore.fromSessionManager(ctx.sessionManager);
		const agent = resolveRootAgentForSession(store.selectedMainAgent);
		mainRuntime.store = store;
		mainRuntime.treeDepth = 0;
		mainRuntime.depthPolicy = selectedRootPolicy(agent);

		// Reconcile Task with the current Root policy (before_agent_start
		// acts as a safety net when session_start was skipped or
		// the policy changed between events).
		registerTaskTool(pi, mainRuntime);

		const pParts = buildPromptPartsFromOptions(event.systemPromptOptions);
		lastRootPromptParts = pParts;
		const promptPartDefs = discoverPromptParts().parts;
		const prompt = renderComposedAgentSystemPrompt({
			agent,
			parts: pParts,
		}, promptPartDefs, {
			baseSystemPrompt: event.systemPrompt,
			appendSystemPrompt: event.systemPromptOptions.appendSystemPrompt,
		});
		return { systemPrompt: prompt };
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		const prompt = ctx.getSystemPrompt();
		lastProviderSystemPrompt = prompt;
		if (!dumpNextProviderRequest) return;

		dumpNextProviderRequest = false;
		showMessage(ctx, renderDump("SYSTEM PROMPT SENT TO PROVIDER", prompt), "info");
	});

	pi.registerCommand("dump-prompt", {
		description: "Dump system prompt + all tool definitions (including those without promptSnippet)",
		handler: async (args, ctx) => {
			const mode = args.trim();

			if (mode === "next") {
				dumpNextProviderRequest = true;
				showMessage(
					ctx,
					"Will dump the final system prompt on the next provider request. Send a normal prompt to trigger it.",
					"info",
				);
				return;
			}

			const prompt = lastProviderSystemPrompt ?? renderCurrentRootPromptForDump(ctx);
			const title = lastProviderSystemPrompt
				? "LAST SYSTEM PROMPT SENT TO PROVIDER"
				: "CURRENT MULTI-AGENTS SYSTEM PROMPT";
			const note = lastProviderSystemPrompt
				? undefined
				: "This is the current multi-agents prompt for the selected agent. Per-turn hooks may still change the final provider prompt. Use `/dump-prompt next`, then send a normal prompt, to dump the exact provider-bound prompt.";

			showMessage(ctx, renderDump(title, prompt, note), "info");
		},
	});

	pi.registerCommand("agent", {
		description: "Select or show the current Root agent persona",
		getArgumentCompletions(prefix) {
			const discovery = discoverAgents();
			return discovery.agents
				.filter((agent) => agent.name.startsWith(prefix))
				.map((agent) => ({ value: agent.name, label: agent.name, description: agent.description }));
		},
		handler: async (args, ctx) => {
			const name = args.trim();
			const discovery = discoverAgents();
			if (!name) {
				const available = formatAgentList(discovery.agents, 30).text;
				const current = store?.selectedMainAgent ?? configuredDefaultRootAgent();
				showMessage(ctx, `Current agent: ${current}\n\nAvailable: ${available}`, "info");
				return;
			}
			const agent = findAgent(discovery.agents, name);
			if (!agent) {
				const available = formatAgentList(discovery.agents, 30).text;
				showMessage(ctx, `Unknown agent "${name}".\n\nAvailable: ${available}`, "warning");
				return;
			}
			const activeStore = MetadataStore.fromSessionManager(ctx.sessionManager);
			store = activeStore;
			activeStore.selectedMainAgent = agent.name;
			mainRuntime.store = activeStore;
			mainRuntime.treeDepth = 0;
			mainRuntime.depthPolicy = selectedRootPolicy(agent);
			setGlobalSelectedAgent(agent.name);
			try {
				const result = await ctx.newSession({ parentSession: ctx.sessionManager.getSessionFile() });
				if (result.cancelled) setGlobalSelectedAgent(undefined);
			} catch (err) {
				setGlobalSelectedAgent(undefined);
				throw err;
			}
		},
	});

}

// ---------------------------------------------------------------------------
// Compatibility re-exports for existing tests
// ---------------------------------------------------------------------------

// Re-export utility functions that were moved to TaskController
export const checkSpawnAllowed = TaskController.checkSpawnAllowed;
export const resolveTaskAgent = TaskController.resolveTaskAgent;
export const getFinalTextFromMessages = TaskController.getFinalTextFromMessages;
export const waitForAgent: TaskController["waitForAgent"] = (agentId, context) =>
	new TaskController().waitForAgent(agentId, context);

// Re-export types introduced by task-controller
export type { TaskExecuteParams, TaskExecuteContext, TaskDetails, TaskResult, RuntimeContext } from "./task-controller.js";

export { randomHexId, pickHumanName, type SubagentRecord, type MetadataFile, type MetadataStoreContext } from "./metadata.js";

/** @deprecated Use MetadataStore instead. */
export function metadataPath(ctx: {
	sessionManager: { getSessionDir(): string; getSessionId(): string };
}): string {
	return MetadataStore.metadataPath({
		sessionDir: ctx.sessionManager.getSessionDir(),
		sessionId: ctx.sessionManager.getSessionId(),
	});
}

/** @deprecated Use MetadataStore instead. */
export function loadMetadata(ctx: {
	sessionManager: {
		getSessionDir(): string;
		getSessionId(): string;
		getSessionFile(): string | undefined;
	};
}): MetadataFile {
	return MetadataStore.loadStatic({
		sessionDir: ctx.sessionManager.getSessionDir(),
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile(),
	});
}

/** @deprecated Use MetadataStore instead. */
export function saveMetadata(
	ctx: {
		sessionManager: {
			getSessionDir(): string;
			getSessionId(): string;
			getSessionFile(): string | undefined;
		};
	},
	metadata: MetadataFile,
): void {
	MetadataStore.saveStatic(
		{
			sessionDir: ctx.sessionManager.getSessionDir(),
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
		},
		metadata,
	);
}
