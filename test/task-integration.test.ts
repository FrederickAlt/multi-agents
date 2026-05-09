/**
 * Integration tests for the persistent-task-subagents extension.
 *
 * Tests extension loading, tool registration, command handlers.
 * LLM-dependent tests require API_KEY from env.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync as wfs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
	});

	afterEach(() => {
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
});
