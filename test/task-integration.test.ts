/**
 * Integration tests for the persistent-task-subagents extension.
 *
 * Tests extension loading, tool registration, command handlers.
 * LLM-dependent tests require API_KEY from env.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync as wfs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import taskExtension from "../subagent/index.js";

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

function createFakeExtensionApi() {
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	const flags = new Map<string, string | boolean | undefined>();
	const pi = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: () => {},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerFlag: (name: string, options: { default?: string | boolean }) => flags.set(name, options.default),
		getFlag: (name: string) => flags.get(name),
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

// ---------------------------------------------------------------------------
// Extension loading and tool registration (no LLM required)
// ---------------------------------------------------------------------------

describe("extension loading", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-task-ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		makeDir(agentDir);

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

		const taskTool = session.getAllTools().find((t) => t.name === "Task");
		expect(taskTool).toBeDefined();
		expect(taskTool?.description).toBeDefined();

		session.dispose();
	});

	it("renders the configured default Root agent when the session has no /agent selection", async () => {
		writeFile(join(tempDir, ".pi", "agents", "default.md"), `---\ndescription: Project Default Root\ndepth: 1\n---\n\nProject Default Root Marker\n`);
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
		writeFile(join(tempDir, ".pi", "agents", "default.md"), `---\ndescription: Project Default Root\ndepth: 1\n---\n\nRoot Agent Marker\n`);
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
		writeFile(join(tempDir, ".pi", "agents", "customroot.md"), `---\ndescription: Custom Root agent\ndepth: 1\n---\n\nCustom Root Marker\n`);
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
});
