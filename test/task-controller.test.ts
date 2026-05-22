/**
 * Unit tests for TaskController.
 *
 * Tests the full execute() orchestration logic using adapter fakes,
 * plus the static utility methods (checkSpawnAllowed, resolveTaskAgent,
 * getFinalTextFromMessages).  All three adapters are injected so
 * the controller never touches concrete classes.
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
	type AgentWaitResult,
	type RuntimeContext,
	type AgentDiscoveryAdapter,
	type MetadataAdapter,
	type SessionAdapter,
} from "../subagent/task-controller.js";
import { defaultRootPolicy, selectedRootPolicy, type DepthPolicyState } from "../subagent/depth-policy.js";
import type { AgentConfig, AgentDiagnostic } from "../subagent/agents.js";
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

function fakeDiagnostics(): readonly AgentDiagnostic[] { return []; }

// ---------------------------------------------------------------------------
// Static utility methods
// ---------------------------------------------------------------------------

describe("TaskController.checkSpawnAllowed", () => {
	it("rejects spawn when depth limit has been reached", () => {
		const result = TaskController.checkSpawnAllowed(
			{ depth: 2, rootMaxDepth: 2, can_spawn: undefined },
			"Explore",
		);
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("depth_limit");
		expect(result.error).toContain("root depth limit 2");
	});

	it("allows spawn when below depth limit", () => {
		const result = TaskController.checkSpawnAllowed(
			{ depth: 1, rootMaxDepth: 2, can_spawn: undefined },
			"Explore",
		);
		expect(result.allowed).toBe(true);
	});

	it("rejects spawn when agent type is not in can_spawn allowlist", () => {
		const result = TaskController.checkSpawnAllowed(
			{ depth: 0, rootMaxDepth: 2, can_spawn: ["Planner", "Reviewer"] },
			"Explore",
		);
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("spawn_not_allowed");
		expect(result.error).toContain("only allowed to task Planner, Reviewer");
	});

	it("allows spawn when can_spawn is undefined (no restriction)", () => {
		const result = TaskController.checkSpawnAllowed(
			{ depth: 0, rootMaxDepth: 2, can_spawn: undefined },
			"Explore",
		);
		expect(result.allowed).toBe(true);
	});

	it("rejects spawn when rootMaxDepth is 0 (no spawning allowed at all)", () => {
		const result = TaskController.checkSpawnAllowed(
			{ depth: 0, rootMaxDepth: 0, can_spawn: undefined },
			"Explore",
		);
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("depth_limit");
		expect(result.error).toContain("root depth limit 0");
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

	it("returns unknown_agent_type error citing the record's agentType when resumed agent no longer exists", () => {
		const record = makeRecord("abc12345", "deleted-agent");
		record.displayName = "deleted-agent Tom";
		const store = makeMockMetadataFile([record]);
		const result = TaskController.resolveTaskAgent(
			{ subagent_type: "explorer", resume: "abc12345" },
			store,
			[makeAgent("explorer")],
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errorCode).toBe("unknown_agent_type");
			// Should mention the record's actual agentType, not params.subagent_type
			expect(result.errorText).toContain("deleted-agent");
			expect(result.errorText).toContain("deleted-agent Tom");
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
// TaskController.execute() — full orchestration with adapter fakes
// ---------------------------------------------------------------------------

describe("TaskController.execute", () => {
	let tempDir: string;
	let metadataStore: MetadataStore;
	let sessionManager: SubagentSessionManager;
	let mockModelResolver: ModelResolver;
	let controller: TaskController;

	// Fake adapters
	let fakeAgentDiscovery: AgentDiscoveryAdapter;
	let fakeMetadataStore: MetadataAdapter;
	let fakeSessionManager: SessionAdapter;

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

		// Build fake adapters from the real objects — MetadataStore and
		// SubagentSessionManager already satisfy their respective interfaces.
		fakeAgentDiscovery = {
			discover: vi.fn((_cwd) => ({
				agents: [makeAgent("explorer")],
				diagnostics: fakeDiagnostics(),
			})),
		};

		fakeMetadataStore = {
			load: vi.fn(() => metadataStore.load()),
			allocateRecord: vi.fn(
				(agentName, parentAgentId, depth) =>
					metadataStore.allocateRecord(agentName, parentAgentId, depth),
			),
			findRecord: vi.fn((id: string) => metadataStore.findRecord(id)),
			touchRecord: vi.fn((id: string) => metadataStore.touchRecord(id)),
			ctx: metadataStore.ctx,
			upsertRecord: vi.fn((record: SubagentRecord) => metadataStore.upsertRecord(record)),
		};

		fakeSessionManager = {
			getOrCreateSession: vi.fn(
				(record, agent, warnings, context) =>
					sessionManager.getOrCreateSession(record, agent, warnings, context),
			),
			withRecordRunLock: vi.fn(
				<T>(id: string, fn: () => Promise<T>) =>
					sessionManager.withRecordRunLock(id, fn),
			),
			disposeSession: vi.fn((id: string) => sessionManager.disposeSession(id)),
			waitForSessionEnd: vi.fn((id: string) => sessionManager.waitForSessionEnd(id)),
			storeAsyncResult: vi.fn((id: string, result: any) => sessionManager.storeAsyncResult(id, result)),
			getAsyncResult: vi.fn((id: string) => sessionManager.getAsyncResult(id)),
			clearAsyncResult: vi.fn((id: string) => sessionManager.clearAsyncResult(id)),
			markAsyncRunning: vi.fn((id: string) => sessionManager.markAsyncRunning(id)),
			clearAsyncRunning: vi.fn((id: string) => sessionManager.clearAsyncRunning(id)),
			isAsyncRunning: vi.fn((id: string) => sessionManager.isAsyncRunning(id)),
			isCompleted: vi.fn((id: string) => sessionManager.isCompleted(id)),
			hasOpenSession: vi.fn((id: string) => sessionManager.hasOpenSession(id)),
		};

		controller = new TaskController();
	});

	afterEach(() => {
		if (tempDir) {
			try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	function makeContext(overrides: Partial<TaskExecuteContext> = {}): TaskExecuteContext {
		const runtime: RuntimeContext = {
			treeDepth: 0,
			depthPolicy: defaultRootPolicy(),
		};
		return {
			cwd: tempDir,
			runtime,
			agentDiscovery: fakeAgentDiscovery,
			metadataStore: fakeMetadataStore,
			sessionManager: fakeSessionManager,
			modelResolver: mockModelResolver,
			createResourceLoaderFactory: vi.fn().mockResolvedValue(mockResourceLoader),
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
		// Override fake discovery to include no matching agent
		const ctx = makeContext({
			agentDiscovery: {
				discover: vi.fn(() => ({
					agents: [makeAgent("other")],
					diagnostics: fakeDiagnostics(),
				})),
			},
		});

		const result = await controller.execute(
			makeParams({ subagent_type: "explorer" }),
			ctx,
		);

		expect(result.details.error).toBe("unknown_agent_type");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Unknown sub-agent type");
	});

	// ---- Spawn permission ----

	it("returns error when depth limit would be exceeded", async () => {
		const runtime: RuntimeContext = {
			treeDepth: 2,
			depthPolicy: {
				treeDepth: 2,
				rootDepthLimit: 2,
				localDepthLimit: 1,
				can_spawn: undefined,
			},
		};
		const result = await controller.execute(
			makeParams(),
			makeContext({ runtime }),
		);

		expect(result.details.error).toBe("depth_limit");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("root depth limit 2");
	});

	it("returns error when agent not in can_spawn allowlist", async () => {
		const runtime: RuntimeContext = {
			treeDepth: 0,
			depthPolicy: {
				treeDepth: 0,
				rootDepthLimit: 5,
				localDepthLimit: 5,
				can_spawn: ["planner", "reviewer"],
			},
		};
		const result = await controller.execute(
			makeParams({ subagent_type: "explorer" }),
			makeContext({ runtime }),
		);

		expect(result.details.error).toBe("spawn_not_allowed");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("only allowed to task");
	});

	// ---- Error handling (prompt failures) ----

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
		oldRecord.displayName = "deleted-agent Tom";
		metadataStore.upsertRecord(oldRecord);

		const result = await controller.execute(
			makeParams({ resume: "deleted01", subagent_type: "explorer" }),
			makeContext(),
		);

		expect(result.details.error).toBe("unknown_agent_type");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("deleted-agent");
		expect(text).toContain("no longer available");
	});

	// ---- Setup failures (resource loader, session creation, discovery) ----

	it("returns error result when resource loader factory throws", async () => {
		const ctx = makeContext({
			createResourceLoaderFactory: vi.fn().mockRejectedValue(new Error("Loader boom")),
		});

		const result = await controller.execute(makeParams(), ctx);

		expect(result.details.error).toBe("Loader boom");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("failed to initialise resource loader");
	});

	it("returns error result when session manager throws", async () => {
		fakeSessionManager.getOrCreateSession = vi.fn().mockRejectedValue(new Error("Session boom"));

		const result = await controller.execute(makeParams(), makeContext());

		expect(result.details.error).toBe("Session boom");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("failed to create session");
	});

	it("returns error result when agent discovery throws", async () => {
		const ctx = makeContext({
			agentDiscovery: {
				discover: vi.fn(() => { throw new Error("Discovery boom"); }),
			},
		});

		const result = await controller.execute(makeParams(), ctx);

		expect(result.details.error).toBe("Discovery boom");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Task failed during agent discovery");
	});

	it("returns error result when metadata load throws", async () => {
		const ctx = makeContext({
			metadataStore: {
				load: vi.fn(() => { throw new Error("Metadata load boom"); }),
				allocateRecord: fakeMetadataStore.allocateRecord,
				findRecord: fakeMetadataStore.findRecord,
				touchRecord: fakeMetadataStore.touchRecord,
				ctx: fakeMetadataStore.ctx,
				upsertRecord: fakeMetadataStore.upsertRecord,
			},
		});

		const result = await controller.execute(makeParams(), ctx);

		expect(result.details.error).toBe("Metadata load boom");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Task failed while loading metadata");
	});

	it("returns error result when record allocation throws", async () => {
		const ctx = makeContext({
			metadataStore: {
				load: fakeMetadataStore.load,
				allocateRecord: vi.fn().mockRejectedValue(new Error("Allocation boom")),
				findRecord: fakeMetadataStore.findRecord,
				touchRecord: fakeMetadataStore.touchRecord,
				ctx: fakeMetadataStore.ctx,
				upsertRecord: fakeMetadataStore.upsertRecord,
			},
		});

		const result = await controller.execute(makeParams(), ctx);

		expect(result.details.error).toBe("Allocation boom");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Task failed during record allocation");
	});

	// ---- Effective CWD ----

	it("uses params.cwd when provided, falling back to context.cwd", async () => {
		mockSession.messages = [
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		];

		const customCwd = join(tempDir, "custom");
		mkdirSync(customCwd, { recursive: true });

		const result = await controller.execute(
			makeParams({ cwd: customCwd }),
			makeContext(),
		);

		expect(result.details.error).toBeUndefined();
	});

	// ---- Abort signal ----

	it("completes without throwing when signal is already aborted", async () => {
		const ac = new AbortController();
		ac.abort();

		await new Promise((r) => setTimeout(r, 5));

		const result = await new TaskController().execute(
			makeParams(),
			makeContext({ signal: ac.signal }),
		);

		expect(result).toBeDefined();
	});

	// ---- Async execution (blocking: false) ----

	it("returns immediately with agent details when blocking is false", async () => {
		const result = await controller.execute(
			makeParams({ blocking: false }),
			makeContext(),
		);

		expect(result.details.error).toBeUndefined();
		expect(result.details.id).toMatch(/^[0-9a-f]{8}$/);
		expect(result.details.displayName).toContain("explorer");
		expect(result.details.agentType).toBe("explorer");
		// Should return immediately — not waiting for the prompt to finish
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("started");
		expect(text).not.toContain("completed");
	});

	it("does not dispose session when returning from async spawn", async () => {
		// Make prompt never resolve so the async cleanup doesn't fire
		mockSession.prompt = vi.fn(() => new Promise(() => {}));

		await controller.execute(
			makeParams({ blocking: false }),
			makeContext(),
		);

		// Session should NOT be disposed immediately for async agents
		expect(disposeSpy).not.toHaveBeenCalled();
	});

	it("default blocking (undefined) preserves existing blocking behaviour", async () => {
		mockSession.messages = [
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		];

		const result = await controller.execute(
			makeParams(),
			makeContext(),
		);

		expect(result.details.error).toBeUndefined();
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("completed");
		expect(text).not.toContain("started");
	});

	it("blocking: true preserves existing behaviour", async () => {
		mockSession.messages = [
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		];

		const result = await controller.execute(
			makeParams({ blocking: true }),
			makeContext(),
		);

		expect(result.details.error).toBeUndefined();
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("completed");
	});

	// ---- waitForAgent ----

	it("returns error for unknown agent ID", async () => {
		const result = await controller.waitForAgent(
			["deadbeef"],
			{},
			makeContext(),
		);

		expect(result.details.error).toBe("unknown_agent_id");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Unknown agent ID");
	});

	it("waits for session end and returns structured result for known agent", async () => {
		// Set mock messages so the async cleanup handler captures real output
		mockSession.messages = [
			{ role: "user", content: "Do something" },
			{ role: "assistant", content: [{ type: "text", text: "async result output" }] },
		];

		// First spawn an async agent
		const spawnResult = await controller.execute(
			makeParams({ blocking: false }),
			makeContext(),
		);
		const agentId = (spawnResult.details as TaskDetails).id!;

		// Allow the async cleanup microtask to run (prompt resolves immediately)
		await new Promise((r) => setTimeout(r, 10));

		// Verify the session was already disposed by the async cleanup
		expect(sessionManager.hasOpenSession(agentId)).toBe(false);

		// Wait for the agent
		const result = await controller.waitForAgent([agentId], {}, makeContext());

		expect(result.details.error).toBeUndefined();
		expect(result.details.id).toBe(agentId);
		expect(result.details.displayName).toContain("explorer");
		expect(result.details.output).toBe("async result output");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("completed");
		expect(text).toContain("async result output");
		expect(text).toContain("Use resume:");
	});

	it("returns error result when async agent failed", async () => {
		// Make prompt reject so the async error path fires
		mockSession.prompt = vi.fn().mockRejectedValue(new Error("async crash"));

		const spawnResult = await controller.execute(
			makeParams({ blocking: false }),
			makeContext(),
		);
		const agentId = (spawnResult.details as TaskDetails).id!;

		await new Promise((r) => setTimeout(r, 10));

		const result = await controller.waitForAgent([agentId], {}, makeContext());

		expect(result.details.error).toBe("async crash");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("failed");
		expect(text).toContain("async crash");
	});


	it("captures output when agent finishes during waitForAgent (microtask ordering)", async () => {
		mockSession.messages = [
			{ role: "assistant", content: [{ type: "text", text: "mid-wait output" }] },
		];

		// Instrument subscribe to capture callbacks so we can fire agent_end.
		// The default mock returns vi.fn() but never stores or invokes callbacks.
		const subs: Array<(e: any) => void> = [];
		mockSession.subscribe = vi.fn((cb) => {
			subs.push(cb);
			return () => {
				const i = subs.indexOf(cb);
				if (i >= 0) subs.splice(i, 1);
			};
		});

		// Prompt never resolves — agent stays in-flight
		mockSession.prompt = vi.fn(() => new Promise(() => {}));

		// Spawn async (prompt not resolved yet)
		const spawnResult = await controller.execute(
			makeParams({ blocking: false }),
			makeContext(),
		);
		const agentId = (spawnResult.details as TaskDetails).id!;

		expect(sessionManager.hasOpenSession(agentId)).toBe(true);

		// Start waiting — subscribes to agent_end and awaits
		const waitPromise = controller.waitForAgent([agentId], {}, makeContext());

		// Simulate the real event order: agent_end fires first (synchronously
		// during session.prompt() resolution), then storeAsyncResult runs as
		// a microtask inside the finish() callback.
		for (const cb of subs) cb({ type: "agent_end" });
		queueMicrotask(() => {
			sessionManager.storeAsyncResult(agentId, { output: "mid-wait output", warnings: [] });
		});

		const result = await waitPromise;

		expect(result.details.error).toBeUndefined();
		expect(result.details.id).toBe(agentId);
		expect(result.details.output).toBe("mid-wait output");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("mid-wait output");
	});
	// ---- In-flight guard ----

	it("blocks blocking call when async is already in-flight on same record", async () => {
		// Make prompt never resolve so the async stays in-flight
		mockSession.prompt = vi.fn(() => new Promise(() => {}));

		const spawnResult = await controller.execute(
			makeParams({ blocking: false }),
			makeContext(),
		);
		const agentId = (spawnResult.details as TaskDetails).id!;

		// Try to start a blocking call on the same agent via resume
		const result = await controller.execute(
			makeParams({ blocking: true, resume: agentId, subagent_type: "explorer" }),
			makeContext(),
		);

		expect(result.details.error).toBe("async_in_flight");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("still running asynchronously");
	});

	// ---- Abort handling ----

	it("aborts background async session when parent signal fires", async () => {
		mockSession.prompt = vi.fn(() => new Promise(() => {}));
		const ac = new AbortController();

		await controller.execute(
			makeParams({ blocking: false }),
			makeContext({ signal: ac.signal }),
		);

		expect(mockSession.abort).not.toHaveBeenCalled();

		// Fire abort signal — should abort the background session
		ac.abort();

		expect(mockSession.abort).toHaveBeenCalled();
	});

	// ---- Expanded waitForAgent (#23) ----

	it("returns error when agent_ids is empty", async () => {
		const result = await controller.waitForAgent([], {}, makeContext());

		expect(result.details.error).toBe("missing_agent_ids");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("requires at least one agent_id");
	});

	it("returns per-agent statuses for multiple IDs (completed + running + unknown)", async () => {
		// Make an async agent that has already completed
		mockSession.messages = [
			{ role: "user", content: "Do something" },
			{ role: "assistant", content: [{ type: "text", text: "agent A output" }] },
		];
		const spawnA = await controller.execute(makeParams({ blocking: false }), makeContext());
		const idA = (spawnA.details as TaskDetails).id!;
		await new Promise((r) => setTimeout(r, 10)); // let async cleanup run

		// Make another async agent that is still running (prompt never resolves)
		const originalPrompt = mockSession.prompt;
		mockSession.prompt = vi.fn(() => new Promise(() => {}));
		const spawnB = await controller.execute(makeParams({ blocking: false }), makeContext());
		const idB = (spawnB.details as TaskDetails).id!;

		// Call waitForAgent with both IDs + an unknown
		const result = await controller.waitForAgent(
			[idA, idB, "deadbeef"],
			{},
			makeContext(),
		);

		const agents = result.details.agents as AgentWaitResult[];
		expect(agents).toHaveLength(3);

		const agentA = agents.find(a => a.id === idA)!;
		expect(agentA.status).toBe("completed");
		expect(agentA.output).toBe("agent A output");

		const agentB = agents.find(a => a.id === idB)!;
		expect(agentB.status).toBe("running");

		const agentUnknown = agents.find(a => a.id === "deadbeef")!;
		expect(agentUnknown.status).toBe("unknown");

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Completed");
		expect(text).toContain("Still Running");
		expect(text).toContain("Unknown IDs");

		// Restore prompt for cleanup
		mockSession.prompt = originalPrompt;
	});

	it("returns as soon as any listed running agent finishes", async () => {
		// Create two sessions with different IDs
		const subsA: Array<(e: any) => void> = [];
		const mockSessionA = {
			dispose: vi.fn(),
			subscribe: vi.fn((cb) => { subsA.push(cb); return () => {}; }),
			prompt: vi.fn(() => new Promise(() => {})),
			abort: vi.fn(),
			messages: [],
			getActiveToolNames: () => [],
		};

		const subsB: Array<(e: any) => void> = [];
		const mockSessionB = {
			dispose: vi.fn(),
			subscribe: vi.fn((cb) => { subsB.push(cb); return () => {}; }),
			prompt: vi.fn(() => new Promise(() => {})),
			abort: vi.fn(),
			messages: [],
			getActiveToolNames: () => [],
		};

		// Override factory to create distinct sessions per call
		let callCount = 0;
		mockAgentSessionFactory.create = vi.fn(() => {
			callCount++;
			return Promise.resolve(callCount === 1 ? mockSessionA : mockSessionB);
		});

		const spawnA = await controller.execute(makeParams({ blocking: false }), makeContext());
		const idA = (spawnA.details as TaskDetails).id!;

		const spawnB = await controller.execute(makeParams({ blocking: false }), makeContext());
		const idB = (spawnB.details as TaskDetails).id!;

		expect(sessionManager.hasOpenSession(idA)).toBe(true);
		expect(sessionManager.hasOpenSession(idB)).toBe(true);

		// Start waiting on both — should wait for first to finish
		const waitPromise = controller.waitForAgent([idA, idB], {}, makeContext());

		// Fire agent_end on B first — should cause waitForAgent to resolve
		await new Promise((r) => setTimeout(r, 5));
		for (const cb of subsB) cb({ type: "agent_end" });
		queueMicrotask(() => {
			sessionManager.storeAsyncResult(idB, { output: "agent B finished first", warnings: [] });
		});

		const result = await waitPromise;

		const agents = result.details.agents as AgentWaitResult[];
		expect(agents).toHaveLength(2);

		const agentB = agents.find(a => a.id === idB)!;
		expect(agentB.status).toBe("completed");
		expect(agentB.output).toBe("agent B finished first");

		// Agent A should still be "running" (not yet finished)
		const agentA = agents.find(a => a.id === idA)!;
		expect(agentA.status).toBe("running");

		// Restore original factory
		mockAgentSessionFactory.create = vi.fn().mockResolvedValue(mockSession);
	});

	it("reports timed_out_still_running when timeout expires", async () => {
		// Agent never finishes (prompt hangs)
		mockSession.prompt = vi.fn(() => new Promise(() => {}));

		const spawn = await controller.execute(makeParams({ blocking: false }), makeContext());
		const agentId = (spawn.details as TaskDetails).id!;

		// Wait with a very short timeout (1ms)
		const result = await controller.waitForAgent(
			[agentId],
			{ timeout: 0 }, // 0 minutes = instant timeout for test
			makeContext(),
		);

		const agents = result.details.agents as AgentWaitResult[];
		expect(agents).toHaveLength(1);
		expect(agents[0].status).toBe("timed_out_still_running");
		expect(agents[0].id).toBe(agentId);

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("timed out");

		// Agent should still be alive (not killed)
		expect(mockSession.abort).not.toHaveBeenCalled();
	});

	it("retrieves output from a finished blocking session", async () => {
		// Run a blocking agent to completion
		mockSession.messages = [
			{ role: "user", content: "Do something" },
			{ role: "assistant", content: [{ type: "text", text: "blocking result output" }] },
		];

		const blockingResult = await controller.execute(
			makeParams({ blocking: true }),
			makeContext(),
		);
		const agentId = (blockingResult.details as TaskDetails).id!;
		const sessionFile = (blockingResult.details as TaskDetails).sessionFile!;

		// Write simulated session data so readOutputFromSessionFile can find it
		const fs = await import("node:fs");
		fs.writeFileSync(sessionFile, JSON.stringify({
			type: "message",
			id: "msg1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "Do something" },
		}) + "\n");
		fs.appendFileSync(sessionFile, JSON.stringify({
			type: "message",
			id: "msg2",
			parentId: "msg1",
			timestamp: new Date().toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "blocking result output" }] },
		}) + "\n");

		// The blocking session has been disposed with output in the session file.
		// waitForAgent should be able to read it from persisted state.
		const result = await controller.waitForAgent([agentId], {}, makeContext());

		expect(result.details.error).toBeUndefined();
		expect(result.details.id).toBe(agentId);
		expect(result.details.output).toBe("blocking result output");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("blocking result output");
	});

	it("re-calling waitForAgent retrieves output from persisted state", async () => {
		// Spawn async and let it finish
		mockSession.messages = [
			{ role: "user", content: "Do something" },
			{ role: "assistant", content: [{ type: "text", text: "first retrieval output" }] },
		];

		const spawn = await controller.execute(makeParams({ blocking: false }), makeContext());
		const agentId = (spawn.details as TaskDetails).id!;
		const sessionFile = (spawn.details as TaskDetails).sessionFile!;
		await new Promise((r) => setTimeout(r, 10));

		// Write session data so persisted read works after async result is cleared
		const fs = await import("node:fs");
		fs.writeFileSync(sessionFile, JSON.stringify({
			type: "message",
			id: "msg1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "Do something" },
		}) + "\n");
		fs.appendFileSync(sessionFile, JSON.stringify({
			type: "message",
			id: "msg2",
			parentId: "msg1",
			timestamp: new Date().toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "first retrieval output" }] },
		}) + "\n");

		// First call: consumes async result from memory
		const result1 = await controller.waitForAgent([agentId], {}, makeContext());
		expect(result1.details.output).toBe("first retrieval output");

		// Verify async result was cleared from memory
		expect(sessionManager.getAsyncResult(agentId)).toBeUndefined();

		// Second call: should re-read from persisted session file
		const result2 = await controller.waitForAgent([agentId], {}, makeContext());
		expect(result2.details.output).toBe("first retrieval output");

		// Verify the output is still retrievable
		const text = result2.content[0]?.type === "text" ? result2.content[0].text : "";
		expect(text).toContain("first retrieval output");
	});

	it("consumes and clears in-memory async result after retrieval", async () => {
		mockSession.messages = [
			{ role: "user", content: "Do something" },
			{ role: "assistant", content: [{ type: "text", text: "consume me" }] },
		];

		const spawn = await controller.execute(makeParams({ blocking: false }), makeContext());
		const agentId = (spawn.details as TaskDetails).id!;
		await new Promise((r) => setTimeout(r, 10));

		// Verify async result exists before retrieval
		expect(sessionManager.getAsyncResult(agentId)).toBeDefined();

		// Retrieve
		await controller.waitForAgent([agentId], {}, makeContext());

		// Async result should be cleared
		expect(sessionManager.getAsyncResult(agentId)).toBeUndefined();
	});
});
