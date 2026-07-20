/**
 * Integration tests for the persistent-task-subagents extension.
 *
 * Tests extension loading, tool registration, command handlers.
 * LLM-dependent tests require API_KEY from env.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync as wfs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/subagent/agents.js";
import { childPolicy, selectedRootPolicy } from "../src/subagent/depth-policy.js";
import { filterExtensionsForAgent } from "../src/subagent/extension-filter.js";
import taskExtension from "../src/subagent/index.js";
import {
	MULTI_AGENTS_BOOTSTRAP_RESUME_ENV,
	MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV,
	MULTI_AGENTS_PROJECT_TRUST_CWD_ENV,
	MULTI_AGENTS_PROJECT_TRUST_ENV,
	MULTI_AGENTS_RESTART_REQUEST_FILE_ENV,
} from "../src/subagent/launcher-contract.js";
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

function restoreRestartRequestEnv(previousValue: string | undefined): void {
	if (previousValue === undefined) {
		delete process.env.PI_MULTI_AGENTS_RESTART_FILE;
	} else {
		process.env.PI_MULTI_AGENTS_RESTART_FILE = previousValue;
	}
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

		const model = ModelRegistry.inMemory(AuthStorage.inMemory()).find("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
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
			expect.arrayContaining([
				expect.stringContaining("delegate"),
				expect.stringContaining("blocking:false"),
				expect.stringContaining("remaining context"),
			]),
		);

		const waitForAgentTool = (pi as any)._registeredTools.find((t: any) => t.name === "wait_for_agent");
		expect(waitForAgentTool).toBeDefined();
		expect(waitForAgentTool?.promptSnippet).toContain("async sub-agent");
		expect(waitForAgentTool?.promptGuidelines).toEqual(
			expect.arrayContaining([
				expect.stringContaining("wait_for_agent"),
				expect.stringContaining("wait_all"),
				expect.stringContaining("timeout"),
				expect.stringContaining("remaining context"),
			]),
		);
	});

	it("Task call renderer shows the execution mode and defaults to fast", () => {
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
		const smartText = renderComponentToText(
			taskTool.renderCall(
				{ subagent_type: "explorer", description: "Inspect code", mode: "smart" },
				passthroughTheme,
			),
		);
		const fastText = renderComponentToText(
			taskTool.renderCall({ subagent_type: "explorer", description: "Inspect code" }, passthroughTheme),
		);

		expect(smartText).toContain("Task explorer (smart) new");
		expect(fastText).toContain("Task explorer (fast) new");
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

	it.each([true, false])(
		"requests a launcher restart when interactive project trust becomes %s",
		async (projectTrusted) => {
			const { pi, handlers } = createFakeExtensionApi();
			taskExtension(pi);
			const sessionManager = SessionManager.create(tempDir, tempDir);
			const restartRequestFile = join(tempDir, `trust-${projectTrusted}.json`);
			const previousTrust = process.env[MULTI_AGENTS_PROJECT_TRUST_ENV];
			const previousTrustCwd = process.env[MULTI_AGENTS_PROJECT_TRUST_CWD_ENV];
			const previousRestart = process.env[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV];
			process.env[MULTI_AGENTS_PROJECT_TRUST_ENV] = projectTrusted ? "0" : "1";
			process.env[MULTI_AGENTS_PROJECT_TRUST_CWD_ENV] = tempDir;
			process.env[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV] = restartRequestFile;
			let shutdownCalls = 0;

			try {
				await handlers.get("session_start")(
					{ type: "session_start", reason: "startup" },
					{
						ui: { notify: () => {} },
						cwd: tempDir,
						isProjectTrusted: () => projectTrusted,
						sessionManager,
						shutdown: () => {
							shutdownCalls += 1;
						},
					},
				);
			} finally {
				if (previousTrust === undefined) delete process.env[MULTI_AGENTS_PROJECT_TRUST_ENV];
				else process.env[MULTI_AGENTS_PROJECT_TRUST_ENV] = previousTrust;
				if (previousTrustCwd === undefined) delete process.env[MULTI_AGENTS_PROJECT_TRUST_CWD_ENV];
				else process.env[MULTI_AGENTS_PROJECT_TRUST_CWD_ENV] = previousTrustCwd;
				restoreRestartRequestEnv(previousRestart);
			}

			expect(shutdownCalls).toBe(1);
			expect(JSON.parse(readFileSync(restartRequestFile, "utf-8"))).toEqual({
				version: 1,
				type: "trust",
				sessionPath: sessionManager.getSessionFile(),
				sessionId: sessionManager.getSessionId(),
				projectTrusted,
			});
			expect((pi as any)._appendedEntries).toHaveLength(0);
		},
	);

	it("requests a trust restart for an in-memory --no-session runtime", async () => {
		const { pi, handlers } = createFakeExtensionApi();
		taskExtension(pi);
		const sessionManager = SessionManager.inMemory(tempDir, { id: "ephemeral-trust" });
		const restartRequestFile = join(tempDir, "trust-ephemeral.json");
		const previousTrust = process.env[MULTI_AGENTS_PROJECT_TRUST_ENV];
		const previousTrustCwd = process.env[MULTI_AGENTS_PROJECT_TRUST_CWD_ENV];
		const previousRestart = process.env[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV];
		process.env[MULTI_AGENTS_PROJECT_TRUST_ENV] = "0";
		process.env[MULTI_AGENTS_PROJECT_TRUST_CWD_ENV] = tempDir;
		process.env[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV] = restartRequestFile;

		try {
			await handlers.get("session_start")(
				{ type: "session_start", reason: "startup" },
				{
					ui: { notify: () => {} },
					cwd: tempDir,
					isProjectTrusted: () => true,
					sessionManager,
					shutdown: () => {},
				},
			);
		} finally {
			if (previousTrust === undefined) delete process.env[MULTI_AGENTS_PROJECT_TRUST_ENV];
			else process.env[MULTI_AGENTS_PROJECT_TRUST_ENV] = previousTrust;
			if (previousTrustCwd === undefined) delete process.env[MULTI_AGENTS_PROJECT_TRUST_CWD_ENV];
			else process.env[MULTI_AGENTS_PROJECT_TRUST_CWD_ENV] = previousTrustCwd;
			restoreRestartRequestEnv(previousRestart);
		}

		expect(JSON.parse(readFileSync(restartRequestFile, "utf-8"))).toEqual({
			version: 1,
			type: "trust",
			sessionId: sessionManager.getSessionId(),
			projectTrusted: true,
		});
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

	it("uses launcher-provided root agent from environment when no session selection exists", async () => {
		const previous = process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV];
		process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV] = "planner";
		try {
			const { pi, handlers } = createFakeExtensionApi();
			taskExtension(pi);

			const sessionManager = makeSessionManager(tempDir, "env-root-agent-session");
			const result = await handlers.get("before_agent_start")(
				{
					systemPrompt: "Pi base prompt",
					systemPromptOptions: { cwd: tempDir },
				},
				{ cwd: tempDir, sessionManager },
			);
			expect(result?.systemPrompt).toContain("software architect and planning specialist");
		} finally {
			if (previous === undefined) {
				delete process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV];
			} else {
				process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV] = previous;
			}
		}
	});

	it("keeps existing session-root selection authoritative over launcher-provided root agent", async () => {
		const previous = process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV];
		process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV] = "reviewer";
		try {
			const { pi, handlers } = createFakeExtensionApi();
			taskExtension(pi);

			const sessionManager = SessionManager.create(tempDir, tempDir);
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
		} finally {
			if (previous === undefined) {
				delete process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV];
			} else {
				process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV] = previous;
			}
		}
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

	it("rejects explicit /agent without launcher restart-file context", async () => {
		const { pi, commands } = createFakeExtensionApi();
		taskExtension(pi);
		const previousRequestPath = process.env.PI_MULTI_AGENTS_RESTART_FILE;
		delete process.env.PI_MULTI_AGENTS_RESTART_FILE;
		let newSessionCalls = 0;
		let shutdownCalls = 0;
		const notices: string[] = [];
		const ctx = {
			cwd: tempDir,
			sessionManager: SessionManager.create(tempDir, tempDir),
			ui: { notify: (message: string) => notices.push(message) },
			newSession: async () => {
				newSessionCalls += 1;
				return { cancelled: false };
			},
			shutdown: () => {
				shutdownCalls += 1;
			},
		};
		try {
			await commands.get("agent").handler("planner", ctx as any);
		} finally {
			restoreRestartRequestEnv(previousRequestPath);
		}

		expect(newSessionCalls).toBe(0);
		expect(shutdownCalls).toBe(0);
		expect(notices.some((notice) => notice.includes("launcher restart file is missing"))).toBe(true);
		expect((pi as any)._appendedEntries).toHaveLength(0);
	});

	it("validates /agent name and requests a launcher-driven root restart", async () => {
		const { pi, commands } = createFakeExtensionApi();
		taskExtension(pi);

		const restartRequestFile = join(tempDir, "root-restart.json");
		const originalRestartEnv = process.env.PI_MULTI_AGENTS_RESTART_FILE;
		process.env.PI_MULTI_AGENTS_RESTART_FILE = restartRequestFile;
		let newSessionCalls = 0;
		let shutdownCalls = 0;
		const notices: string[] = [];
		const ctx = {
			cwd: tempDir,
			sessionManager: SessionManager.create(tempDir, tempDir),
			ui: { notify: (message: string) => notices.push(message) },
			newSession: async () => {
				newSessionCalls += 1;
				return { cancelled: false };
			},
			shutdown: () => {
				shutdownCalls += 1;
			},
		};

		try {
			await commands.get("agent").handler("planner", ctx as any);
		} finally {
			restoreRestartRequestEnv(originalRestartEnv);
		}

		const content = readFileSync(restartRequestFile, "utf-8").trim();
		expect(content).toBe('{"version":1,"requestedRootAgent":"planner"}');
		expect(newSessionCalls).toBe(0);
		expect(shutdownCalls).toBe(1);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain('Root agent "planner" in a fresh session');
		expect((pi as any)._appendedEntries).toHaveLength(0);
	});

	it("clears pending restart request when /agent shutdown throws", async () => {
		const { pi, commands } = createFakeExtensionApi();
		taskExtension(pi);

		const restartRequestFile = join(tempDir, "root-restart-failed.json");
		const originalRestartEnv = process.env.PI_MULTI_AGENTS_RESTART_FILE;
		process.env.PI_MULTI_AGENTS_RESTART_FILE = restartRequestFile;
		let newSessionCalls = 0;
		let shutdownCalls = 0;
		const notices: string[] = [];
		const ctx = {
			cwd: tempDir,
			sessionManager: SessionManager.create(tempDir, tempDir),
			ui: { notify: (message: string) => notices.push(message) },
			newSession: async () => {
				newSessionCalls += 1;
				return { cancelled: false };
			},
			shutdown: () => {
				shutdownCalls += 1;
				throw new Error("shutdown transition failure");
			},
		};

		try {
			await commands.get("agent").handler("planner", ctx as any);
		} finally {
			restoreRestartRequestEnv(originalRestartEnv);
		}

		expect(newSessionCalls).toBe(0);
		expect(shutdownCalls).toBe(1);
		expect(existsSync(restartRequestFile)).toBe(false);
		expect(notices.some((notice) => notice.includes("Failed to prepare Root-agent session restart"))).toBe(true);
		expect(notices.some((notice) => notice.includes("Staying in the current session"))).toBe(true);
		expect((pi as any)._appendedEntries).toHaveLength(0);
	});

	it("falls back to process.exit when shutdown API is unavailable", async () => {
		const { pi, commands } = createFakeExtensionApi();
		taskExtension(pi);

		const restartRequestFile = join(tempDir, "root-restart-fallback.json");
		const originalRestartEnv = process.env.PI_MULTI_AGENTS_RESTART_FILE;
		process.env.PI_MULTI_AGENTS_RESTART_FILE = restartRequestFile;
		const originalExit = process.exit;
		let exitCalls = 0;
		(process as any).exit = ((..._args: unknown[]) => {
			exitCalls += 1;
		}) as any;
		let newSessionCalls = 0;
		const notices: string[] = [];
		const ctx = {
			cwd: tempDir,
			sessionManager: SessionManager.create(tempDir, tempDir),
			ui: { notify: (message: string) => notices.push(message) },
			newSession: async () => {
				newSessionCalls += 1;
				return { cancelled: false };
			},
		} as any;
		try {
			await commands.get("agent").handler("planner", ctx as any);
		} finally {
			restoreRestartRequestEnv(originalRestartEnv);
			process.exit = originalExit;
		}

		expect(newSessionCalls).toBe(0);
		expect(exitCalls).toBe(1);
		const content = readFileSync(restartRequestFile, "utf-8").trim();
		expect(content).toBe('{"version":1,"requestedRootAgent":"planner"}');
		expect(notices.some((notice) => notice.includes('Root agent "planner" in a fresh session.'))).toBe(true);
		expect((pi as any)._appendedEntries).toHaveLength(0);
	});

	it("clears pending restart request when /agent shutdown throws synchronously", async () => {
		const { pi, commands } = createFakeExtensionApi();
		taskExtension(pi);

		const restartRequestFile = join(tempDir, "root-restart-throws-sync.json");
		const originalRestartEnv = process.env.PI_MULTI_AGENTS_RESTART_FILE;
		process.env.PI_MULTI_AGENTS_RESTART_FILE = restartRequestFile;
		let newSessionCalls = 0;
		let shutdownCalls = 0;
		const notices: string[] = [];
		const ctx = {
			cwd: tempDir,
			sessionManager: SessionManager.create(tempDir, tempDir),
			ui: { notify: (message: string) => notices.push(message) },
			newSession: async () => {
				newSessionCalls += 1;
				return { cancelled: false };
			},
			shutdown: () => {
				shutdownCalls += 1;
				throw new Error("shutdown transition immediate failure");
			},
		};
		try {
			await commands.get("agent").handler("planner", ctx as any);
		} finally {
			restoreRestartRequestEnv(originalRestartEnv);
		}

		expect(newSessionCalls).toBe(0);
		expect(shutdownCalls).toBe(1);
		expect(existsSync(restartRequestFile)).toBe(false);
		expect(notices.some((notice) => notice.includes("Failed to prepare Root-agent session restart"))).toBe(true);
		expect(notices.some((notice) => notice.includes("Staying in the current session"))).toBe(true);
		expect((pi as any)._appendedEntries).toHaveLength(0);
	});

	it("intercepts resume session switching and requests a resume-session launcher restart", async () => {
		const { pi, handlers } = createFakeExtensionApi();
		taskExtension(pi);

		const restartRequestFile = join(tempDir, "resume-restart.json");
		const originalRestartEnv = process.env.PI_MULTI_AGENTS_RESTART_FILE;
		process.env.PI_MULTI_AGENTS_RESTART_FILE = restartRequestFile;
		let shutdownCalls = 0;
		const notices: string[] = [];
		const selectedSessionPath = join(tempDir, "selected-session.jsonl");
		const ctx = {
			cwd: tempDir,
			sessionManager: SessionManager.create(tempDir, tempDir),
			ui: { notify: (message: string) => notices.push(message) },
			shutdown: () => {
				shutdownCalls += 1;
			},
		};
		try {
			const result = await handlers.get("session_before_switch")(
				{ type: "session_before_switch", reason: "resume", targetSessionFile: selectedSessionPath },
				ctx as any,
			);
			expect(result).toEqual({ cancel: true });
		} finally {
			restoreRestartRequestEnv(originalRestartEnv);
		}

		const content = readFileSync(restartRequestFile, "utf-8").trim();
		expect(content).toBe(`{"version":1,"type":"resume-session","sessionPath":"${selectedSessionPath}"}`);
		expect(shutdownCalls).toBe(1);
		expect(notices.some((notice) => notice.includes("Restarting Pi with selected session"))).toBe(true);
		expect((pi as any)._appendedEntries).toHaveLength(0);
	});

	it("requests a resume-session restart during bootstrap session_start", async () => {
		const { pi, handlers } = createFakeExtensionApi();
		taskExtension(pi);

		const restartRequestFile = join(tempDir, "bootstrap-resume-session-start.json");
		const originalRestartEnv = process.env.PI_MULTI_AGENTS_RESTART_FILE;
		const originalBootstrapEnv = process.env[MULTI_AGENTS_BOOTSTRAP_RESUME_ENV];
		process.env.PI_MULTI_AGENTS_RESTART_FILE = restartRequestFile;
		process.env[MULTI_AGENTS_BOOTSTRAP_RESUME_ENV] = "1";
		const selectedSessionPath = join(tempDir, "selected-session.jsonl");
		let shutdownCalls = 0;
		const notices: string[] = [];
		const sessionManager = SessionManager.create(tempDir, tempDir);
		vi.spyOn(sessionManager, "getSessionFile").mockReturnValue(selectedSessionPath);
		const ctx = {
			cwd: tempDir,
			sessionManager,
			ui: { notify: (message: string) => notices.push(message) },
			shutdown: () => {
				shutdownCalls += 1;
			},
		};

		try {
			await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx as any);
		} finally {
			restoreRestartRequestEnv(originalRestartEnv);
			if (originalBootstrapEnv === undefined) {
				delete process.env[MULTI_AGENTS_BOOTSTRAP_RESUME_ENV];
			} else {
				process.env[MULTI_AGENTS_BOOTSTRAP_RESUME_ENV] = originalBootstrapEnv;
			}
		}

		expect(readFileSync(restartRequestFile, "utf-8").trim()).toBe(
			`{"version":1,"type":"resume-session","sessionPath":"${selectedSessionPath}"}`,
		);
		expect(shutdownCalls).toBe(1);
		expect(notices.some((notice) => notice.includes("Restarting Pi with selected session"))).toBe(true);
		expect((pi as any)._appendedEntries).toHaveLength(0);
	});

	it("stays in bootstrap session_start when resume-session restart request cannot be prepared", async () => {
		const { pi, handlers } = createFakeExtensionApi();
		taskExtension(pi);

		const restartRequestFile = join(tempDir, "none", "bootstrap-resume-unwritable.json");
		const originalRestartEnv = process.env.PI_MULTI_AGENTS_RESTART_FILE;
		const originalBootstrapEnv = process.env[MULTI_AGENTS_BOOTSTRAP_RESUME_ENV];
		process.env.PI_MULTI_AGENTS_RESTART_FILE = restartRequestFile;
		process.env[MULTI_AGENTS_BOOTSTRAP_RESUME_ENV] = "1";
		let shutdownCalls = 0;
		const notices: string[] = [];
		const sessionManager = SessionManager.create(tempDir, tempDir);
		vi.spyOn(sessionManager, "getSessionFile").mockReturnValue(join(tempDir, "selected-session.jsonl"));
		const ctx = {
			cwd: tempDir,
			sessionManager,
			ui: { notify: (message: string) => notices.push(message) },
			shutdown: () => {
				shutdownCalls += 1;
			},
		};
		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx as any);
		restoreRestartRequestEnv(originalRestartEnv);
		if (originalBootstrapEnv === undefined) {
			delete process.env[MULTI_AGENTS_BOOTSTRAP_RESUME_ENV];
		} else {
			process.env[MULTI_AGENTS_BOOTSTRAP_RESUME_ENV] = originalBootstrapEnv;
		}

		expect(shutdownCalls).toBe(0);
		expect(existsSync(restartRequestFile)).toBe(false);
		expect(notices.some((notice) => notice.includes("Failed to save the selected session resume request"))).toBe(
			true,
		);
		expect((pi as any)._appendedEntries).toHaveLength(0);
	});

	it("does not intercept non-resume or unknown-target session switch events", async () => {
		const { pi, handlers } = createFakeExtensionApi();
		taskExtension(pi);

		const restartRequestFile = join(tempDir, "resume-ignore.json");
		const originalRestartEnv = process.env.PI_MULTI_AGENTS_RESTART_FILE;
		process.env.PI_MULTI_AGENTS_RESTART_FILE = restartRequestFile;
		let shutdownCalls = 0;
		const notices: string[] = [];
		const ctx = {
			cwd: tempDir,
			sessionManager: SessionManager.create(tempDir, tempDir),
			ui: { notify: (message: string) => notices.push(message) },
			shutdown: () => {
				shutdownCalls += 1;
			},
		};

		const missingTargetResult = await handlers.get("session_before_switch")(
			{ type: "session_before_switch", reason: "resume" },
			ctx as any,
		);
		const otherReasonResult = await handlers.get("session_before_switch")(
			{ type: "session_before_switch", reason: "new", targetSessionFile: join(tempDir, "other-session.jsonl") },
			ctx as any,
		);
		restoreRestartRequestEnv(originalRestartEnv);

		expect(missingTargetResult).toBeUndefined();
		expect(otherReasonResult).toBeUndefined();
		expect(shutdownCalls).toBe(0);
		expect(notices).toHaveLength(0);
		expect(existsSync(restartRequestFile)).toBe(false);
		expect((pi as any)._appendedEntries).toHaveLength(0);
	});

	it("clears pending resume-session restart request when shutdown throws", async () => {
		const { pi, handlers } = createFakeExtensionApi();
		taskExtension(pi);

		const restartRequestFile = join(tempDir, "resume-shutdown-fail.json");
		const originalRestartEnv = process.env.PI_MULTI_AGENTS_RESTART_FILE;
		process.env.PI_MULTI_AGENTS_RESTART_FILE = restartRequestFile;
		let shutdownCalls = 0;
		const notices: string[] = [];
		const ctx = {
			cwd: tempDir,
			sessionManager: SessionManager.create(tempDir, tempDir),
			ui: { notify: (message: string) => notices.push(message) },
			shutdown: () => {
				shutdownCalls += 1;
				throw new Error("shutdown failed");
			},
		};
		const selectedSessionPath = join(tempDir, "resume-session.jsonl");
		const result = await handlers.get("session_before_switch")(
			{ type: "session_before_switch", reason: "resume", targetSessionFile: selectedSessionPath },
			ctx as any,
		);
		restoreRestartRequestEnv(originalRestartEnv);

		expect(result).toEqual({ cancel: true });
		expect(shutdownCalls).toBe(1);
		expect(existsSync(restartRequestFile)).toBe(false);
		expect(notices.some((notice) => notice.includes("Failed to prepare resume-session restart"))).toBe(true);
		expect(notices.some((notice) => notice.includes("Staying in the current session"))).toBe(true);
	});

	it("stays in session when resume restart request file cannot be written", async () => {
		const { pi, handlers } = createFakeExtensionApi();
		taskExtension(pi);

		const restartRequestFile = join(tempDir, "nowhere", "resume-unwritable.json");
		const originalRestartEnv = process.env.PI_MULTI_AGENTS_RESTART_FILE;
		process.env.PI_MULTI_AGENTS_RESTART_FILE = restartRequestFile;
		const notices: string[] = [];
		let shutdownCalls = 0;
		const ctx = {
			cwd: tempDir,
			sessionManager: SessionManager.create(tempDir, tempDir),
			ui: { notify: (message: string) => notices.push(message) },
			shutdown: () => {
				shutdownCalls += 1;
			},
		};
		const result = await handlers.get("session_before_switch")(
			{
				type: "session_before_switch",
				reason: "resume",
				targetSessionFile: join(tempDir, "selected-session.jsonl"),
			},
			ctx as any,
		);
		restoreRestartRequestEnv(originalRestartEnv);

		expect(result).toEqual({ cancel: true });
		expect(shutdownCalls).toBe(0);
		expect(existsSync(restartRequestFile)).toBe(false);
		expect(notices.some((notice) => notice.includes("Failed to save the requested resume-session restart"))).toBe(
			true,
		);
	});

	it("rejects unknown /agent names without writing a restart request", async () => {
		const { pi, commands } = createFakeExtensionApi();
		taskExtension(pi);

		const restartRequestFile = join(tempDir, "root-restart-unknown.json");
		const previousRequestPath = process.env.PI_MULTI_AGENTS_RESTART_FILE;
		process.env.PI_MULTI_AGENTS_RESTART_FILE = restartRequestFile;
		let newSessionCalls = 0;
		const notices: string[] = [];
		const ctx = {
			cwd: tempDir,
			sessionManager: SessionManager.create(tempDir, tempDir),
			ui: { notify: (message: string) => notices.push(message) },
			newSession: async () => {
				newSessionCalls += 1;
				throw new Error("unexpected restart");
			},
		};
		await expect(commands.get("agent").handler("does-not-exist", ctx as any)).resolves.toBeUndefined();
		restoreRestartRequestEnv(previousRequestPath);

		expect(newSessionCalls).toBe(0);
		expect(() => readFileSync(restartRequestFile, "utf-8")).toThrow();
		expect(notices.some((notice) => notice.includes("Unknown agent"))).toBe(true);
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

	it("matches package-name selectors from extension metadata baseDir package.json", () => {
		const packageBase = join(tempDir, "extensions", "summarize");
		const target = join(packageBase, "dist", "index.ts");
		writeFile(target, "export default function () {}\n");
		writeFile(join(packageBase, "package.json"), '{"name":"pi-tool-summarize-replacement"}\n');

		const result = filterExtensionsForAgent(
			makeAgent("explorer", { depth: 0, extensions: ["pi-tool-summarize-replacement"] }),
			join(tempDir, "self-extension.ts"),
		)({
			extensions: [
				{
					path: target,
					resolvedPath: target,
					sourceInfo: {
						baseDir: packageBase,
					},
				},
			],
		});

		expect(result.extensions.map((extension: any) => extension.path)).toEqual([target]);
	});

	it("matches package-name selectors from loaded extension paths inside a package", () => {
		const packageBase = join(tempDir, "extensions", "file-inject");
		const target = join(packageBase, "src", "index.ts");
		writeFile(target, "export default function () {}\n");
		writeFile(join(packageBase, "package.json"), '{"name":"pi-file-inject"}\n');
		const warnings: string[] = [];

		const result = filterExtensionsForAgent(
			makeAgent("explorer", { depth: 0, extensions: ["pi-file-inject"] }),
			join(tempDir, "self-extension.ts"),
			{ onWarnings: (entries) => warnings.push(...entries) },
		)({
			extensions: [
				{
					path: target,
					resolvedPath: target,
					sourceInfo: {
						baseDir: join(packageBase, "src"),
					},
				},
			],
		});

		expect(result.extensions.map((extension: any) => extension.path)).toEqual([target]);
		expect(warnings).toEqual([]);
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

	it("does not preserve extension when only package.json name is protected", () => {
		const packageBaseDir = join(tempDir, "extensions", "package-basedir");
		const resultPath = join(tempDir, "extensions", "package-name-alias.ts");
		makeDir(packageBaseDir);
		writeFile(join(packageBaseDir, "package.json"), '{"name":"persistent-task-subagents"}\n');
		writeFile(resultPath, "export default function () {}\n");
		const result = filterExtensionsForAgent(
			makeAgent("explorer", { depth: 0, extensions: ["missing"] }),
			join(tempDir, "self-extension.ts"),
		)({
			extensions: [
				{
					path: resultPath,
					resolvedPath: resultPath,
					sourceInfo: {
						baseDir: packageBaseDir,
					},
				},
			],
		});

		expect(result.extensions).toEqual([]);
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
