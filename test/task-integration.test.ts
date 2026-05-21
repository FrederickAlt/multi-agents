/**
 * Integration tests for the persistent-task-subagents extension.
 *
 * Tests extension loading, tool registration, command handlers.
 * LLM-dependent tests require API_KEY from env.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync as wfs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { fauxAssistantMessage, getModel, registerFauxProvider } from "@mariozechner/pi-ai";
import taskExtension, { configureTaskToolForRuntime, filterExtensionsForAgent } from "../subagent/index.js";
import { childPolicy, selectedRootPolicy } from "../subagent/depth-policy.js";
import type { AgentConfig } from "../subagent/agents.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDir(p: string) {
	mkdirSync(p, { recursive: true });
}

function writeFile(p: string, content: string) {
	makeDir(join(p, ".."));
	wfs(p, content, "utf-8");
}

function createFakeExtensionApi(options: { activeTools?: string[] } = {}) {
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	const flags = new Map<string, string | boolean | undefined>();
	const registeredTools: any[] = [];
	let activeTools = [...(options.activeTools ?? ["read", "bash", "edit", "write"])];
	const pi = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: (tool: any) => { registeredTools.push(tool); },
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerFlag: (name: string, options: { default?: string | boolean }) => flags.set(name, options.default),
		getFlag: (name: string) => flags.get(name),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		_registeredTools: registeredTools,
		_getActiveTools: () => [...activeTools],
	} as any;
	return { pi, handlers, commands, flags };
}

function makeSessionManager(dir: string, sessionId: string) {
	return {
		getSessionDir: () => dir,
		getSessionId: () => sessionId,
		getSessionFile: () => join(dir, `${sessionId}.jsonl`),
	};
}

function makeAgent(name: string, overrides: Partial<Pick<AgentConfig, "depth" | "can_spawn">>): AgentConfig {
	return {
		name,
		description: `${name} description`,
		systemPrompt: `${name} prompt`,
		source: "project",
		filePath: join(tmpdir(), `${name}.md`),
		...overrides,
	};
}

function latestTaskTool(pi: any) {
	return [...((pi as any)._registeredTools ?? [])].reverse().find((tool: any) => tool.name === "Task");
}

// ---------------------------------------------------------------------------
// Extension loading and tool registration (no LLM required)
// ---------------------------------------------------------------------------

describe("extension loading", () => {
	let tempDir: string;
	let agentDir: string;

	let agentDiscoveryDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-task-ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		makeDir(agentDir);

		// Agent discovery now uses only ~/.pi/agent/ paths.
		// Point PI_CODING_AGENT_DIR to a temp dir with agents/ subdir.
		agentDiscoveryDir = join(tempDir, "agent-discovery");
		const agentsDir = join(agentDiscoveryDir, "agents");
		makeDir(agentsDir);
		makeDir(join(agentDiscoveryDir, "prompt-parts"));
		process.env.PI_CODING_AGENT_DIR = agentDiscoveryDir;

		// Seed common agents and prompt parts needed by most tests.
		// Individual tests may overwrite these with their own variants.
		writeFile(join(agentsDir, "default.md"), `---\ndescription: Default Root Agent\ndepth: 1\n---\n\nDefault Root Agent\n`);
		writeFile(join(agentsDir, "explorer.md"), `---\ndescription: Fast codebase recon\ndepth: 1\n---\n\nExplorer agent\n`);
		writeFile(join(agentsDir, "reviewer.md"), `---\ndescription: Code review specialist\ndepth: 1\n---\n\nReviewer agent\n`);
		writeFile(join(agentsDir, "planner.md"), `---\ndescription: software architect and planning specialist\ndepth: 1\n---\n\nYou are a software architect and planning specialist.\n`);
		writeFile(join(agentDiscoveryDir, "prompt-parts", "010-tools.md"), `---\ndescription: Available tool list\n---\n\n## Available Tools\n\n{{tools}}\n`);
		writeFile(join(agentDiscoveryDir, "prompt-parts", "020-guidelines.md"), `---\ndescription: Prompt guidelines\n---\n\n## Guidelines\n\n{{guidelines}}\n`);

		// Redirect in-memory session dirs to tempDir so .task-subagents-*.json
		// metadata files don't end up in the repo root (SessionManager.inMemory
		// uses sessionDir = "", which makes metadataPath resolve to process.cwd()).
		const origInMemory = SessionManager.inMemory.bind(SessionManager);
		vi.spyOn(SessionManager, "inMemory").mockImplementation((cwd?: string) => {
			const sm = origInMemory(cwd);
			vi.spyOn(sm, "getSessionDir").mockReturnValue(tempDir);
			return sm;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PI_CODING_AGENT_DIR;
		delete (globalThis as any).__multi_agents_selected_main_agent;
		if (tempDir && existsSync(tempDir)) {
			try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	it("registers the Task tool with correct name and schema", async () => {
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			extensionFactories: [taskExtension],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			sessionManager,
			resourceLoader,
		});

		// Bind extensions so session_start fires and registers Task via the resolved policy
		await session.bindExtensions({});

		const allTools = session.getAllTools();
		const taskTool = allTools.find((t) => t.name === "Task");
		expect(taskTool).toBeDefined();
		expect(taskTool?.description).toContain("Delegate");

		// Verify parameters schema has required fields
		const params = taskTool?.parameters as any;
		expect(params).toBeDefined();
		expect(params.properties.description).toBeDefined();
		expect(params.properties.prompt).toBeDefined();
		expect(params.properties.subagent_type).toBeDefined();
		expect(params.properties.resume).toBeDefined();

		session.dispose();
	});

	it("Task tool has promptSnippet and promptGuidelines for LLM context", async () => {
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			extensionFactories: [taskExtension],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			sessionManager,
			resourceLoader,
		});

		// Bind extensions so session_start fires and registers Task via the resolved policy
		await session.bindExtensions({});

		const taskTool = session.getAllTools().find((t) => t.name === "Task");
		expect(taskTool).toBeDefined();
		expect(taskTool?.description).toBeDefined();

		session.dispose();
	});

	it("renders the configured default Root agent when the session has no /agent selection", async () => {
		writeFile(join(agentDiscoveryDir, "agents", "default.md"), `---\ndescription: Project Default Root\ndepth: 1\n---\n\nProject Default Root Marker\n`);
		const { pi, handlers } = createFakeExtensionApi();
		taskExtension(pi);

		const sessionManager = makeSessionManager(tempDir, "root-session");
		const result = await handlers.get("before_agent_start")({
			systemPrompt: "Pi base prompt that should be replaced for Agent definitions",
			systemPromptOptions: {
				selectedTools: ["read"],
				toolSnippets: { read: "Read file contents" },
				promptGuidelines: ["Use read for file inspection"],
				contextFiles: [],
				skills: [],
				cwd: tempDir,
				appendSystemPrompt: "",
			},
		}, { cwd: tempDir, sessionManager });

		expect(result?.systemPrompt).toContain("Project Default Root Marker");
		expect(result?.systemPrompt).toContain("## Available Tools");
		expect(result?.systemPrompt).toContain("- read: Read file contents");
	});

	it("does not preserve hidden Pi prompt material for Root Agent definitions", async () => {
		writeFile(join(agentDiscoveryDir, "agents", "default.md"), `---\ndescription: Project Default Root\ndepth: 1\n---\n\nRoot Agent Marker\n`);
		const { pi, handlers } = createFakeExtensionApi();
		taskExtension(pi);

		const sessionManager = makeSessionManager(tempDir, "root-no-hidden-session");
		const result = await handlers.get("before_agent_start")({
			systemPrompt: "Pi base prompt\n\n# Project Context\n\nimplicit AGENTS content",
			systemPromptOptions: {
				selectedTools: ["read"],
				toolSnippets: { read: "Read file contents" },
				promptGuidelines: [],
				contextFiles: [{ path: "AGENTS.md", content: "implicit AGENTS content" }],
				skills: [],
				cwd: tempDir,
				appendSystemPrompt: "APPEND_SYSTEM content",
			},
		}, { cwd: tempDir, sessionManager });

		expect(result?.systemPrompt).toContain("Root Agent Marker");
		expect(result?.systemPrompt).not.toContain("Pi base prompt");
		expect(result?.systemPrompt).not.toContain("APPEND_SYSTEM content");
		expect(result?.systemPrompt).not.toContain("implicit AGENTS content");
	});

	it("renders a configured non-default Root agent when the session has no /agent selection", async () => {
		writeFile(join(agentDiscoveryDir, "agents", "customroot.md"), `---\ndescription: Custom Root agent\ndepth: 1\n---\n\nCustom Root Marker\n`);
		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);
		flags.set("defaultRootAgent", "customroot");

		const sessionManager = makeSessionManager(tempDir, "custom-root-session");
		const result = await handlers.get("before_agent_start")({
			systemPrompt: "Pi base prompt",
			systemPromptOptions: { cwd: tempDir },
		}, { cwd: tempDir, sessionManager });

		expect(result?.systemPrompt).toContain("Custom Root Marker");
		expect(result?.systemPrompt).not.toContain("You are an expert coding assistant operating inside pi");
	});

	it("throws a visible error when the configured default Root agent is missing", async () => {
		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);
		flags.set("defaultRootAgent", "missing-root");

		const sessionManager = makeSessionManager(tempDir, "missing-default-session");

		await expect(handlers.get("before_agent_start")({
			systemPrompt: "Pi base prompt",
			systemPromptOptions: { cwd: tempDir },
		}, { cwd: tempDir, sessionManager })).rejects.toThrow('Default Root agent "missing-root" was not found');
	});

	it("blocks a real AgentSession turn when the configured default Root agent is missing", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("RAW/BASE PROMPT CONTINUED")]);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: faux.api,
			apiKey: "faux-key",
			models: faux.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			extensionFactories: [taskExtension],
		});
		await resourceLoader.reload();
		resourceLoader.getExtensions().runtime.flagValues.set("defaultRootAgent", "missing-root");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			modelRegistry,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
		});
		const notifications: Array<{ message: string; type?: string }> = [];

		try {
			await session.bindExtensions({
				uiContext: {
					notify: (message: string, type?: string) => notifications.push({ message, type }),
				} as any,
			});
			await session.prompt("hello");

			expect(notifications).toContainEqual(expect.objectContaining({
				message: expect.stringContaining('Default Root agent "missing-root" was not found'),
				type: "error",
			}));
			expect(faux.state.callCount).toBe(0);
			expect(faux.getPendingResponseCount()).toBe(1);
			expect(session.messages.some((message) => message.role === "assistant")).toBe(false);
		} finally {
			session.dispose();
			faux.unregister();
		}
	});

	it("/agent applies a session-local Root selection without mutating the configured default", async () => {
		const { pi, handlers, commands, flags } = createFakeExtensionApi();
		taskExtension(pi);

		const sessionManager = makeSessionManager(tempDir, "selected-root-session");
		const ctx = {
			cwd: tempDir,
			sessionManager,
			ui: { notify: () => {} },
			newSession: async () => ({ cancelled: true }),
		};

		await commands.get("agent").handler("planner", ctx);
		const result = await handlers.get("before_agent_start")({
			systemPrompt: "Pi base prompt",
			systemPromptOptions: { cwd: tempDir },
		}, ctx);

		expect(flags.get("defaultRootAgent")).toBe("default");
		expect(result?.systemPrompt).toContain("software architect and planning specialist");
		expect(result?.systemPrompt).not.toContain("You are an expert coding assistant operating inside pi");
	});

	// ------------------------------------------------------------------
	// Task hiding when DepthPolicy has no spawnable targets (issue #13)
	// ------------------------------------------------------------------

	it("hides Task when the resolved Root agent has depth 0", async () => {
		writeFile(join(agentDiscoveryDir, "agents", "leaf-root.md"), `---\ndescription: Leaf Root agent with depth 0\ndepth: 0\n---\n\nLeaf Root Marker\n`);
		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);
		flags.set("defaultRootAgent", "leaf-root");

		const sessionManager = makeSessionManager(tempDir, "leaf-root-session");
		// Fire before_agent_start so the Root agent is resolved and Task registration runs
		await handlers.get("before_agent_start")({
			systemPrompt: "Pi base prompt",
			systemPromptOptions: { cwd: tempDir },
		}, { cwd: tempDir, sessionManager });

		// Verify Task was NOT registered (no spawnable agents)
		const registeredTools = (pi as any)._registeredTools ?? [];
		const taskTool = registeredTools.find((t: any) => t.name === "Task");
		expect(taskTool).toBeUndefined();
	});

	it("hides Task when the resolved Root agent has empty can_spawn", async () => {
		// Bare `can_spawn:` (null in YAML) or `can_spawn: ""` both produce an empty array → no spawnable agents
		writeFile(join(agentDiscoveryDir, "agents", "restrictive-root.md"), `---\ndescription: Restrictive Root agent\ndepth: 1\ncan_spawn:\n---\n\nRestrictive Root Marker\n`);
		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);
		flags.set("defaultRootAgent", "restrictive-root");

		const sessionManager = makeSessionManager(tempDir, "restrictive-root-session");
		await handlers.get("before_agent_start")({
			systemPrompt: "Pi base prompt",
			systemPromptOptions: { cwd: tempDir },
		}, { cwd: tempDir, sessionManager });

		const registeredTools = (pi as any)._registeredTools ?? [];
		const taskTool = registeredTools.find((t: any) => t.name === "Task");
		expect(taskTool).toBeUndefined();
	});

	it("registers Task when the resolved Root agent has spawnable targets", async () => {
		writeFile(join(agentDiscoveryDir, "agents", "spawning-root.md"), `---\ndescription: Spawning Root agent\ndepth: 1\n---\n\nSpawning Root Marker\n`);
		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);
		flags.set("defaultRootAgent", "spawning-root");

		const sessionManager = makeSessionManager(tempDir, "spawning-root-session");
		await handlers.get("before_agent_start")({
			systemPrompt: "Pi base prompt",
			systemPromptOptions: { cwd: tempDir },
		}, { cwd: tempDir, sessionManager });

		const registeredTools = (pi as any)._registeredTools ?? [];
		const taskTool = registeredTools.find((t: any) => t.name === "Task");
		expect(taskTool).toBeDefined();
	});

	it("Task subagent_type schema only offers spawnable agent types", async () => {
		writeFile(join(agentDiscoveryDir, "agents", "filtered-root.md"), `---\ndescription: Filtered Root agent\ndepth: 1\ncan_spawn:\n  - explorer\n---\n\nFiltered Root Marker\n`);
		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);
		flags.set("defaultRootAgent", "filtered-root");

		const sessionManager = makeSessionManager(tempDir, "filtered-root-session");
		await handlers.get("before_agent_start")({
			systemPrompt: "Pi base prompt",
			systemPromptOptions: { cwd: tempDir },
		}, { cwd: tempDir, sessionManager });

		const taskTool = latestTaskTool(pi);
		expect(taskTool).toBeDefined();
		// The enum should only include "explorer"
		const subagentType = taskTool?.parameters?.properties?.subagent_type;
		expect(subagentType).toBeDefined();
		// TypeBox enum fields have a `enum` property with the allowed values
		const enumValues: string[] = subagentType?.enum ?? [];
		expect(enumValues).toEqual(["explorer"]);
	});

	it("deactivates a stale Task tool when a later Root policy has no spawnable targets", async () => {
		writeFile(join(agentDiscoveryDir, "agents", "spawning-root.md"), `---\ndescription: Spawning Root agent\ndepth: 1\ncan_spawn:\n  - explorer\n---\n\nSpawning Root Marker\n`);
		writeFile(join(agentDiscoveryDir, "agents", "leaf-root.md"), `---\ndescription: Leaf Root agent\ndepth: 0\n---\n\nLeaf Root Marker\n`);
		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);

		const sessionManager = makeSessionManager(tempDir, "stale-root-session");
		flags.set("defaultRootAgent", "spawning-root");
		await handlers.get("before_agent_start")({
			systemPrompt: "Pi base prompt",
			systemPromptOptions: { cwd: tempDir },
		}, { cwd: tempDir, sessionManager });
		expect((pi as any)._getActiveTools()).toContain("Task");

		flags.set("defaultRootAgent", "leaf-root");
		await handlers.get("before_agent_start")({
			systemPrompt: "Pi base prompt",
			systemPromptOptions: { cwd: tempDir },
		}, { cwd: tempDir, sessionManager });

		expect(latestTaskTool(pi)).toBeDefined();
		expect((pi as any)._getActiveTools()).not.toContain("Task");
	});

	it("does not expose Task for a child agent with depth 0", async () => {
		const parentPolicy = selectedRootPolicy(makeAgent("root", { depth: 2 }));
		const childAgent = makeAgent("leaf-child", { depth: 0, can_spawn: ["explorer"] });
		const runtime = {
			parentAgentId: "child-id",
			treeDepth: 1,
			depthPolicy: childPolicy(parentPolicy, childAgent, 1),
		};
		const { pi } = createFakeExtensionApi({ activeTools: ["read", "Task"] });

		configureTaskToolForRuntime(pi, runtime, async () => ({
			content: [{ type: "text", text: "unused" }],
			details: { warnings: [] },
		}));

		expect(latestTaskTool(pi)).toBeUndefined();
		expect((pi as any)._getActiveTools()).not.toContain("Task");
	});

	it("exposes Task for a child agent with allowed targets and filters the enum", async () => {
		const parentPolicy = selectedRootPolicy(makeAgent("root", { depth: 3 }));
		const childAgent = makeAgent("delegating-child", { depth: 1, can_spawn: ["explorer", "reviewer"] });
		const runtime = {
			parentAgentId: "child-id",
			treeDepth: 1,
			depthPolicy: childPolicy(parentPolicy, childAgent, 1),
		};
		const { pi } = createFakeExtensionApi();

		configureTaskToolForRuntime(pi, runtime, async () => ({
			content: [{ type: "text", text: "unused" }],
			details: { warnings: [] },
		}));

		const taskTool = latestTaskTool(pi);
		expect(taskTool).toBeDefined();
		expect((pi as any)._getActiveTools()).toContain("Task");
		expect(taskTool?.parameters?.properties?.subagent_type?.enum ?? []).toEqual(["explorer", "reviewer"]);
	});

	it("registers Task from the project cwd even when the session dir is elsewhere", async () => {
		writeFile(join(agentDiscoveryDir, "agents", "project-root.md"), `---\ndescription: Project Root agent\ndepth: 1\ncan_spawn:\n  - project-child\n---\n\nProject Root Marker\n`);
		writeFile(join(agentDiscoveryDir, "agents", "project-child.md"), `---\ndescription: Project-only child agent\ndepth: 0\n---\n\nProject Child Marker\n`);
		const sessionDir = join(tempDir, "sessions-outside-cwd");
		makeDir(sessionDir);

		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);
		flags.set("defaultRootAgent", "project-root");

		const sessionManager = makeSessionManager(sessionDir, "cwd-registration-session");
		await handlers.get("before_agent_start")({
			systemPrompt: "Pi base prompt",
			systemPromptOptions: { cwd: tempDir },
		}, { cwd: tempDir, sessionManager });

		const registeredTools = (pi as any)._registeredTools ?? [];
		const taskTool = registeredTools.find((t: any) => t.name === "Task");
		expect(taskTool).toBeDefined();
		const enumValues: string[] = taskTool?.parameters?.properties?.subagent_type?.enum ?? [];
		expect(enumValues).toEqual(["project-child"]);
	});

	it("filters this extension from sub-agent loaders even when loaded through a symlink", () => {
		const realDir = join(tempDir, "real-extension");
		const linkDir = join(tempDir, "linked-extension");
		makeDir(realDir);
		writeFile(join(realDir, "index.ts"), "export default function () {}\n");
		symlinkSync(realDir, linkDir, "dir");

		const realSelfPath = join(realDir, "index.ts");
		const linkedSelfPath = join(linkDir, "index.ts");
		const otherExtensionPath = join(tempDir, "other-extension.ts");
		writeFile(otherExtensionPath, "export default function () {}\n");

		const result = filterExtensionsForAgent(makeAgent("explorer", { depth: 0 }), realSelfPath)({
			extensions: [
				{ path: linkedSelfPath, resolvedPath: linkedSelfPath },
				{ path: "<inline:1>", resolvedPath: "<inline:1>" },
				{ path: otherExtensionPath, resolvedPath: otherExtensionPath },
			],
		});

		expect(result.extensions.map((extension: any) => extension.path)).toEqual(["<inline:1>", otherExtensionPath]);
	});
});
