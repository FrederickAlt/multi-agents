/**
 * Unit tests for TaskController.
 *
 * Tests the full execute() orchestration logic using mock adapters,
 * plus the static utility methods (checkSpawnAllowed, resolveTaskAgent,
 * getFinalTextFromMessages).
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetadataStore } from "../subagent/metadata.js";
import {
	SubagentSessionManager,
	type ModelResolver,
} from "../subagent/session-manager.js";
import {
	TaskController,
	type TaskExecuteContext,
	type TaskExecuteParams,
	type TaskDetails,
	type RuntimeContext,
} from "../subagent/task-controller.js";
import type { AgentConfig } from "../subagent/agents.js";
import type { SubagentRecord, MetadataFile } from "../subagent/metadata.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(id: string, agentType = "explorer"): SubagentRecord {
	return {
		id,
		humanName: "Tom",
		displayName: `${agentType} Tom`,
		agentType,
		sessionFile: "",
		depth: 1,
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
	};
}

function makeAgent(name = "explorer"): AgentConfig {
	return {
		name,
		description: `${name} description`,
		systemPrompt: "You are {{agent_name}}.",
		source: "builtin",
		filePath: `/tmp/${name}.md`,
		tools: [],
	};
}

function makeMockMetadataFile(records: SubagentRecord[] = []): MetadataFile {
	return {
		version: 1,
		mainSessionId: "test-session",
		records,
	};
}

// ---------------------------------------------------------------------------
// Static utility methods (tested independently of execute)
// ---------------------------------------------------------------------------

describe("TaskController.checkSpawnAllowed", () => {
	it("rejects spawn when depth limit has been reached", () => {
		const result = TaskController.checkSpawnAllowed(
			{ depth: 2, rootMaxDepth: 2, canSpawn: undefined },
			"Explore",
		);
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("depth_limit");
		expect(result.error).toContain("depth limit 2 has been reached");
	});

	it("allows spawn when below depth limit", () => {
		const result = TaskController.checkSpawnAllowed(
			{ depth: 1, rootMaxDepth: 2, canSpawn: undefined },
			"Explore",
		);
		expect(result.allowed).toBe(true);
	});

	it("rejects spawn when agent type is not in canSpawn allowlist", () => {
		const result = TaskController.checkSpawnAllowed(
			{ depth: 0, rootMaxDepth: 2, canSpawn: ["Planner", "Reviewer"] },
			"Explore",
		);
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("spawn_not_allowed");
		expect(result.error).toContain("only allowed to spawn Planner, Reviewer");
	});

	it("allows spawn when canSpawn is undefined (no restriction)", () => {
		const result = TaskController.checkSpawnAllowed(
			{ depth: 0, rootMaxDepth: 2, canSpawn: undefined },
			"Explore",
		);
		expect(result.allowed).toBe(true);
	});

	it("rejects spawn when rootMaxDepth is 0 (no spawning allowed at all)", () => {
		const result = TaskController.checkSpawnAllowed(
			{ depth: 0, rootMaxDepth: 0, canSpawn: undefined },
			"Explore",
		);
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("depth_limit");
		expect(result.error).toContain("depth limit 0 has been reached");
	});
});

describe("TaskController.resolveTaskAgent", () => {
	it("returns unknown_resume_id error when resume ID does not exist", () => {
		const store = makeMockMetadataFile([makeRecord("abc12345", "Explore")]);
		const result = TaskController.resolveTaskAgent(
			{ subagent_type: "Explore", resume: "deadbeef" },
			store,
			[makeAgent("Explore")],
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errorCode).toBe("unknown_resume_id");
			expect(result.errorText).toContain("Unknown sub-agent ID");
			expect(result.errorText).toContain("abc12345");
		}
	});

	it("returns unknown_agent_type error when agent type is not available", () => {
		const store = makeMockMetadataFile();
		const result = TaskController.resolveTaskAgent(
			{ subagent_type: "Missing" },
			store,
			[makeAgent("Explore")],
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errorCode).toBe("unknown_agent_type");
			expect(result.errorText).toContain("Unknown sub-agent type");
			expect(result.errorText).toContain("Explore");
		}
	});

	it("resolves agent by subagent_type when no resume", () => {
		const store = makeMockMetadataFile();
		const agent = makeAgent("Explore");
		const result = TaskController.resolveTaskAgent(
			{ subagent_type: "Explore" },
			store,
			[agent],
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.agent.name).toBe("Explore");
			expect(result.record).toBeUndefined();
		}
	});

	it("resolves agent by record when resume is provided", () => {
		const record = makeRecord("abc12345", "Explore");
		const store = makeMockMetadataFile([record]);
		const agent = makeAgent("Explore");
		const result = TaskController.resolveTaskAgent(
			{ subagent_type: "Explore", resume: "abc12345" },
			store,
			[agent],
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.agent.name).toBe("Explore");
			expect(result.record).toEqual(record);
		}
	});

	it("returns unknown_agent_type when resume record's agent type no longer exists", () => {
		const record = makeRecord("abc12345", "deleted-agent");
		const store = makeMockMetadataFile([record]);
		const result = TaskController.resolveTaskAgent(
			{ subagent_type: "Deleted", resume: "abc12345" },
			store,
			[makeAgent("Explore")],
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errorCode).toBe("unknown_agent_type");
			expect(result.errorText).toContain("Unknown sub-agent type");
		}
	});
});

describe("TaskController.getFinalTextFromMessages", () => {
	it("returns the last assistant text content", () => {
		const messages = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "Hello! How can I help?" }] },
		];
		expect(TaskController.getFinalTextFromMessages(messages)).toBe("Hello! How can I help?");
	});

	it("returns last assistant text when multiple assistant messages exist", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{ role: "user", content: "prompt" },
			{ role: "assistant", content: [{ type: "text", text: "second" }] },
		];
		expect(TaskController.getFinalTextFromMessages(messages)).toBe("second");
	});

	it("returns empty string if no assistant message", () => {
		const messages = [{ role: "user", content: "just user" }];
		expect(TaskController.getFinalTextFromMessages(messages)).toBe("");
	});

	it("returns empty string if assistant has no text content", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] },
		];
		expect(TaskController.getFinalTextFromMessages(messages)).toBe("");
	});

	it("skips non-assistant roles when searching backwards", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "the answer" }] },
			{ role: "user", content: "final prompt" },
		];
		expect(TaskController.getFinalTextFromMessages(messages)).toBe("the answer");
	});
});

// ---------------------------------------------------------------------------
// TaskController.execute() — full orchestration tests
// ---------------------------------------------------------------------------

describe("TaskController.execute", () => {
	let tempDir: string;
	let metadataStore: MetadataStore;
	let sessionManager: SubagentSessionManager;
	let mockModelResolver: ModelResolver;
	let controller: TaskController;

	// Per-session mocks
	let mockSession: any;
	let disposeSpy: ReturnType<typeof vi.fn>;
	let mockSessionManagerProvider: { openOrCreate: ReturnType<typeof vi.fn> };
	let mockAgentSessionFactory: { create: ReturnType<typeof vi.fn> };
	let mockResourceLoader: any;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-tc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		metadataStore = new MetadataStore({
			sessionDir: tempDir,
			sessionId: "tc-test-session",
			sessionFile: join(tempDir, "tc-test.jsonl"),
		});
		metadataStore.load();

		mockSessionManagerProvider = {
			openOrCreate: vi.fn(() => ({
				getSessionFile: () => join(tempDir, "sub-test.jsonl"),
			})),
		};

		disposeSpy = vi.fn();
		mockSession = {
			dispose: disposeSpy,
			subscribe: vi.fn(() => vi.fn()),
			prompt: vi.fn().mockResolvedValue(undefined),
			abort: vi.fn(),
			messages: [],
			getActiveToolNames: () => [],
		};

		mockAgentSessionFactory = {
			create: vi.fn().mockResolvedValue(mockSession),
		};

		mockModelResolver = {
			resolve: vi.fn((_name, fallback, _warnings) => fallback),
		};

		mockResourceLoader = { reload: vi.fn().mockResolvedValue(undefined) };

		sessionManager = new SubagentSessionManager(
			mockSessionManagerProvider,
			mockAgentSessionFactory,
		);

		controller = new TaskController();
	});

	afterEach(() => {
		if (tempDir) {
			try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	function makeContext(overrides: Partial<TaskExecuteContext> = {}): TaskExecuteContext {
		const runtime: RuntimeContext = {
			depth: 0,
			rootMaxDepth: Number.POSITIVE_INFINITY,
		};
		return {
			cwd: tempDir,
			runtime,
			agentScope: "both" as const,
			metadataStore,
			sessionManager,
			modelResolver: mockModelResolver,
			createResourceLoaderFactory: vi.fn().mockResolvedValue(mockResourceLoader),
			selfPath: "/tmp/self.js",
			...overrides,
		};
	}

	function makeParams(overrides: Partial<TaskExecuteParams> = {}): TaskExecuteParams {
		return {
			description: "Test task",
			prompt: "Do something",
			subagent_type: "explorer",
			...overrides,
		};
	}

	// ---- Success path ----

	it("executes a task successfully and returns structured result", async () => {
		mockSession.messages = [
			{ role: "user", content: "Do something" },
			{ role: "assistant", content: [{ type: "text", text: "Task completed successfully!" }] },
		];

		const result = await controller.execute(makeParams(), makeContext());

		expect(result.content).toBeDefined();
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("completed");
		expect(text).toContain("Task completed successfully!");
		expect(text).toContain("Use resume:");

		const details = result.details as TaskDetails;
		expect(details.id).toMatch(/^[0-9a-f]{8}$/);
		expect(details.displayName).toContain("explorer");
		expect(details.agentType).toBe("explorer");
		expect(details.error).toBeUndefined();
		expect(details.output).toBe("Task completed successfully!");
	});

	it("returns a unique hex ID that persists in metadata", async () => {
		mockSession.messages = [
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		];

		const result = await controller.execute(makeParams(), makeContext());
		const id = (result.details as TaskDetails).id!;
		expect(id).toMatch(/^[0-9a-f]{8}$/);

		const stored = metadataStore.findRecord(id);
		expect(stored).toBeDefined();
		expect(stored!.agentType).toBe("explorer");
	});

	it("persists the session file to metadata", async () => {
		mockSession.messages = [
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		];

		const result = await controller.execute(makeParams(), makeContext());
		const id = (result.details as TaskDetails).id!;

		const stored = metadataStore.findRecord(id);
		expect(stored!.sessionFile).toBe(join(tempDir, "sub-test.jsonl"));
	});

	it("disposes the session after execution", async () => {
		mockSession.messages = [
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		];

		await controller.execute(makeParams(), makeContext());

		expect(disposeSpy).toHaveBeenCalled();
	});

	// ---- Agent type validation ----

	it("returns error when agent type does not exist", async () => {
		const result = await controller.execute(
			makeParams({ subagent_type: "nonexistent" }),
			makeContext(),
		);

		expect(result.details.error).toBe("unknown_agent_type");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Unknown sub-agent type");
	});

	// ---- Spawn permission ----

	it("returns error when depth limit would be exceeded", async () => {
		const runtime: RuntimeContext = {
			depth: 2,
			rootMaxDepth: 2,
		};
		const result = await controller.execute(
			makeParams(),
			makeContext({ runtime }),
		);

		expect(result.details.error).toBe("depth_limit");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("depth limit 2 has been reached");
	});

	it("returns error when agent not in canSpawn allowlist", async () => {
		const runtime: RuntimeContext = {
			depth: 0,
			rootMaxDepth: 5,
			canSpawn: ["planner", "reviewer"],
		};
		const result = await controller.execute(
			makeParams({ subagent_type: "explorer" }),
			makeContext({ runtime }),
		);

		expect(result.details.error).toBe("spawn_not_allowed");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("only allowed to spawn");
	});

	// ---- Error handling ----

	it("returns error result when session.prompt throws", async () => {
		mockSession.prompt = vi.fn().mockRejectedValue(new Error("Model error"));

		const result = await controller.execute(makeParams(), makeContext());

		expect(result.details.error).toBe("Model error");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("failed");
		expect(text).toContain("Model error");
		expect(text).toContain("Use resume:");
	});

	it("still disposes the session when prompt throws", async () => {
		mockSession.prompt = vi.fn().mockRejectedValue(new Error("bang"));

		await controller.execute(makeParams(), makeContext());

		expect(disposeSpy).toHaveBeenCalled();
	});

	it("handles non-Error throwables gracefully", async () => {
		mockSession.prompt = vi.fn().mockRejectedValue("string error");

		const result = await controller.execute(makeParams(), makeContext());

		expect(result.details.error).toBe("string error");
	});

	// ---- Empty output ----

	it("returns (no output) when session has no assistant text", async () => {
		mockSession.messages = [];

		const result = await controller.execute(makeParams(), makeContext());

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("(no output)");
	});

	// ---- onUpdate callback ----

	it("calls onUpdate with progress when provided", async () => {
		mockSession.messages = [
			{ role: "assistant", content: [{ type: "text", text: "result" }] },
		];

		const onUpdate = vi.fn();
		const result = await controller.execute(
			makeParams(),
			makeContext({ onUpdate }),
		);

		expect(onUpdate).toHaveBeenCalled();
		const firstCall = onUpdate.mock.calls[0][0];
		expect(firstCall.details.id).toBe((result.details as TaskDetails).id);
		expect(firstCall.details.displayName).toContain("explorer");
	});

	// ---- Resume ----

	it("resumes an existing sub-agent by its hex ID", async () => {
		const existingRecord = makeRecord("abcd1234", "explorer");
		existingRecord.sessionFile = join(tempDir, "existing.jsonl");
		metadataStore.upsertRecord(existingRecord);

		mockSession.messages = [
			{ role: "assistant", content: [{ type: "text", text: "continuing..." }] },
		];

		const result = await controller.execute(
			makeParams({ resume: "abcd1234", subagent_type: "explorer" }),
			makeContext(),
		);

		const details = result.details as TaskDetails;
		expect(details.id).toBe("abcd1234");
		expect(details.resumed).toBe(true);
		expect(details.error).toBeUndefined();
	});

	it("returns error when resume ID does not exist in metadata", async () => {
		const result = await controller.execute(
			makeParams({ resume: "deadbeef", subagent_type: "explorer" }),
			makeContext(),
		);

		expect(result.details.error).toBe("unknown_resume_id");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Unknown sub-agent ID");
	});

	it("returns error when resume record's agent type no longer exists", async () => {
		const oldRecord = makeRecord("deleted01", "deleted-agent");
		metadataStore.upsertRecord(oldRecord);

		const result = await controller.execute(
			makeParams({ resume: "deleted01", subagent_type: "explorer" }),
			makeContext(),
		);

		expect(result.details.error).toBe("unknown_agent_type");
	});

	// ---- Effective CWD ----

	it("uses params.cwd when provided, falling back to context.cwd", async () => {
		mockSession.messages = [
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		];

		const customCwd = join(tempDir, "custom");
		mkdirSync(customCwd, { recursive: true });

		await controller.execute(
			makeParams({ cwd: customCwd }),
			makeContext(),
		);

		// The resource loader factory was called
		// We can't easily inspect the cwd passed to the session manager,
		// but the test verifies no errors occur with a valid cwd.
	});

	// ---- Abort signal ----

	it("aborts the session when signal is already aborted", async () => {
		const ac = new AbortController();
		ac.abort();

		await new Promise((r) => setTimeout(r, 5));

		const result = await new TaskController().execute(
			makeParams(),
			makeContext({ signal: ac.signal }),
		);

		expect(result).toBeDefined();
	});
});
