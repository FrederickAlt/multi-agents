/**
 * Integration tests for the persistent-task-subagents extension.
 *
 * Tests extension loading, tool registration, command handlers.
 * LLM-dependent tests require API_KEY from env.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync as wfs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getModel, registerFauxProvider } from "@mariozechner/pi-ai";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/subagent/agents.js";
import { childPolicy, selectedRootPolicy } from "../src/subagent/depth-policy.js";
import { filterExtensionsForAgent } from "../src/subagent/extension-filter.js";
import taskExtension from "../src/subagent/index.js";
import {
	FINAL_RESPONSE_REQUIRED_MAX_ATTEMPTS,
	FINAL_RESPONSE_REQUIRED_MESSAGE,
} from "../src/subagent/output-extraction.js";
import { SELECTED_ROOT_AGENT_ENTRY_KEY, SELECTED_ROOT_AGENT_ENTRY_TYPE } from "../src/subagent/root-agent.js";
import { configureTaskToolForRuntime } from "../src/subagent/task-tool-registration.js";

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
	const sentMessages: Array<{ message: any; options?: any }> = [];
	const nextTurnMessages: any[] = [];
	const followUpMessages: any[] = [];
	const appendedEntries: Array<{ customType: string; data?: any }> = [];
	let activeTools = [...(options.activeTools ?? ["read", "bash", "edit", "write"])];
	const pi = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: (tool: any) => {
			registeredTools.push(tool);
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		appendEntry: (customType: string, data?: any) => {
			appendedEntries.push({ customType, data });
		},
		sendMessage: (message: any, options?: any) => {
			sentMessages.push({ message, options });
			if (options?.deliverAs === "nextTurn") nextTurnMessages.push(message);
			if (options?.deliverAs === "followUp") followUpMessages.push(message);
		},
		registerFlag: (name: string, options: { default?: string | boolean }) => flags.set(name, options.default),
		getFlag: (name: string) => flags.get(name),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		_registeredTools: registeredTools,
		_sentMessages: sentMessages,
		_nextTurnMessages: nextTurnMessages,
		_followUpMessages: followUpMessages,
		_promptTextForNextUserInput: (text: string) => {
			const queued = [...followUpMessages.splice(0), ...nextTurnMessages.splice(0)];
			return [text, ...queued.map((message) => String(message.content ?? ""))].join("\n\n");
		},
		_getActiveTools: () => [...activeTools],
		_appendedEntries: appendedEntries,
	} as any;
	return { pi, handlers, commands, flags };
}

function makeSessionManager(dir: string, sessionId: string) {
	return {
		getSessionDir: () => dir,
		getSessionId: () => sessionId,
		getSessionFile: () => join(dir, `${sessionId}.jsonl`),
		getEntries: () => [],
	};
}

function makeAgent(
	name: string,
	overrides: Partial<Pick<AgentConfig, "depth" | "can_spawn" | "extensions">>,
): AgentConfig {
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

function createTaskToolRegistrationDeps(sessionManager: any = {}) {
	return {
		getSessionManager: vi.fn(() => sessionManager),
		consumeWaitForAgentIds: vi.fn(),
	};
}

function renderComponentToText(component: { render(width: number): string[] }): string {
	return component.render(120).join("\n");
}

const passthroughTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

async function loadTaskExtensionWithNotifier() {
	const actual = await vi.importActual<typeof import("../src/subagent/async-agent-notifier.js")>(
		"../src/subagent/async-agent-notifier.js",
	);
	const asyncAgentNotifier = new actual.AsyncAgentNotifier();
	vi.resetModules();
	vi.doMock("../src/subagent/async-agent-notifier.js", () => ({
		...actual,
		AsyncAgentNotifier: vi.fn(function AsyncAgentNotifier() {
			return asyncAgentNotifier;
		}),
	}));
	const mod = await import("../src/subagent/index.js");
	return { taskExtension: mod.default, waitForAgentTool: mod.waitForAgent, asyncAgentNotifier };
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
		writeFile(
			join(agentsDir, "default.md"),
			`---\ndescription: Default Root Agent\ndepth: 1\n---\n\nDefault Root Agent\n`,
		);
		writeFile(
			join(agentsDir, "explorer.md"),
			`---\ndescription: Fast codebase recon\ndepth: 1\n---\n\nExplorer agent\n`,
		);
		writeFile(
			join(agentsDir, "reviewer.md"),
			`---\ndescription: Code review specialist\ndepth: 1\n---\n\nReviewer agent\n`,
		);
		writeFile(
			join(agentsDir, "planner.md"),
			`---\ndescription: software architect and planning specialist\ndepth: 1\n---\n\nYou are a software architect and planning specialist.\n`,
		);
		writeFile(
			join(agentDiscoveryDir, "prompt-parts", "010-tools.md"),
			`---\ndescription: Available tool list\n---\n\n## Available Tools\n\n{{tools}}\n`,
		);
		writeFile(
			join(agentDiscoveryDir, "prompt-parts", "020-guidelines.md"),
			`---\ndescription: Prompt guidelines\n---\n\n## Guidelines\n\n{{guidelines}}\n`,
		);

		// Redirect in-memory session dirs to tempDir so .task-subagents-*.json
		// metadata files don't end up in the repo root (SessionManager.inMemory
		// uses sessionDir = "", which would otherwise resolve metadata next to cwd).
		const origInMemory = SessionManager.inMemory.bind(SessionManager);
		vi.spyOn(SessionManager, "inMemory").mockImplementation((cwd?: string) => {
			const sm = origInMemory(cwd);
			vi.spyOn(sm, "getSessionDir").mockReturnValue(tempDir);
			return sm;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("../src/subagent/async-agent-notifier.js");
		delete process.env.PI_CODING_AGENT_DIR;
		delete (globalThis as any).__multi_agents_selected_main_agent;
		if (tempDir && existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
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

		const waitForAgentTool = allTools.find((t) => t.name === "wait_for_agent");
		expect(waitForAgentTool).toBeDefined();
		expect(waitForAgentTool?.description).toContain("Wait for one or more");

		// Verify parameters schema has required fields
		const params = taskTool?.parameters as any;
		expect(params).toBeDefined();
		expect(params.properties.description).toBeDefined();
		expect(params.properties.prompt).toBeDefined();
		expect(params.properties.subagent_type).toBeDefined();
		expect(params.properties.resume).toBeDefined();

		const waitParams = waitForAgentTool?.parameters as any;
		expect(waitParams).toBeDefined();
		expect(waitParams.properties.agent_ids).toBeDefined();
		expect(waitParams.properties.timeout).toBeDefined();
		expect(waitParams.properties.wait_all).toBeDefined();
		expect(waitParams.properties.kill_on_timeout).toBeDefined();

		session.dispose();
	});

	it("Task and wait_for_agent tools have prompt context for LLMs", () => {
		const { pi } = createFakeExtensionApi();
		const runtime = {
			treeDepth: 0,
			depthPolicy: selectedRootPolicy(makeAgent("root", { depth: 1 })),
		};

		configureTaskToolForRuntime(
			pi,
			runtime,
			async () => ({
				content: [{ type: "text", text: "unused" }],
				details: { warnings: [] },
			}),
			createTaskToolRegistrationDeps(),
		);

		const taskTool = latestTaskTool(pi);
		expect(taskTool).toBeDefined();
		expect(taskTool?.promptSnippet).toContain("sub-agent");
		expect(taskTool?.promptGuidelines).toEqual(
			expect.arrayContaining([expect.stringContaining("delegate"), expect.stringContaining("blocking:false")]),
		);

		const waitForAgentTool = (pi as any)._registeredTools.find((t: any) => t.name === "wait_for_agent");
		expect(waitForAgentTool).toBeDefined();
		expect(waitForAgentTool?.promptSnippet).toContain("async sub-agent");
		expect(waitForAgentTool?.promptGuidelines).toEqual(
			expect.arrayContaining([
				expect.stringContaining("wait_for_agent"),
				expect.stringContaining("wait_all"),
				expect.stringContaining("timeout"),
			]),
		);
	});

	it("expanded Task result renders context usage even when details.output is preferred", () => {
		const { pi } = createFakeExtensionApi();
		const runtime = {
			treeDepth: 0,
			depthPolicy: selectedRootPolicy(makeAgent("root", { depth: 1 })),
		};

		configureTaskToolForRuntime(
			pi,
			runtime,
			async () => ({
				content: [{ type: "text", text: "unused" }],
				details: { warnings: [] },
			}),
			createTaskToolRegistrationDeps(),
		);

		const taskTool = latestTaskTool(pi);
		const rendered = taskTool.renderResult(
			{
				content: [{ type: "text", text: "Task header that would be hidden by details.output" }],
				details: {
					id: "abc12345",
					displayName: "explorer Tom",
					description: "Inspect usage",
					warnings: [],
					output: "child output only",
					terminalOutcome: "completed",
					contextUsage: { tokens: 68234, contextWindow: 100000, percent: 68.234 },
				},
			},
			{ expanded: true },
			passthroughTheme,
		);

		const text = renderComponentToText(rendered);
		expect(text).toContain("explorer Tom");
		expect(text).toContain("Context used: 68.2%.");
		expect(text).toContain("child output only");
	});

	it("expanded Task result renders unknown context usage for completed output without usage", () => {
		const { pi } = createFakeExtensionApi();
		const runtime = {
			treeDepth: 0,
			depthPolicy: selectedRootPolicy(makeAgent("root", { depth: 1 })),
		};

		configureTaskToolForRuntime(
			pi,
			runtime,
			async () => ({
				content: [{ type: "text", text: "unused" }],
				details: { warnings: [] },
			}),
			createTaskToolRegistrationDeps(),
		);

		const taskTool = latestTaskTool(pi);
		const rendered = taskTool.renderResult(
			{
				content: [{ type: "text", text: "completed header" }],
				details: {
					id: "abc12345",
					displayName: "explorer Tom",
					warnings: [],
					output: "child output only",
					terminalOutcome: "completed",
				},
			},
			{ expanded: true },
			passthroughTheme,
		);

		const text = renderComponentToText(rendered);
		expect(text).toContain("Context used: Unknown.");
	});

	it("expanded Task result does not duplicate context usage from fallback text", () => {
		const { pi } = createFakeExtensionApi();
		const runtime = {
			treeDepth: 0,
			depthPolicy: selectedRootPolicy(makeAgent("root", { depth: 1 })),
		};

		configureTaskToolForRuntime(
			pi,
			runtime,
			async () => ({
				content: [{ type: "text", text: "unused" }],
				details: { warnings: [] },
			}),
			createTaskToolRegistrationDeps(),
		);

		const taskTool = latestTaskTool(pi);
		const rendered = taskTool.renderResult(
			{
				content: [
					{
						type: "text",
						text: "explorer Tom completed.\nContext used: 68.2%.\n\nNo final assistant output was captured.",
					},
				],
				details: {
					id: "abc12345",
					displayName: "explorer Tom",
					warnings: [],
					terminalOutcome: "completed",
					contextUsage: { tokens: 68234, contextWindow: 100000, percent: 68.234 },
				},
			},
			{ expanded: true },
			passthroughTheme,
		);

		const text = renderComponentToText(rendered);
		expect(text.match(/Context used:/g)).toHaveLength(1);
		expect(text).toContain("No final assistant output was captured.");
	});

	it("expanded Task fallback keeps child-authored context usage lines", () => {
		const { pi } = createFakeExtensionApi();
		const runtime = {
			treeDepth: 0,
			depthPolicy: selectedRootPolicy(makeAgent("root", { depth: 1 })),
		};

		configureTaskToolForRuntime(
			pi,
			runtime,
			async () => ({
				content: [{ type: "text", text: "unused" }],
				details: { warnings: [] },
			}),
			createTaskToolRegistrationDeps(),
		);

		const taskTool = latestTaskTool(pi);
		const rendered = taskTool.renderResult(
			{
				content: [
					{
						type: "text",
						text: "explorer Tom completed.\nContext used: 68.2%.\n\nChild-authored note.\nContext used: Unknown.",
					},
				],
				details: {
					id: "abc12345",
					displayName: "explorer Tom",
					warnings: [],
					terminalOutcome: "completed",
					contextUsage: { tokens: 68234, contextWindow: 100000, percent: 68.234 },
				},
			},
			{ expanded: true },
			passthroughTheme,
		);

		const text = renderComponentToText(rendered);
		expect(text.match(/Context used:/g)).toHaveLength(2);
		expect(text).toContain("Context used: 68.2%.");
		expect(text).toContain("Child-authored note.");
		expect(text).toContain("Context used: Unknown.");
	});

	it("renders the configured default Root agent when the session has no /agent selection", async () => {
		writeFile(
			join(agentDiscoveryDir, "agents", "default.md"),
			`---\ndescription: Project Default Root\ndepth: 1\n---\n\nProject Default Root Marker\n`,
		);
		const { pi, handlers } = createFakeExtensionApi();
		taskExtension(pi);

		const sessionManager = makeSessionManager(tempDir, "root-session");
		const result = await handlers.get("before_agent_start")(
			{
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
			},
			{ cwd: tempDir, sessionManager },
		);

		expect(result?.systemPrompt).toContain("Project Default Root Marker");
		expect(result?.systemPrompt).toContain("## Available Tools");
		expect(result?.systemPrompt).toContain("- read: Read file contents");
	});

	it("appends selected-root-agent custom entry during session_start", async () => {
		const { pi, handlers } = createFakeExtensionApi();
		taskExtension(pi);

		const sessionManager = SessionManager.create(tempDir, tempDir);
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, {
			ui: { notify: () => {} },
			cwd: tempDir,
			sessionManager,
		} as any);

		const selectedEntries = (pi as any)._appendedEntries.filter(
			(entry: { customType: string; data: unknown }) => entry.customType === SELECTED_ROOT_AGENT_ENTRY_TYPE,
		);
		expect(selectedEntries).toHaveLength(1);
		expect(selectedEntries[0]?.data).toMatchObject({ [SELECTED_ROOT_AGENT_ENTRY_KEY]: "default" });
	});

	it("appends selected-root-agent custom entry on reload when no valid existing selection exists", async () => {
		const { pi, handlers } = createFakeExtensionApi();
		taskExtension(pi);

		const sessionManager = SessionManager.create(tempDir, tempDir);
		await handlers.get("session_start")({ type: "session_start", reason: "reload" }, {
			ui: { notify: () => {} },
			cwd: tempDir,
			sessionManager,
		} as any);

		const selectedEntries = (pi as any)._appendedEntries.filter(
			(entry: { customType: string; data: unknown }) => entry.customType === SELECTED_ROOT_AGENT_ENTRY_TYPE,
		);
		expect(selectedEntries).toHaveLength(1);
		expect(selectedEntries[0]?.data).toMatchObject({ [SELECTED_ROOT_AGENT_ENTRY_KEY]: "default" });
	});

	it("does not append duplicate selected-root-agent custom entry when session already has matching selection", async () => {
		const { pi, handlers } = createFakeExtensionApi();
		taskExtension(pi);

		const baseSessionManager = SessionManager.create(tempDir, tempDir);
		const sessionManager = {
			getSessionDir: () => baseSessionManager.getSessionDir(),
			getSessionId: () => baseSessionManager.getSessionId(),
			getSessionFile: () => baseSessionManager.getSessionFile(),
			getEntries: () =>
				(pi as any)._appendedEntries.map((entry: { customType: string; data: unknown }) => ({
					type: "custom",
					customType: entry.customType,
					data: entry.data,
					id: "dummy",
					parentId: null,
					timestamp: "",
				})),
		};

		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, {
			ui: { notify: () => {} },
			cwd: tempDir,
			sessionManager,
		} as any);
		expect((pi as any)._appendedEntries).toHaveLength(1);

		await handlers.get("session_start")({ type: "session_start", reason: "reload" }, {
			ui: { notify: () => {} },
			cwd: tempDir,
			sessionManager,
		} as any);

		expect((pi as any)._appendedEntries).toHaveLength(1);
	});

	it("uses the latest selected-root-agent custom entry from session JSONL", async () => {
		const { pi, handlers } = createFakeExtensionApi();
		taskExtension(pi);

		const sessionManager = SessionManager.create(tempDir, tempDir);
		sessionManager.appendCustomEntry(SELECTED_ROOT_AGENT_ENTRY_TYPE, {
			[SELECTED_ROOT_AGENT_ENTRY_KEY]: "explorer",
		});
		sessionManager.appendCustomEntry(SELECTED_ROOT_AGENT_ENTRY_TYPE, {
			[SELECTED_ROOT_AGENT_ENTRY_KEY]: "planner",
		});

		const result = await handlers.get("before_agent_start")(
			{
				systemPrompt: "Pi base prompt",
				systemPromptOptions: { cwd: tempDir },
			},
			{ cwd: tempDir, sessionManager },
		);

		expect(result?.systemPrompt).toContain("software architect and planning specialist");
	});

	it("prefers existing session selection over the launch --agent flag", async () => {
		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);
		flags.set("agent", "planner");

		const sessionManager = SessionManager.create(tempDir, tempDir);
		sessionManager.appendCustomEntry(SELECTED_ROOT_AGENT_ENTRY_TYPE, {
			[SELECTED_ROOT_AGENT_ENTRY_KEY]: "explorer",
		});

		const result = await handlers.get("before_agent_start")(
			{
				systemPrompt: "Pi base prompt",
				systemPromptOptions: { cwd: tempDir },
			},
			{ cwd: tempDir, sessionManager },
		);

		expect(result?.systemPrompt).toContain("Explorer agent");
		expect(result?.systemPrompt).not.toContain("software architect and planning specialist");
	});

	it("does not preserve hidden Pi prompt material for Root Agent definitions", async () => {
		writeFile(
			join(agentDiscoveryDir, "agents", "default.md"),
			`---\ndescription: Project Default Root\ndepth: 1\n---\n\nRoot Agent Marker\n`,
		);
		const { pi, handlers } = createFakeExtensionApi();
		taskExtension(pi);

		const sessionManager = makeSessionManager(tempDir, "root-no-hidden-session");
		const result = await handlers.get("before_agent_start")(
			{
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
			},
			{ cwd: tempDir, sessionManager },
		);

		expect(result?.systemPrompt).toContain("Root Agent Marker");
		expect(result?.systemPrompt).not.toContain("Pi base prompt");
		expect(result?.systemPrompt).not.toContain("APPEND_SYSTEM content");
		expect(result?.systemPrompt).not.toContain("implicit AGENTS content");
	});

	it("renders a configured non-default Root agent when the session has no /agent selection", async () => {
		writeFile(
			join(agentDiscoveryDir, "agents", "customroot.md"),
			`---\ndescription: Custom Root agent\ndepth: 1\n---\n\nCustom Root Marker\n`,
		);
		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);
		flags.set("defaultRootAgent", "customroot");

		const sessionManager = makeSessionManager(tempDir, "custom-root-session");
		const result = await handlers.get("before_agent_start")(
			{
				systemPrompt: "Pi base prompt",
				systemPromptOptions: { cwd: tempDir },
			},
			{ cwd: tempDir, sessionManager },
		);

		expect(result?.systemPrompt).toContain("Custom Root Marker");
		expect(result?.systemPrompt).not.toContain("You are an expert coding assistant operating inside pi");
	});

	it("throws a visible error when the configured default Root agent is missing", async () => {
		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);
		flags.set("defaultRootAgent", "missing-root");

		const sessionManager = makeSessionManager(tempDir, "missing-default-session");

		await expect(
			handlers.get("before_agent_start")(
				{
					systemPrompt: "Pi base prompt",
					systemPromptOptions: { cwd: tempDir },
				},
				{ cwd: tempDir, sessionManager },
			),
		).rejects.toThrow('Default Root agent "missing-root" was not found');
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

			expect(notifications).toContainEqual(
				expect.objectContaining({
					message: expect.stringContaining('Default Root agent "missing-root" was not found'),
					type: "error",
				}),
			);
			expect(faux.state.callCount).toBe(0);
			expect(faux.getPendingResponseCount()).toBe(1);
			expect(session.messages.some((message) => message.role === "assistant")).toBe(false);
		} finally {
			session.dispose();
			faux.unregister();
		}
	});

	it("/agent with explicit name is deferred until session restart", async () => {
		const { pi, commands } = createFakeExtensionApi();
		taskExtension(pi);

		const sessionManager = SessionManager.create(tempDir, tempDir);
		let newSessionCalls = 0;
		const notices: string[] = [];
		const ctx = {
			cwd: tempDir,
			sessionManager,
			ui: { notify: (message: string) => notices.push(message) },
			newSession: async () => {
				newSessionCalls += 1;
				return { cancelled: false };
			},
		};

		await commands.get("agent").handler("planner", ctx as any);
		expect(newSessionCalls).toBe(0);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("in-session is not supported yet");
		expect((pi as any)._appendedEntries).toHaveLength(0);
	});

	// ------------------------------------------------------------------
	// Task hiding when DepthPolicy has no spawnable targets (issue #13)
	// ------------------------------------------------------------------

	it("hides Task when the resolved Root agent has depth 0", async () => {
		writeFile(
			join(agentDiscoveryDir, "agents", "leaf-root.md"),
			`---\ndescription: Leaf Root agent with depth 0\ndepth: 0\n---\n\nLeaf Root Marker\n`,
		);
		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);
		flags.set("defaultRootAgent", "leaf-root");

		const sessionManager = makeSessionManager(tempDir, "leaf-root-session");
		// Fire before_agent_start so the Root agent is resolved and Task registration runs
		await handlers.get("before_agent_start")(
			{
				systemPrompt: "Pi base prompt",
				systemPromptOptions: { cwd: tempDir },
			},
			{ cwd: tempDir, sessionManager },
		);

		// Verify Task was not registered for spawning, but wait_for_agent remains available.
		const registeredTools = (pi as any)._registeredTools ?? [];
		const taskTool = registeredTools.find((t: any) => t.name === "Task");
		expect(taskTool).toBeUndefined();
		const waitForAgentTool = registeredTools.find((t: any) => t.name === "wait_for_agent");
		expect(waitForAgentTool).toBeDefined();
		expect((pi as any)._getActiveTools()).not.toContain("Task");
		expect((pi as any)._getActiveTools()).toContain("wait_for_agent");
	});

	it("hides Task when the resolved Root agent has empty can_spawn", async () => {
		// Bare `can_spawn:` (null in YAML) or `can_spawn: ""` both produce an empty array → no spawnable agents
		writeFile(
			join(agentDiscoveryDir, "agents", "restrictive-root.md"),
			`---\ndescription: Restrictive Root agent\ndepth: 1\ncan_spawn:\n---\n\nRestrictive Root Marker\n`,
		);
		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);
		flags.set("defaultRootAgent", "restrictive-root");

		const sessionManager = makeSessionManager(tempDir, "restrictive-root-session");
		await handlers.get("before_agent_start")(
			{
				systemPrompt: "Pi base prompt",
				systemPromptOptions: { cwd: tempDir },
			},
			{ cwd: tempDir, sessionManager },
		);

		const registeredTools = (pi as any)._registeredTools ?? [];
		const taskTool = registeredTools.find((t: any) => t.name === "Task");
		expect(taskTool).toBeUndefined();
		const waitForAgentTool = registeredTools.find((t: any) => t.name === "wait_for_agent");
		expect(waitForAgentTool).toBeDefined();
		expect((pi as any)._getActiveTools()).not.toContain("Task");
		expect((pi as any)._getActiveTools()).toContain("wait_for_agent");
	});

	it("registers Task when the resolved Root agent has spawnable targets", async () => {
		writeFile(
			join(agentDiscoveryDir, "agents", "spawning-root.md"),
			`---\ndescription: Spawning Root agent\ndepth: 1\n---\n\nSpawning Root Marker\n`,
		);
		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);
		flags.set("defaultRootAgent", "spawning-root");

		const sessionManager = makeSessionManager(tempDir, "spawning-root-session");
		await handlers.get("before_agent_start")(
			{
				systemPrompt: "Pi base prompt",
				systemPromptOptions: { cwd: tempDir },
			},
			{ cwd: tempDir, sessionManager },
		);

		const registeredTools = (pi as any)._registeredTools ?? [];
		const taskTool = registeredTools.find((t: any) => t.name === "Task");
		expect(taskTool).toBeDefined();
	});

	it("Task subagent_type schema only offers spawnable agent types", async () => {
		writeFile(
			join(agentDiscoveryDir, "agents", "filtered-root.md"),
			`---\ndescription: Filtered Root agent\ndepth: 1\ncan_spawn:\n  - explorer\n---\n\nFiltered Root Marker\n`,
		);
		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);
		flags.set("defaultRootAgent", "filtered-root");

		const sessionManager = makeSessionManager(tempDir, "filtered-root-session");
		await handlers.get("before_agent_start")(
			{
				systemPrompt: "Pi base prompt",
				systemPromptOptions: { cwd: tempDir },
			},
			{ cwd: tempDir, sessionManager },
		);

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
		writeFile(
			join(agentDiscoveryDir, "agents", "spawning-root.md"),
			`---\ndescription: Spawning Root agent\ndepth: 1\ncan_spawn:\n  - explorer\n---\n\nSpawning Root Marker\n`,
		);
		writeFile(
			join(agentDiscoveryDir, "agents", "leaf-root.md"),
			`---\ndescription: Leaf Root agent\ndepth: 0\n---\n\nLeaf Root Marker\n`,
		);
		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);

		const sessionManager = makeSessionManager(tempDir, "stale-root-session");
		flags.set("defaultRootAgent", "spawning-root");
		await handlers.get("before_agent_start")(
			{
				systemPrompt: "Pi base prompt",
				systemPromptOptions: { cwd: tempDir },
			},
			{ cwd: tempDir, sessionManager },
		);
		expect((pi as any)._getActiveTools()).toContain("Task");

		flags.set("defaultRootAgent", "leaf-root");
		await handlers.get("before_agent_start")(
			{
				systemPrompt: "Pi base prompt",
				systemPromptOptions: { cwd: tempDir },
			},
			{ cwd: tempDir, sessionManager },
		);

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

		configureTaskToolForRuntime(
			pi,
			runtime,
			async () => ({
				content: [{ type: "text", text: "unused" }],
				details: { warnings: [] },
			}),
			createTaskToolRegistrationDeps(),
		);

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

		configureTaskToolForRuntime(
			pi,
			runtime,
			async () => ({
				content: [{ type: "text", text: "unused" }],
				details: { warnings: [] },
			}),
			createTaskToolRegistrationDeps(),
		);

		const taskTool = latestTaskTool(pi);
		expect(taskTool).toBeDefined();
		expect((pi as any)._getActiveTools()).toContain("Task");
		expect(taskTool?.parameters?.properties?.subagent_type?.enum ?? []).toEqual(["explorer", "reviewer"]);
	});

	it("registers Task from the project cwd even when the session dir is elsewhere", async () => {
		writeFile(
			join(agentDiscoveryDir, "agents", "project-root.md"),
			`---\ndescription: Project Root agent\ndepth: 1\ncan_spawn:\n  - project-child\n---\n\nProject Root Marker\n`,
		);
		writeFile(
			join(agentDiscoveryDir, "agents", "project-child.md"),
			`---\ndescription: Project-only child agent\ndepth: 0\n---\n\nProject Child Marker\n`,
		);
		const sessionDir = join(tempDir, "sessions-outside-cwd");
		makeDir(sessionDir);

		const { pi, handlers, flags } = createFakeExtensionApi();
		taskExtension(pi);
		flags.set("defaultRootAgent", "project-root");

		const sessionManager = makeSessionManager(sessionDir, "cwd-registration-session");
		await handlers.get("before_agent_start")(
			{
				systemPrompt: "Pi base prompt",
				systemPromptOptions: { cwd: tempDir },
			},
			{ cwd: tempDir, sessionManager },
		);

		const registeredTools = (pi as any)._registeredTools ?? [];
		const taskTool = registeredTools.find((t: any) => t.name === "Task");
		expect(taskTool).toBeDefined();
		const enumValues: string[] = taskTool?.parameters?.properties?.subagent_type?.enum ?? [];
		expect(enumValues).toEqual(["project-child"]);
	});

	describe("async notification boundaries", () => {
		it("batches a pending async completion notification with user input", async () => {
			const { taskExtension, asyncAgentNotifier } = await loadTaskExtensionWithNotifier();
			const { pi, handlers } = createFakeExtensionApi();
			taskExtension(pi);
			asyncAgentNotifier.markCompleted("agent-a");

			const result = await handlers.get("input")(
				{ type: "input", text: "continue with my request", source: "interactive" },
				{ cwd: tempDir, sessionManager: makeSessionManager(tempDir, "batch-session"), ui: { notify: () => {} } },
			);

			expect(result).toEqual(expect.objectContaining({ action: "transform" }));
			expect(result.text).toContain("[System]");
			expect(result.text).toContain("agent-a");
			expect(result.text).toContain("continue with my request");
			expect((pi as any)._sentMessages).toEqual([]);
		});

		it("preserves five-turn cadence across input and turn_end opportunities", async () => {
			const { taskExtension, asyncAgentNotifier } = await loadTaskExtensionWithNotifier();
			const { pi, handlers } = createFakeExtensionApi();
			taskExtension(pi);
			asyncAgentNotifier.markCompleted("agent-a");

			const input = handlers.get("input");
			const turnEnd = handlers.get("turn_end");
			if (!input || !turnEnd) throw new Error("input or turn_end handler missing");

			const makeContext = () => ({
				cwd: tempDir,
				sessionManager: makeSessionManager(tempDir, "reminder-session"),
				ui: { notify: () => {} },
			});

			const initial = await input({ type: "input", text: "start", source: "interactive" }, makeContext());
			expect(initial).toEqual(expect.objectContaining({ action: "transform" }));
			expect((initial as any).text).toContain("agent-a");
			turnEnd();

			for (let i = 0; i < 4; i++) {
				const inFlight = await input(
					{ type: "input", text: `follow up ${i}`, source: "interactive" },
					makeContext(),
				);
				expect(inFlight).toEqual(expect.objectContaining({ action: "continue" }));
				turnEnd();
			}

			const result = await input({ type: "input", text: "next user request", source: "interactive" }, makeContext());
			expect(result).toEqual(expect.objectContaining({ action: "transform" }));
			expect(result.text).toContain("Reminder");
			expect(result.text).toContain("agent-a");
			expect(result.text).toContain("next user request");
			expect((pi as any)._sentMessages).toHaveLength(0);
		});

		it("emits run-boundary notifications and reminders without duplicate spam", async () => {
			vi.useFakeTimers();
			try {
				const { taskExtension, asyncAgentNotifier } = await loadTaskExtensionWithNotifier();
				const { pi, handlers } = createFakeExtensionApi();
				taskExtension(pi);
				asyncAgentNotifier.markCompleted("agent-a");
				asyncAgentNotifier.markCompleted("agent-b");

				const agentEnd = handlers.get("agent_end");
				const completedTurn = { messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] };
				agentEnd(completedTurn);
				await vi.runOnlyPendingTimersAsync();
				expect((pi as any)._sentMessages).toHaveLength(1);
				expect((pi as any)._sentMessages[0].message.content).toContain("agent-a");
				expect((pi as any)._sentMessages[0].message.content).toContain("agent-b");

				for (let i = 0; i < 4; i++) {
					agentEnd(completedTurn);
					await vi.runOnlyPendingTimersAsync();
				}
				expect((pi as any)._sentMessages).toHaveLength(1);

				agentEnd(completedTurn);
				await vi.runOnlyPendingTimersAsync();
				expect((pi as any)._sentMessages).toHaveLength(2);
				expect((pi as any)._sentMessages[1].message.content).toContain("Reminder");
				expect((pi as any)._sentMessages[1].message.content).toContain("agent-a");
				expect((pi as any)._sentMessages[1].message.content).toContain("agent-b");
			} finally {
				vi.useRealTimers();
			}
		});

		it("does not deliver a stale completion notification after wait_for_agent retrieves the result", async () => {
			vi.useFakeTimers();
			try {
				const { taskExtension, waitForAgentTool, asyncAgentNotifier } = await loadTaskExtensionWithNotifier();
				const { pi, handlers } = createFakeExtensionApi();
				taskExtension(pi);
				asyncAgentNotifier.markCompleted("agent-a");

				handlers.get("turn_end")?.();

				const asyncResults = new Map([["agent-a", { output: "retrieved output", warnings: [] }]]);
				const waitResult = await waitForAgentTool(["agent-a"], {}, {
					metadataStore: {
						findRecord: () => ({
							id: "agent-a",
							humanName: "Ava",
							displayName: "explorer Ava",
							agentType: "explorer",
							sessionFile: "",
							depth: 1,
							createdAt: "2024-01-01T00:00:00.000Z",
							updatedAt: "2024-01-01T00:00:00.000Z",
						}),
					},
					sessionManager: {
						getAsyncResult: (id: string) => asyncResults.get(id),
						clearAsyncResult: (id: string) => {
							asyncResults.delete(id);
						},
					},
				} as any);
				const waitText = waitResult.content[0]?.type === "text" ? waitResult.content[0].text : "";
				expect(waitText).toContain("retrieved output");

				handlers.get("agent_end")?.({
					messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
				});
				await vi.runOnlyPendingTimersAsync();

				const inputResult = await handlers.get("input")(
					{ type: "input", text: "next user request", source: "interactive" },
					{
						cwd: tempDir,
						sessionManager: makeSessionManager(tempDir, "stale-notification-session"),
						ui: { notify: () => {} },
					},
				);
				const submittedText = inputResult?.action === "transform" ? inputResult.text : "next user request";
				const promptText = (pi as any)._promptTextForNextUserInput(submittedText);

				expect(promptText).toContain("next user request");
				expect(promptText).not.toContain("agent-a");
			} finally {
				vi.useRealTimers();
			}
		});

		it("asks the root agent to continue when a turn would end with thinking only", () => {
			const { pi, handlers } = createFakeExtensionApi();
			taskExtension(pi);

			handlers.get("agent_start")?.();
			handlers.get("turn_end")?.({
				message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], stopReason: "stop" },
				toolResults: [],
			});

			expect((pi as any)._sentMessages).toHaveLength(1);
			expect((pi as any)._sentMessages[0].message).toEqual({
				customType: "system",
				content: FINAL_RESPONSE_REQUIRED_MESSAGE,
				display: true,
			});
			expect((pi as any)._sentMessages[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		});

		it("does not ask the root agent to continue when a turn ends with text or a tool call", () => {
			const { pi, handlers } = createFakeExtensionApi();
			taskExtension(pi);

			handlers.get("agent_start")?.();
			handlers.get("turn_end")?.({
				message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
				toolResults: [],
			});
			handlers.get("turn_end")?.({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: {}, id: "call-1" }],
					stopReason: "toolUse",
				},
				toolResults: [],
			});

			expect((pi as any)._sentMessages).toEqual([]);
		});

		it("asks the root agent to continue after agent_end if the transcript ends with a tool result", async () => {
			vi.useFakeTimers();
			try {
				const { pi, handlers } = createFakeExtensionApi();
				taskExtension(pi);

				handlers.get("agent_start")?.();
				handlers.get("agent_end")?.({
					messages: [
						{
							role: "assistant",
							content: [{ type: "toolCall", name: "read", arguments: {}, id: "call-1" }],
							stopReason: "toolUse",
						},
						{
							role: "toolResult",
							toolCallId: "call-1",
							toolName: "read",
							content: [{ type: "text", text: "ok" }],
							isError: false,
						},
					],
				});

				expect((pi as any)._sentMessages).toEqual([]);
				await vi.runAllTimersAsync();
				expect((pi as any)._sentMessages).toHaveLength(1);
				expect((pi as any)._sentMessages[0].message.content).toBe(FINAL_RESPONSE_REQUIRED_MESSAGE);
				expect((pi as any)._sentMessages[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
			} finally {
				vi.useRealTimers();
			}
		});

		it("caps root final-response guard at three attempts until a new user input", () => {
			const { pi, handlers } = createFakeExtensionApi();
			taskExtension(pi);

			for (let i = 0; i < FINAL_RESPONSE_REQUIRED_MAX_ATTEMPTS + 2; i++) {
				handlers.get("agent_start")?.();
				handlers.get("turn_end")?.({
					message: {
						role: "assistant",
						content: [{ type: "thinking", thinking: "still stuck" }],
						stopReason: "stop",
					},
					toolResults: [],
				});
			}

			expect((pi as any)._sentMessages).toHaveLength(FINAL_RESPONSE_REQUIRED_MAX_ATTEMPTS);

			handlers.get("input")?.(
				{ type: "input", text: "new request", source: "interactive" },
				{
					cwd: tempDir,
					sessionManager: makeSessionManager(tempDir, "guard-reset-session"),
					ui: { notify: () => {} },
				},
			);
			handlers.get("agent_start")?.();
			handlers.get("turn_end")?.({
				message: { role: "assistant", content: [{ type: "thinking", thinking: "again" }], stopReason: "stop" },
				toolResults: [],
			});

			expect((pi as any)._sentMessages).toHaveLength(FINAL_RESPONSE_REQUIRED_MAX_ATTEMPTS + 1);
		});
	});

	it("keeps this extension in sub-agent loaders even when loaded through a symlink", () => {
		const realDir = join(tempDir, "real-extension");
		const linkDir = join(tempDir, "linked-extension");
		makeDir(realDir);
		writeFile(join(realDir, "index.ts"), "export default function () {}\n");
		symlinkSync(realDir, linkDir, "dir");

		const realSelfPath = join(realDir, "index.ts");
		const linkedSelfPath = join(linkDir, "index.ts");
		const otherExtensionPath = join(tempDir, "other-extension.ts");
		writeFile(otherExtensionPath, "export default function () {}\n");

		const result = filterExtensionsForAgent(
			makeAgent("explorer", { depth: 0, extensions: [] }),
			realSelfPath,
		)({
			extensions: [
				{ path: linkedSelfPath, resolvedPath: linkedSelfPath },
				{ path: "<inline:1>", resolvedPath: "<inline:1>" },
				{ path: otherExtensionPath, resolvedPath: otherExtensionPath },
			],
		});

		expect(result.extensions.map((extension: any) => extension.path)).toEqual([linkedSelfPath, "<inline:1>"]);
	});

	it("filters task subagent extensions with no-match selector outcome", () => {
		const selfPath = join(tempDir, "self-extension.ts");
		const candidate = join(tempDir, "candidate.ts");
		writeFile(candidate, "export default function () {}\n");
		const result = filterExtensionsForAgent(
			makeAgent("explorer", { depth: 0, extensions: ["missing-extension"] }),
			selfPath,
		)({
			extensions: [{ path: candidate, resolvedPath: candidate }],
		});

		expect(result.extensions.map((extension: any) => extension.path)).toEqual([]);
	});

	it("loads exactly one task extension when a selector has one match", () => {
		const selected = join(tempDir, "extensions", "load-me.ts");
		const skipped = join(tempDir, "extensions", "skip-me.ts");
		writeFile(selected, "export default function () {}\n");
		writeFile(skipped, "export default function () {}\n");
		const result = filterExtensionsForAgent(
			makeAgent("explorer", { depth: 0, extensions: ["load-me"] }),
			join(tempDir, "self-extension.ts"),
		)({
			extensions: [
				{ path: selected, resolvedPath: selected },
				{ path: skipped, resolvedPath: skipped },
			],
		});

		expect(result.extensions.map((extension: any) => extension.path)).toEqual([selected]);
	});

	it("loads all matching task subagent extensions for ambiguous selectors", () => {
		const sharedA = join(tempDir, "extensions", "shared", "a.ts");
		const sharedB = join(tempDir, "extensions", "shared", "b.ts");
		writeFile(sharedA, "export default function () {}\n");
		writeFile(sharedB, "export default function () {}\n");
		const result = filterExtensionsForAgent(
			makeAgent("explorer", { depth: 0, extensions: ["extensions/shared"] }),
			join(tempDir, "self-extension.ts"),
		)({
			extensions: [
				{ path: sharedA, resolvedPath: sharedA },
				{ path: sharedB, resolvedPath: sharedB },
			],
		});

		expect(result.extensions.map((extension: any) => extension.path)).toEqual([sharedA, sharedB]);
	});

	it("supports task extension selectors with path-like values", () => {
		const target = join(tempDir, "extensions", "path", "layered", "target.ts");
		writeFile(target, "export default function () {}\n");
		const result = filterExtensionsForAgent(
			makeAgent("explorer", { depth: 0, extensions: ["path/layered/target.ts"] }),
			join(tempDir, "self-extension.ts"),
		)({
			extensions: [{ path: target, resolvedPath: target }],
		});

		expect(result.extensions.map((extension: any) => extension.path)).toEqual([target]);
	});

	it("preserves protected multi-agent extensions when path segment is exact", () => {
		const protectedPath = join(tempDir, "extensions", "persistent-task-subagents", "build", "runner.ts");
		const nonProtectedPath = join(tempDir, "extensions", "not-multi-agents", "evil.ts");
		writeFile(protectedPath, "export default function () {}\n");
		writeFile(nonProtectedPath, "export default function () {}\n");
		const result = filterExtensionsForAgent(
			makeAgent("explorer", { depth: 0, extensions: ["missing"] }),
			join(tempDir, "self-extension.ts"),
		)({
			extensions: [
				{ path: protectedPath, resolvedPath: protectedPath },
				{ path: nonProtectedPath, resolvedPath: nonProtectedPath },
			],
		});

		expect(result.extensions.map((extension: any) => extension.path)).toEqual([protectedPath]);
	});

	it("preserves protected identity when source metadata has exact protected segment", () => {
		const sourceInfoProtectedExtension = join(tempDir, "extensions", "sourceinfo-helper.ts");
		const metadataProtectedExtension = join(tempDir, "extensions", "metadata-helper.ts");
		const sourceInfoBasedirProtected = "/tmp/persistent-task-subagents/sourceInfo/build";
		const metadataBasedirProtected = "/var/lib/multi-agents/metadata";
		writeFile(sourceInfoProtectedExtension, "export default function () {}\n");
		writeFile(metadataProtectedExtension, "export default function () {}\n");
		const result = filterExtensionsForAgent(
			makeAgent("explorer", { depth: 0, extensions: ["missing"] }),
			join(tempDir, "self-extension.ts"),
		)({
			extensions: [
				{
					path: sourceInfoProtectedExtension,
					resolvedPath: sourceInfoProtectedExtension,
					sourceInfo: {
						baseDir: sourceInfoBasedirProtected,
					},
				},
				{
					path: metadataProtectedExtension,
					resolvedPath: metadataProtectedExtension,
					metadata: {
						baseDir: metadataBasedirProtected,
					},
				},
			],
		});

		expect(result.extensions.map((extension: any) => extension.path)).toEqual([
			sourceInfoProtectedExtension,
			metadataProtectedExtension,
		]);
	});

	it("does not preserve extensions where protected names appear as substrings", () => {
		const notSegmentProtectedPath = join(tempDir, "extensions", "not-multi-agents", "evil.ts");
		const pluginLikePath = join(tempDir, "extensions", "my-persistent-task-subagents-plugin", "helper.ts");
		const sourceInfoSubstringProtectedPath = join(tempDir, "extensions", "sourceinfo-substring.ts");
		const metadataSubstringProtectedPath = join(tempDir, "extensions", "metadata-substring.ts");
		writeFile(notSegmentProtectedPath, "export default function () {}\n");
		writeFile(pluginLikePath, "export default function () {}\n");
		writeFile(sourceInfoSubstringProtectedPath, "export default function () {}\n");
		writeFile(metadataSubstringProtectedPath, "export default function () {}\n");
		const result = filterExtensionsForAgent(
			makeAgent("explorer", { depth: 0, extensions: ["missing"] }),
			join(tempDir, "self-extension.ts"),
		)({
			extensions: [
				{ path: notSegmentProtectedPath, resolvedPath: notSegmentProtectedPath },
				{ path: pluginLikePath, resolvedPath: pluginLikePath },
				{
					path: sourceInfoSubstringProtectedPath,
					resolvedPath: sourceInfoSubstringProtectedPath,
					sourceInfo: {
						baseDir: "/tmp/not-multi-agents/source",
					},
				},
				{
					path: metadataSubstringProtectedPath,
					resolvedPath: metadataSubstringProtectedPath,
					metadata: {
						baseDir: "/var/lib/my-persistent-task-subagents-plugin",
					},
				},
			],
		});

		expect(result.extensions).toEqual([]);
	});

	it("forwards task extension selector warnings through onWarnings", () => {
		const candidate = join(tempDir, "extensions", "candidate.ts");
		writeFile(candidate, "export default function () {}\n");
		const warnings: string[] = [];
		const result = filterExtensionsForAgent(
			makeAgent("explorer", { depth: 0, extensions: ["does-not-exist"] }),
			join(tempDir, "self-extension.ts"),
			{
				onWarnings: (entries) => warnings.push(...entries),
			},
		)({
			extensions: [{ path: candidate, resolvedPath: candidate }],
		});

		expect(result.extensions.map((extension: any) => extension.path)).toEqual([]);
		expect(warnings).toEqual([`No extension candidates matched selector "does-not-exist".`]);
	});
});
