/**
 * LLM integration tests for persistent-task-subagents.
 *
 * These tests verify actual Task execution with a real LLM.
 * Skipped if the opencode-go API key is not available.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getModel } from "@mariozechner/pi-ai";
import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";
import taskExtension from "../subagent/index.js";

function hasOpencodeAuth(): boolean {
	try {
		const authPath = join(homedir(), ".pi", "agent", "auth.json");
		if (!existsSync(authPath)) return false;
		const data = JSON.parse(readFileSync(authPath, "utf-8"));
		return data["opencode-go"]?.type === "api_key" && !!data["opencode-go"].key;
	} catch {
		return false;
	}
}

const API_KEY = hasOpencodeAuth()
	? JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf-8"))["opencode-go"].key
	: undefined;

describe.skipIf(!API_KEY)("Task with real LLM (deepseek-v4-flash)", () => {
	let tempDir: string;
	let projectDir: string;
	let piDir: string;
	let agentsDir: string;
	let session: any;
	let cleanup: () => void;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-task-llm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(tempDir, "project");
		piDir = join(projectDir, ".pi");
		agentsDir = join(piDir, "agents");
		mkdirSync(agentsDir, { recursive: true });

		// Write a simple README for the subagent to read
		writeFileSync(join(projectDir, "README.md"), "# Test Project\n\nThis is a test project for persistent subagents.", "utf-8");

		// Write a custom agent config: deepseek-v4-flash, read-only, depth 1
		// Agent name is derived from the filename stem (testreader).
		const agentConfig = `---
description: A read-only test agent for safe file inspection
model: opencode-go/deepseek-v4-flash
tools: read
depth: 1
---

You are {{agent_name}}. Your job is to read and analyze files.

CRITICAL SAFETY RULES:
- You may ONLY use the read tool. You do NOT have bash, edit, or write tools.
- You may ONLY read files from the current working directory ({{cwd}}) and its subdirectories.
- Do NOT attempt to read files outside the project.
- Be concise.

Parent agent: {{parent_agent_id}}
Depth: {{depth}}
`;
		writeFileSync(join(agentsDir, "testreader.md"), agentConfig, "utf-8");
	});

	afterEach(() => {
		if (session) session.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("spawns a subagent that reads a file and returns content", async () => {
		const authPath = join(homedir(), ".pi", "agent", "auth.json");
		const authStorage = AuthStorage.create(authPath);
		const modelRegistry = ModelRegistry.create(authStorage);

		const sessionManager = SessionManager.inMemory(projectDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: projectDir,
			agentDir: join(homedir(), ".pi", "agent"),
			extensionFactories: [taskExtension],
		});
		await resourceLoader.reload();

		const model = getModel("opencode-go", "deepseek-v4-flash")!;
		const result = await createAgentSession({
			cwd: projectDir,
			agentDir: join(homedir(), ".pi", "agent"),
			model,
			sessionManager,
			resourceLoader,
		});
		session = result.session;

		const taskTool = session.agent.state.tools.find((t: any) => t.name === "Task");
		expect(taskTool).toBeDefined();

		const taskResult = await taskTool.execute(
			"test-call-1",
			{
				description: "Read project README",
				prompt: "Read the README.md file in the current working directory and summarize what this project is about in one sentence.",
				subagent_type: "testreader",
			},
			undefined,
			undefined,
		);

		expect(taskResult.content).toBeDefined();
		const text = taskResult.content?.[0]?.text ?? "";
		expect(text).toContain("testreader"); // display name should appear (from filename)
		expect(text).toContain("test project"); // README content should be summarized
		expect(text).not.toContain("failed");
		expect(taskResult.details?.error).toBeUndefined();
	}, 120_000);

	it("resumes a subagent and it remembers the prior conversation", async () => {
		const authPath = join(homedir(), ".pi", "agent", "auth.json");
		const authStorage = AuthStorage.create(authPath);
		const modelRegistry = ModelRegistry.create(authStorage);

		const sessionManager = SessionManager.inMemory(projectDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: projectDir,
			agentDir: join(homedir(), ".pi", "agent"),
			extensionFactories: [taskExtension],
		});
		await resourceLoader.reload();

		const model = getModel("opencode-go", "deepseek-v4-flash")!;
		const result = await createAgentSession({
			cwd: projectDir,
			agentDir: join(homedir(), ".pi", "agent"),
			model,
			sessionManager,
			resourceLoader,
		});
		session = result.session;

		const taskTool = session.agent.state.tools.find((t: any) => t.name === "Task");
		expect(taskTool).toBeDefined();

		// First task: tell the subagent a fact to remember
		const firstResult = await taskTool.execute(
			"test-call-2",
			{
				description: "Remember a color",
				prompt: 'My favorite color is turquoise. Respond with only the word "OK".',
				subagent_type: "testreader",
			},
			undefined,
			undefined,
		);

		expect(firstResult.details?.error).toBeUndefined();
		const resumeId = firstResult.details?.id;
		expect(resumeId).toBeDefined();
		expect(resumeId).toMatch(/^[0-9a-f]{8}$/);

		// Resume the same subagent and ask what it remembers
		const resumeResult = await taskTool.execute(
			"test-call-3",
			{
				description: "Recall favorite color",
				prompt: "What is my favorite color? Answer with exactly one word, no punctuation.",
				subagent_type: "TestReader",
				resume: resumeId,
			},
			undefined,
			undefined,
		);

		expect(resumeResult.details?.error).toBeUndefined();
		const resumeText = resumeResult.content?.[0]?.text ?? "";
		expect(resumeText.toLowerCase()).toContain("turquoise");
	}, 120_000);
});
