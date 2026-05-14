/**
 * Persistent Task subagents for Pi.
 *
 * This extension intentionally exposes one model-facing tool, Task. Each Task
 * creates or resumes a real Pi AgentSession stored in normal session storage.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
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

interface RuntimeContext {
	parentAgentId?: string;
	depth: number;
	rootMaxDepth: number;
	canSpawn?: string[];
	store?: MetadataStore;
}

interface TaskDetails {
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

function today(): string {
	const now = new Date();
	const yyyy = now.getFullYear();
	const mm = String(now.getMonth() + 1).padStart(2, "0");
	const dd = String(now.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

export function checkSpawnAllowed(
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

export function resolveTaskAgent(
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
			const known = store.records.map((item) => `${item.id} (${item.displayName})`).join(", ") || "none";
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

export function getFinalTextFromMessages(messages: any[]): string {
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
const GLOBAL_SYSTEM_PROMPT_OPTIONS_KEY = "__multi_agents_last_system_prompt_options";

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

function getGlobalSystemPromptOptions(): any | undefined {
	return (globalThis as any)[GLOBAL_SYSTEM_PROMPT_OPTIONS_KEY];
}

function setGlobalSystemPromptOptions(options: any): void {
	(globalThis as any)[GLOBAL_SYSTEM_PROMPT_OPTIONS_KEY] = options;
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

	const runTask = async (
		params: { description: string; prompt: string; subagent_type: string; resume?: string; cwd?: string },
		signal: AbortSignal | undefined,
		onUpdate: ((partial: AgentToolResult<TaskDetails>) => void) | undefined,
		ctx: any,
		runtime: RuntimeContext,
	): Promise<AgentToolResult<TaskDetails>> => {
		const effectiveCwd = params.cwd || ctx.cwd;
		const registry = new AgentRegistry({ cwd: effectiveCwd, scope: DEFAULT_AGENT_SCOPE });
		registry.discover();
		const agents = registry.agents;
		const warnings: string[] = registry.diagnostics
			.filter((d) => d.level === "warn")
			.map((d) => `[AgentRegistry] ${d.filePath}: ${d.reason}`);
		const errors = registry.diagnostics.filter((d) => d.level === "error");
		if (errors.length > 0) {
			warnings.push(
				`Some agent definitions were skipped due to errors:\n${errors.map((d) => `- ${d.filePath}: ${d.reason}`).join("\n")}`,
			);
		}
		const activeStore = runtime.store ?? MetadataStore.fromSessionManager(ctx.sessionManager);

		const resolved = resolveTaskAgent(params, activeStore.load(), agents);
		if (!resolved.ok) {
			return {
				content: [{ type: "text", text: resolved.errorText }],
				details: { warnings, error: resolved.errorCode },
			};
		}
		const { agent } = resolved;
		let record = resolved.record;

		const spawnCheck = checkSpawnAllowed(runtime, agent.name);
		if (!spawnCheck.allowed) {
			return {
				content: [{ type: "text", text: spawnCheck.error! }],
				details: { warnings, agentType: agent.name, error: spawnCheck.code },
			};
		}

		if (!record) {
			record = await activeStore.allocateRecord(
				agent.name,
				runtime.parentAgentId,
				runtime.depth + 1,
			);
		}

		const sm = getOrCreateSessionManager();
		const recordId = record.id;
		return sm.withRecordRunLock(recordId, async () => {
			record = activeStore.findRecord(recordId) ?? record!;

			const session = await sm.getOrCreateSession(
				record,
				agent,
				warnings,
				{
					metadataStore: activeStore,
					cwd: effectiveCwd,
					fallbackModel: ctx.model,
					modelResolver: new PiModelResolver(ctx.modelRegistry),
					createResourceLoader: async (agent) => {
						const childRuntime: RuntimeContext = {
							parentAgentId: record.id,
							depth: record.depth,
							rootMaxDepth: runtime.rootMaxDepth,
							canSpawn: agent.canSpawn ?? [],
							store: activeStore,
						};
						const loader = new DefaultResourceLoader({
							cwd: effectiveCwd,
							agentDir: getAgentDir(),
							extensionsOverride: filterExtensionsForAgent(agent, selfPath),
							extensionFactories: [makeAgentRuntimeFactory(agent, childRuntime)],
							systemPromptOverride: () => agent.systemPrompt,
						});
						await loader.reload();
						return loader;
					},
				},
			);

			const emit = (text: string) => {
				onUpdate?.({
					content: [{ type: "text", text }],
					details: {
						id: record.id,
						displayName: record.displayName,
						agentType: record.agentType,
						description: params.description,
						resumed: Boolean(params.resume),
						sessionFile: record.sessionFile,
						warnings,
					},
				});
			};

			const abort = () => {
				void session?.abort();
			};
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });

			try {
				emit(`${record.displayName} (${record.id}) running...`);
				await session.prompt(params.prompt);
				const output = getFinalTextFromMessages(session.messages as any[]);
				const header = `${record.displayName} (${record.id}) completed. Use resume: "${record.id}" to continue this agent.`;
				const warningText = warnings.length > 0 ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
				return {
					content: [{ type: "text", text: `${header}\n\n${output || "(no output)"}${warningText}` }],
					details: {
						id: record.id,
						displayName: record.displayName,
						agentType: record.agentType,
						description: params.description,
						resumed: Boolean(params.resume),
						sessionFile: record.sessionFile,
						warnings,
						output,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const warningText = warnings.length > 0 ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
				return {
					content: [
						{
							type: "text",
							text: `${record.displayName} (${record.id}) failed. Use resume: "${record.id}" to retry or continue this agent.\n\n${message}${warningText}`,
						},
					],
					details: {
						id: record.id,
						displayName: record.displayName,
						agentType: record.agentType,
						description: params.description,
						resumed: Boolean(params.resume),
						sessionFile: record.sessionFile,
						warnings,
						error: message,
					},
				};
			} finally {
				signal?.removeEventListener("abort", abort);
				activeStore.touchRecord(record.id);
				// Dispose the in-memory session to prevent unbounded accumulation.
				// The session file remains on disk; resume reopens from the file.
				sm.disposeSession(record.id);
			}
		});
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
		// Capture system prompt options for /dump-prompt to use
		setGlobalSystemPromptOptions(event.systemPromptOptions);
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

	pi.registerCommand("dump-prompt", {
		description: "Print the resolved system prompt for the current or named agent",
		getArgumentCompletions(prefix) {
			const discovery = discoverAgents(process.cwd(), DEFAULT_AGENT_SCOPE);
			return discovery.agents
				.filter((agent) => agent.name.startsWith(prefix))
				.map((agent) => ({ value: agent.name, label: agent.name, description: agent.description }));
		},
		handler: async (args, ctx) => {
			const name = args.trim();

			// No argument: dump the current effective system prompt (live, fully resolved)
			if (!name) {
				const currentPrompt = ctx.getSystemPrompt();
				const label = store?.selectedMainAgent
					? `Current prompt (agent: ${store.selectedMainAgent})`
					: "Current prompt (default Pi agent)";
				showMessage(ctx, `# ${label}\n\n${currentPrompt}`, "info");
				return;
			}

			// Named agent: render the agent template with the captured system-prompt options
			const discovery = discoverAgents(ctx.cwd, DEFAULT_AGENT_SCOPE);
			const targetAgent = findAgent(discovery.agents, name);
			if (!targetAgent) {
				const available = formatAgentList(discovery.agents, 30).text;
				showMessage(ctx, `Unknown agent "${name}".\n\nAvailable: ${available}`, "warning");
				return;
			}

			// Use the last systemPromptOptions captured by before_agent_start,
			// falling back to cwd-only parts if none have been captured yet.
			const capturedOptions = getGlobalSystemPromptOptions();
			const promptParts: PromptParts = capturedOptions
				? buildPromptPartsFromOptions(capturedOptions)
				: { cwd: ctx.cwd };
			promptParts.cwd ??= ctx.cwd;

			const prompt = renderPromptTemplate({
				agent: targetAgent,
				parts: promptParts,
				depth: 0,
			});
			showMessage(ctx, `# Resolved prompt for ${targetAgent.name}\n\n${prompt}`, "info");
		},
	});

}

// ---------------------------------------------------------------------------
// Compatibility re-exports for existing tests
// ---------------------------------------------------------------------------

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
