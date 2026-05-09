/**
 * Persistent Task subagents for Pi.
 *
 * This extension intentionally exposes one model-facing tool, Task. Each Task
 * creates or resumes a real Pi AgentSession stored in normal session storage.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Model, ThinkingLevel } from "@mariozechner/pi-ai";
import {
	AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	getAgentDir,
	getMarkdownTheme,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents.js";

const CUSTOM_TYPE = "persistent-task-subagents";
const DEFAULT_AGENT_SCOPE: AgentScope = "both";
const HEX_ID_BYTES = 4;
const HUMAN_NAMES = [
	"Tom",
	"Ada",
	"Max",
	"Ivy",
	"Leo",
	"Nora",
	"Sam",
	"Mia",
	"Eli",
	"Zoe",
	"Kai",
	"Ava",
	"Ben",
	"Lia",
	"Gus",
	"Nia",
	"Ray",
	"Uma",
	"Jan",
	"Eva",
	"Sol",
	"Kim",
	"Ari",
	"Liv",
	"Cal",
	"Bea",
	"Ned",
	"Pia",
	"Ren",
	"Tess",
];

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
	store?: MetadataContext;
}

interface MetadataContext {
	sessionManager: {
		getSessionDir(): string;
		getSessionId(): string;
		getSessionFile(): string | undefined;
	};
}

export interface SubagentRecord {
	id: string;
	humanName: string;
	displayName: string;
	agentType: string;
	sessionFile: string;
	parentAgentId?: string;
	depth: number;
	createdAt: string;
	updatedAt: string;
}

export interface MetadataFile {
	version: 1;
	mainSessionId: string;
	mainSessionFile?: string;
	selectedMainAgent?: string;
	records: SubagentRecord[];
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

const TaskParams = Type.Object({
	description: Type.String({ description: "Short 3-5 word description of the task." }),
	prompt: Type.String({
		description: "Full task description for the agent to perform autonomously. The agent reports back once.",
	}),
	subagent_type: Type.String({ description: "Configured sub-agent type to use." }),
	resume: Type.Optional(Type.String({ description: "Short hex ID of a previous sub-agent to continue." })),
});

function today(): string {
	const now = new Date();
	const yyyy = now.getFullYear();
	const mm = String(now.getMonth() + 1).padStart(2, "0");
	const dd = String(now.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

export function metadataPath(ctx: { sessionManager: { getSessionDir(): string; getSessionId(): string } }): string {
	return path.join(ctx.sessionManager.getSessionDir(), `.task-subagents-${ctx.sessionManager.getSessionId()}.json`);
}

function toMetadataContext(ctx: MetadataContext): MetadataContext {
	const sessionDir = ctx.sessionManager.getSessionDir();
	const sessionId = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	return {
		sessionManager: {
			getSessionDir: () => sessionDir,
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
		},
	};
}

export function loadMetadata(ctx: { sessionManager: { getSessionDir(): string; getSessionId(): string; getSessionFile(): string | undefined } }): MetadataFile {
	const filePath = metadataPath(ctx);
	if (fs.existsSync(filePath)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as MetadataFile;
			if (parsed.version === 1 && Array.isArray(parsed.records)) return parsed;
		} catch {
			// Fall through to a clean metadata file.
		}
	}
	return {
		version: 1,
		mainSessionId: ctx.sessionManager.getSessionId(),
		mainSessionFile: ctx.sessionManager.getSessionFile(),
		records: [],
	};
}

export function saveMetadata(ctx: { sessionManager: { getSessionDir(): string; getSessionId(): string; getSessionFile(): string | undefined } }, metadata: MetadataFile): void {
	const filePath = metadataPath(ctx);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	metadata.mainSessionId = ctx.sessionManager.getSessionId();
	metadata.mainSessionFile = ctx.sessionManager.getSessionFile();
	fs.writeFileSync(filePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
}

function deleteMetadataAndSubsessions(ctx: { sessionManager: { getSessionDir(): string; getSessionId(): string; getSessionFile(): string | undefined } }): void {
	const metadata = loadMetadata(ctx);
	for (const record of metadata.records) {
		try {
			if (record.sessionFile) fs.unlinkSync(record.sessionFile);
		} catch {
			// Ignore cleanup errors.
		}
	}
	try {
		fs.unlinkSync(metadataPath(ctx));
	} catch {
		// Ignore cleanup errors.
	}
}

export function randomHexId(existing: Set<string>): string {
	for (let attempt = 0; attempt < 1000; attempt++) {
		const id = Array.from(randomBytes(HEX_ID_BYTES))
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		if (!existing.has(id)) return id;
	}
	throw new Error("Could not allocate a unique sub-agent ID.");
}

export function pickHumanName(agentName: string, records: SubagentRecord[]): { humanName: string; displayName: string } {
	const used = new Set(records.map((record) => record.humanName));
	for (const name of HUMAN_NAMES) {
		if (!used.has(name)) return { humanName: name, displayName: `${agentName} ${name}` };
	}
	for (let i = 1; ; i++) {
		for (const base of HUMAN_NAMES) {
			const name = `${base}${i}`;
			if (!used.has(name)) return { humanName: name, displayName: `${agentName} ${name}` };
		}
	}
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

function modelFromConfig(
	modelRegistry: any,
	modelName: string | undefined,
	fallback?: Model<any>,
	warnings?: string[],
): Model<any> | undefined {
	if (!modelName) return undefined;
	let model: Model<any> | undefined;
	if (modelName.includes("/")) {
		const [provider, id] = modelName.split("/", 2);
		model = modelRegistry.find(provider, id);
	} else {
		const all = typeof modelRegistry.getAll === "function" ? modelRegistry.getAll() : [];
		model = all.find((candidate: Model<any>) => candidate.id === modelName || `${candidate.provider}/${candidate.id}` === modelName);
	}
	if (!model) {
		warnings?.push(`Configured model "${modelName}" was not found; using the current/default model.`);
		return fallback;
	}
	if (typeof modelRegistry.hasConfiguredAuth === "function" && !modelRegistry.hasConfiguredAuth(model)) {
		warnings?.push(`Configured model "${modelName}" is not available because its provider is not authenticated; using the current/default model.`);
		return fallback;
	}
	return model;
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

function buildPromptPartsFromSession(session: AgentSession): PromptParts {
	const selectedTools = session.getActiveToolNames();
	const toolSnippets: Record<string, string> = {};
	const promptGuidelines: string[] = [];
	for (const name of selectedTools) {
		const definition = session.getToolDefinition(name) as any;
		if (definition?.promptSnippet) toolSnippets[name] = definition.promptSnippet;
		if (Array.isArray(definition?.promptGuidelines)) promptGuidelines.push(...definition.promptGuidelines);
	}
	return {
		selectedTools,
		toolSnippets,
		promptGuidelines,
		cwd: session.sessionManager.getCwd(),
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

async function renderAgentPromptForDump(
	agent: AgentConfig,
	cwd: string,
	modelRegistry: any,
	runtime: RuntimeContext,
	taskToolFactory: ExtensionFactory,
	selfPath: string,
): Promise<{ prompt: string; warnings: string[] }> {
	const warnings: string[] = [];
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		extensionsOverride: filterExtensionsForAgent(agent, selfPath),
		extensionFactories: [taskToolFactory],
		systemPromptOverride: () => agent.systemPrompt,
	});
	await loader.reload();
	const sessionManager = SessionManager.inMemory(cwd);
	const session = (
		await createAgentSession({
			cwd,
			model: modelFromConfig(modelRegistry, agent.model, undefined, warnings),
			tools: agent.tools,
			resourceLoader: loader,
			sessionManager,
		})
	).session;
	try {
		if (agent.tools) {
			const active = new Set(session.getActiveToolNames());
			for (const tool of agent.tools) {
				if (!active.has(tool)) warnings.push(`Configured tool "${tool}" is not available for ${agent.name}.`);
			}
		}
		const prompt = renderPromptTemplate({
			agent,
			parts: buildPromptPartsFromSession(session),
			parentAgentId: runtime.parentAgentId,
			depth: runtime.depth,
		});
		return { prompt, warnings };
	} finally {
		session.dispose();
	}
}

export default function (pi: ExtensionAPI) {
	let metadata: MetadataFile | undefined;
	let selectedMainAgent: string | undefined;
	const openSessions = new Map<string, AgentSession>();
	// Serializes metadata read-allocate-write to prevent races between concurrent Task calls.
	let metadataLock: Promise<void> = Promise.resolve();
	const selfPath = path.resolve(fileURLToPath(import.meta.url));
	const mainRuntime: RuntimeContext = {
		depth: 0,
		rootMaxDepth: Number.POSITIVE_INFINITY,
	};

	const showMessage = (content: string) => {
		pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content,
				display: true,
			},
			{ triggerTurn: false },
		);
	};

	pi.registerMessageRenderer(CUSTOM_TYPE, (message, _options, _theme) => {
		const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2);
		return new Markdown(content, 0, 0, getMarkdownTheme());
	});

	const getMetadata = (ctx: { sessionManager: { getSessionDir(): string; getSessionId(): string; getSessionFile(): string | undefined } }) => {
		metadata = loadMetadata(ctx);
		selectedMainAgent = metadata.selectedMainAgent;
		return metadata;
	};

	const persistMetadata = (ctx: { sessionManager: { getSessionDir(): string; getSessionId(): string; getSessionFile(): string | undefined } }) => {
		if (!metadata) metadata = loadMetadata(ctx);
		metadata.selectedMainAgent = selectedMainAgent;
		saveMetadata(ctx, metadata);
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

	const createSessionForRecord = async (
		ctx: any,
		record: SubagentRecord,
		agent: AgentConfig,
		runtime: RuntimeContext,
		warnings: string[],
	): Promise<AgentSession> => {
		const loader = new DefaultResourceLoader({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			extensionsOverride: filterExtensionsForAgent(agent, selfPath),
			extensionFactories: [
				makeAgentRuntimeFactory(agent, {
					parentAgentId: record.id,
					depth: record.depth,
					rootMaxDepth: runtime.rootMaxDepth,
					canSpawn: agent.canSpawn ?? [],
					store: runtime.store,
				}),
			],
			systemPromptOverride: () => agent.systemPrompt,
		});
		await loader.reload();

		const sessionDir = (runtime.store ?? ctx).sessionManager.getSessionDir();
		const sessionManager = fs.existsSync(record.sessionFile)
			? SessionManager.open(record.sessionFile, sessionDir, ctx.cwd)
			: SessionManager.create(ctx.cwd, sessionDir);
		record.sessionFile = sessionManager.getSessionFile() ?? record.sessionFile;
		persistMetadata(runtime.store ?? ctx);

		const session = (
			await createAgentSession({
				cwd: ctx.cwd,
				model: modelFromConfig(ctx.modelRegistry, agent.model, ctx.model, warnings),
				tools: agent.tools,
				resourceLoader: loader,
				sessionManager,
				thinkingLevel: agent.reasoningEffort as ThinkingLevel | undefined,
			})
		).session;

		if (agent.tools) {
			const active = new Set(session.getActiveToolNames());
			for (const tool of agent.tools) {
				if (!active.has(tool)) warnings.push(`Configured tool "${tool}" is not available for ${agent.name}.`);
			}
		}

		const unsubscribe = session.subscribe((event: any) => {
			if (event.type === "agent_end") {
				record.updatedAt = new Date().toISOString();
				persistMetadata(runtime.store ?? ctx);
			}
		});
		const originalDispose = session.dispose.bind(session);
		session.dispose = () => {
			unsubscribe();
			originalDispose();
		};
		return session;
	};

	const runTask = async (
		params: { description: string; prompt: string; subagent_type: string; resume?: string },
		signal: AbortSignal | undefined,
		onUpdate: ((partial: AgentToolResult<TaskDetails>) => void) | undefined,
		ctx: any,
		runtime: RuntimeContext,
	): Promise<AgentToolResult<TaskDetails>> => {
		const discovery = discoverAgents(ctx.cwd, DEFAULT_AGENT_SCOPE);
		const agents = discovery.agents;
		const warnings: string[] = [];
		const storeCtx = runtime.store ?? toMetadataContext(ctx);
		const store = getMetadata(storeCtx);

		const resolved = resolveTaskAgent(params, store, agents);
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
			// Serialize metadata allocation to prevent concurrent Task calls
			// from picking the same hex ID or human name.
			const prevLock = metadataLock;
			let releaseLock: () => void;
			metadataLock = new Promise<void>((resolve) => { releaseLock = resolve; });
			await prevLock;
			try {
				// Re-read metadata after acquiring lock in case another
				// concurrent Task already wrote new records.
				const fresh = getMetadata(storeCtx);
				const id = randomHexId(new Set(fresh.records.map((item) => item.id)));
				const names = pickHumanName(agent.name, fresh.records);
				const now = new Date().toISOString();
				record = {
					id,
					humanName: names.humanName,
					displayName: names.displayName,
					agentType: agent.name,
					sessionFile: "",
					parentAgentId: runtime.parentAgentId,
					depth: runtime.depth + 1,
					createdAt: now,
					updatedAt: now,
				};
				fresh.records.push(record);
				saveMetadata(storeCtx, fresh);
			} finally {
				releaseLock();
			}
		}

		let session = openSessions.get(record.id);
		if (!session) {
			session = await createSessionForRecord(ctx, record, agent, runtime, warnings);
			openSessions.set(record.id, session);
		}

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
			record.updatedAt = new Date().toISOString();
			persistMetadata(storeCtx);
			// Dispose the in-memory session to prevent unbounded accumulation.
			// The session file remains on disk; resume reopens from the file.
			session.dispose();
			openSessions.delete(record.id);
		}
	};

	function registerTaskTool(targetPi: ExtensionAPI, runtime: RuntimeContext): void {
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
			parameters: TaskParams,
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
		const storeCtx = toMetadataContext(ctx);
		mainRuntime.store = storeCtx;
		const store = getMetadata(storeCtx);
		const flagAgent = pi.getFlag("agent");
		if (typeof flagAgent === "string" && flagAgent.trim()) {
			selectedMainAgent = flagAgent.trim();
			store.selectedMainAgent = selectedMainAgent;
			persistMetadata(storeCtx);
		}
		const selected = selectedMainAgent ? findAgent(discoverAgents(ctx.cwd, DEFAULT_AGENT_SCOPE).agents, selectedMainAgent) : undefined;
		mainRuntime.rootMaxDepth = selected ? (selected.depth ?? 0) : Number.POSITIVE_INFINITY;
		mainRuntime.canSpawn = selected ? (selected.canSpawn ?? []) : undefined;
	});

	pi.on("session_shutdown", async (event, ctx) => {
		for (const session of openSessions.values()) session.dispose();
		openSessions.clear();
		if (event.reason === "new") {
			deleteMetadataAndSubsessions(ctx);
			metadata = undefined;
			selectedMainAgent = undefined;
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!selectedMainAgent) getMetadata(toMetadataContext(ctx));
		if (!selectedMainAgent) return;
		const discovery = discoverAgents(ctx.cwd, DEFAULT_AGENT_SCOPE);
		const agent = findAgent(discovery.agents, selectedMainAgent);
		if (!agent) throw new Error(`Configured main agent "${selectedMainAgent}" was not found.`);
		mainRuntime.store = toMetadataContext(ctx);
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
				showMessage(`Current agent: ${selectedMainAgent ?? "(default)"}\n\nAvailable: ${available}`);
				return;
			}
			const agent = findAgent(discovery.agents, name);
			if (!agent) {
				const available = formatAgentList(discovery.agents, 30).text;
				showMessage(`Unknown agent "${name}".\n\nAvailable: ${available}`);
				return;
			}
			const storeCtx = toMetadataContext(ctx);
			getMetadata(storeCtx);
			selectedMainAgent = agent.name;
			mainRuntime.store = storeCtx;
			mainRuntime.rootMaxDepth = agent.depth ?? 0;
			mainRuntime.canSpawn = agent.canSpawn ?? [];
			persistMetadata(storeCtx);
			await ctx.newSession({ parentSession: ctx.sessionManager.getSessionFile() });
		},
	});

	pi.registerCommand("dump-prompt", {
		description: "Dump the current or configured agent system prompt",
		getArgumentCompletions(prefix) {
			const discovery = discoverAgents(process.cwd(), DEFAULT_AGENT_SCOPE);
			return discovery.agents
				.filter((agent) => agent.name.startsWith(prefix))
				.map((agent) => ({ value: agent.name, label: agent.name, description: agent.description }));
		},
		handler: async (args, ctx) => {
			const storeCtx = toMetadataContext(ctx);
			getMetadata(storeCtx);
			const name = args.trim();
			if (!name && !selectedMainAgent) {
				showMessage(ctx.getSystemPrompt());
				return;
			}

			const discovery = discoverAgents(ctx.cwd, DEFAULT_AGENT_SCOPE);
			const agentName = name || selectedMainAgent;
			const agent = agentName ? findAgent(discovery.agents, agentName) : undefined;
			if (!agent) {
				showMessage(`Unknown agent "${agentName}".`);
				return;
			}

			const taskFactory = makeTaskToolFactory({
				depth: 0,
				rootMaxDepth: agent.depth ?? 0,
				canSpawn: agent.canSpawn ?? [],
				store: storeCtx,
			});
			const rendered = await renderAgentPromptForDump(
				agent,
				ctx.cwd,
				ctx.modelRegistry,
				{ depth: 0, rootMaxDepth: agent.depth ?? 0, canSpawn: agent.canSpawn ?? [], store: storeCtx },
				taskFactory,
				selfPath,
			);
			const warnings =
				rendered.warnings.length > 0 ? `\n\nWarnings:\n${rendered.warnings.map((w) => `- ${w}`).join("\n")}` : "";
			showMessage(`${rendered.prompt}${warnings}`);
		},
	});
}
