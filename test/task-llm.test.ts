/**
 * LLM integration tests for persistent-task-subagents.
 *
 * These tests verify actual Task execution with a real LLM.
 *
 * These tests are opt-in and run only when:
 * - RUN_REAL_LLM_TESTS=1
 * - the local ~/.pi/agent/auth.json contains openai-codex auth
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getModel } from "@mariozechner/pi-ai";
import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";
import taskExtension from "../subagent/index.js";

const RUN_REAL_LLM_TESTS = process.env.RUN_REAL_LLM_TESTS === "1";

function hasOpenAICodexAuth(): boolean {
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) return false;

	try {
		const data = JSON.parse(readFileSync(authPath, "utf-8"));
		return data["openai-codex"]?.type === "oauth";
	} catch {
		return false;
	}
}

const SHOULD_RUN_REAL_LLM_TESTS = RUN_REAL_LLM_TESTS && hasOpenAICodexAuth();

describe.skipIf(!SHOULD_RUN_REAL_LLM_TESTS)("Task with real LLM (gpt-5.4-mini) [opt-in]", () => {
	let tempDir: string;
	let projectDir: string;
	let agentDir: string;
	let session: any;
	let cleanup: () => void;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-task-llm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(tempDir, "project");
		agentDir = join(tempDir, "agent-discovery");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;

		// Seed a default root agent so before_agent_start can resolve the root.
		writeFileSync(join(agentDir, "agents", "default.md"), `---\ndescription: Default Root Agent\ndepth: 1\n---\n\nDefault Root Agent\n`, "utf-8");

		// Write a simple README for the subagent to read
		writeFileSync(join(projectDir, "README.md"), "# Test Project\n\nThis is a test project for persistent subagents.", "utf-8");

		// Write a custom agent config: gpt-5.4-mini, read-only, depth 1
		// Agent name is derived from the filename stem (testreader).
		const agentConfig = `---
description: A read-only test agent for safe file inspection
model: openai-codex/gpt-5.4-mini
tools: read
depth: 1
---

You are {{agent_name}}. Your job is to read and analyze files.

CRITICAL SAFETY RULES:
- You may ONLY use the read tool. You do NOT have bash, edit, or write tools.
- You may ONLY read files from the current working directory ({{cwd}}) and its subdirectories.
- Do NOT attempt to read files outside the project.
- Be concise.
`;
		writeFileSync(join(agentDir, "agents", "testreader.md"), agentConfig, "utf-8");
	});

	afterEach(() => {
		if (session) session.dispose();
		delete process.env.PI_CODING_AGENT_DIR;
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("spawns a subagent that reads a file and returns content", async () => {
		const authPath = join(homedir(), ".pi", "agent", "auth.json");
		const authStorage = AuthStorage.create(authPath);
		const modelRegistry = ModelRegistry.create(authStorage);

		const sessionDir = join(projectDir, ".sessions");
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: projectDir,
			agentDir: join(homedir(), ".pi", "agent"),
			extensionFactories: [taskExtension],
		});
		await resourceLoader.reload();

		const model = getModel("openai-codex", "gpt-5.4-mini")!;
		const result = await createAgentSession({
			cwd: projectDir,
			agentDir: join(homedir(), ".pi", "agent"),
			model,
			sessionManager,
			resourceLoader,
		});
		session = result.session;

		// Bind extensions so session_start fires and registers Task via the resolved policy
		await session.bindExtensions({});

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
		expect(text).not.toContain("failed");
		expect(taskResult.details?.error).toBeUndefined();
	}, 120_000);

	it("resumes a subagent and it remembers the prior conversation", async () => {
		const authPath = join(homedir(), ".pi", "agent", "auth.json");
		const authStorage = AuthStorage.create(authPath);
		const modelRegistry = ModelRegistry.create(authStorage);

		const sessionDir = join(projectDir, ".sessions");
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: projectDir,
			agentDir: join(homedir(), ".pi", "agent"),
			extensionFactories: [taskExtension],
		});
		await resourceLoader.reload();

		const model = getModel("openai-codex", "gpt-5.4-mini")!;
		const result = await createAgentSession({
			cwd: projectDir,
			agentDir: join(homedir(), ".pi", "agent"),
			model,
			sessionManager,
			resourceLoader,
		});
		session = result.session;

		// Bind extensions so session_start fires and registers Task via the resolved policy
		await session.bindExtensions({});

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
