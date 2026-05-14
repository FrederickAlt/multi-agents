/**
 * Persistent Task subagents for Pi.
 *
 * This extension intentionally exposes one model-facing tool, Task. Each Task
 * creates or resumes a real Pi AgentSession stored in normal session storage.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	getAgentDir,
	getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { MetadataStore, type MetadataFile, type SubagentRecord } from "./metadata.js";
import { type AgentConfig, type AgentScope, AgentRegistry, discoverAgents, formatAgentList } from "./agents.js";
import { PiAgentSessionFactory, PiModelResolver, PiSessionManagerProvider, SubagentSessionManager } from "./session-manager.js";
import { TaskController, type TaskExecuteParams, type TaskExecuteContext, type TaskDetails, type TaskResult, type RuntimeContext, type AgentDiscoveryAdapter } from "./task-controller.js";

const DEFAULT_AGENT_SCOPE: AgentScope = "both";
const REQUIRED_TEMPLATE_VARS = new Set([
	"tools",
	"guidelines",
	"context_files",
	"skills",
	"cwd",
	"date",
	"agent_name",
	"agent_description",
	"parent_agent_id",
	"depth",
]);

export interface PromptParts {
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	promptGuidelines?: string[];
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: Array<{ name: string; description?: string; filePath?: string }>;
	cwd?: string;
}

export interface RenderContext {
	agent: AgentConfig;
	parts: PromptParts;
	parentAgentId?: string;
	depth: number;
}

function today(): string {
	const now = new Date();
	const yyyy = now.getFullYear();
	const mm = String(now.getMonth() + 1).padStart(2, "0");
	const dd = String(now.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function formatTools(parts: PromptParts): string {
	const names = parts.selectedTools ?? [];
	const snippets = parts.toolSnippets ?? {};
	const lines = names.filter((name) => snippets[name]).map((name) => `- ${name}: ${snippets[name]}`);
	return lines.length > 0 ? lines.join("\n") : "(none)";
}

function formatGuidelines(parts: PromptParts): string {
	const guidelines = parts.promptGuidelines ?? [];
	return guidelines.length > 0 ? guidelines.map((g) => `- ${g}`).join("\n") : "(none)";
}

function formatContextFiles(parts: PromptParts): string {
	const files = parts.contextFiles ?? [];
	if (files.length === 0) return "(none)";
	return files.map((file) => `## ${file.path}\n\n${file.content}`).join("\n\n");
}

function formatSkills(parts: PromptParts): string {
	const skills = parts.skills ?? [];
	if (skills.length === 0) return "(none)";
	return skills.map((skill) => `- ${skill.name}${skill.description ? `: ${skill.description}` : ""}`).join("\n");
}

export function renderPromptTemplate(context: RenderContext): string {
	const values: Record<string, string> = {
		tools: formatTools(context.parts),
		guidelines: formatGuidelines(context.parts),
		context_files: formatContextFiles(context.parts),
		skills: formatSkills(context.parts),
		cwd: context.parts.cwd ?? "",
		date: today(),
		agent_name: context.agent.name,
		agent_description: context.agent.description,
		parent_agent_id: context.parentAgentId ?? "",
		depth: String(context.depth),
	};

	return context.agent.systemPrompt.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, rawName: string) => {
		if (!REQUIRED_TEMPLATE_VARS.has(rawName)) {
			throw new Error(`Unknown prompt variable ${match} in ${context.agent.name}.`);
		}
		const value = values[rawName];
		if (value === undefined) {
			throw new Error(`Could not render prompt variable ${match} in ${context.agent.name}.`);
		}
		return value;
	});
}


function findAgent(agents: AgentConfig[], name: string): AgentConfig | undefined {
	return agents.find((agent) => agent.name === name);
}

function buildPromptPartsFromOptions(options: any): PromptParts {
	return {
		selectedTools: options.selectedTools,
		toolSnippets: options.toolSnippets,
		promptGuidelines: options.promptGuidelines,
		contextFiles: options.contextFiles,
		skills: options.skills,
		cwd: options.cwd,
	};
}

function filterExtensionsForAgent(agent: AgentConfig, selfPath: string): (base: any) => any {
	return (base: any) => {
		const allowed = agent.extensions;
		const filtered = base.extensions.filter((extension: any) => {
			if (extension.resolvedPath === selfPath || extension.path === selfPath) return false;
			if (!allowed || allowed.length === 0) return true;
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

export default function (pi: ExtensionAPI) {
	let store: MetadataStore | undefined;
	const selfPath = path.resolve(fileURLToPath(import.meta.url));
	const mainRuntime: RuntimeContext = {
		depth: 0,
		rootMaxDepth: Number.POSITIVE_INFINITY,
	};

	// Create the session manager lazily once the MetadataStore is available.
	let sessionManager: SubagentSessionManager | undefined;

	const getOrCreateSessionManager = (): SubagentSessionManager => {
		if (!sessionManager) {
			sessionManager = new SubagentSessionManager(
				new PiSessionManagerProvider(),
				new PiAgentSessionFactory(),
			);
		}
		return sessionManager;
	};

	const showMessage = (ctx: { ui: { notify(message: string, type?: string): void } }, content: string, type: string = "info") => {
		ctx.ui.notify(content, type);
	};

	const makeTaskToolFactory = (runtime: RuntimeContext): ExtensionFactory => {
		return (subPi) => {
			registerTaskTool(subPi, runtime);
		};
	};

	const makeAgentRuntimeFactory = (agent: AgentConfig, runtime: RuntimeContext): ExtensionFactory => {
		return (subPi) => {
			registerTaskTool(subPi, runtime);
			subPi.on("before_agent_start", async (event) => {
				const prompt = renderPromptTemplate({
					agent,
					parts: buildPromptPartsFromOptions(event.systemPromptOptions),
					parentAgentId: runtime.parentAgentId,
					depth: runtime.depth,
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
			discover(cwd: string, scope: AgentScope) {
				const registry = new AgentRegistry({ cwd, scope });
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
			createResourceLoaderFactory: async (agent, childRuntime) => {
				const loader = new DefaultResourceLoader({
					cwd: params.cwd || ctx.cwd,
					agentDir: getAgentDir(),
					extensionsOverride: filterExtensionsForAgent(agent, selfPath),
					extensionFactories: [makeAgentRuntimeFactory(agent, childRuntime)],
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
		const discovery = discoverAgents(
			runtime.store?.ctx?.sessionDir ?? process.cwd(),
			DEFAULT_AGENT_SCOPE,
		);

		// Filter to only what THIS agent is allowed to spawn.
		// If canSpawn is undefined (root agent with no persona selected),
		// all agents are allowed.
		const allowed = runtime.canSpawn && runtime.canSpawn.length > 0
			? discovery.agents.filter(a => runtime.canSpawn!.includes(a.name))
			: discovery.agents;

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
	}

	pi.registerFlag("agent", {
		description: "Start with a configured agent persona",
		type: "string",
		default: "",
	});

	registerTaskTool(pi, mainRuntime);

	pi.on("session_start", async (_event, ctx) => {
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
		const selectedAgentName = activeStore.selectedMainAgent;
		const selected = selectedAgentName ? findAgent(discoverAgents(ctx.cwd, DEFAULT_AGENT_SCOPE).agents, selectedAgentName) : undefined;
		mainRuntime.rootMaxDepth = selected ? (selected.depth ?? 0) : Number.POSITIVE_INFINITY;
		mainRuntime.canSpawn = selected ? (selected.canSpawn ?? []) : undefined;
	});

	pi.on("session_shutdown", async (event, ctx) => {
		sessionManager?.disposeAll();
		sessionManager = undefined;
		if (event.reason === "new") {
			// Persist selected main agent to globalThis so it survives
			// extension module reload during newSession.
			if (store?.selectedMainAgent) setGlobalSelectedAgent(store.selectedMainAgent);
			store?.cleanup();
			store = undefined;
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!store) store = MetadataStore.fromSessionManager(ctx.sessionManager);
		const selectedAgentName = store.selectedMainAgent;
		if (!selectedAgentName) return;
		const discovery = discoverAgents(ctx.cwd, DEFAULT_AGENT_SCOPE);
		const agent = findAgent(discovery.agents, selectedAgentName);
		if (!agent) throw new Error(`Configured main agent "${selectedAgentName}" was not found.`);
		mainRuntime.store = store;
		mainRuntime.rootMaxDepth = agent.depth ?? 0;
		mainRuntime.canSpawn = agent.canSpawn ?? [];
		const prompt = renderPromptTemplate({
			agent,
			parts: buildPromptPartsFromOptions(event.systemPromptOptions),
			depth: 0,
		});
		return { systemPrompt: prompt };
	});

	pi.registerCommand("agent", {
		description: "Select or show the current main agent persona",
		getArgumentCompletions(prefix) {
			const discovery = discoverAgents(process.cwd(), DEFAULT_AGENT_SCOPE);
			return discovery.agents
				.filter((agent) => agent.name.startsWith(prefix))
				.map((agent) => ({ value: agent.name, label: agent.name, description: agent.description }));
		},
		handler: async (args, ctx) => {
			const name = args.trim();
			const discovery = discoverAgents(ctx.cwd, DEFAULT_AGENT_SCOPE);
			if (!name) {
				const available = formatAgentList(discovery.agents, 30).text;
				const current = store?.selectedMainAgent ?? "(default)";
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
			mainRuntime.rootMaxDepth = agent.depth ?? 0;
			mainRuntime.canSpawn = agent.canSpawn ?? [];
			await ctx.newSession({ parentSession: ctx.sessionManager.getSessionFile() });
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
