/**
 * Unit tests for SubagentSessionManager.
 *
 * Tests the full session lifecycle: creation model/tool warnings, session
 * file persistence, agent_end timestamp updates, dispose/unsubscribe,
 * session tracking, and run serialisation — all via mock adapters without
 * live Pi sessions or an LLM.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { MetadataStore } from "../subagent/metadata.js";
import {
	ABORT_FINAL_SUMMARY_CANCEL_GRACE_MS,
	ABORT_FINAL_SUMMARY_MESSAGE,
	ABORT_FINAL_SUMMARY_TIMEOUT_MS,
	PiAgentSessionFactory,
	SubagentSessionManager,
	type SessionSetupContext,
} from "../subagent/session-manager.js";
import { DefaultResourceLoader, SessionManager, type AgentSession } from "@mariozechner/pi-coding-agent";
import type { SubagentRecord } from "../subagent/metadata.js";
import type { AgentConfig } from "../subagent/agents.js";
import type { DebugLogger } from "../subagent/debug-logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(id: string, agentType = "scout"): SubagentRecord {
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

function makeAgent(name = "scout"): AgentConfig {
	return {
		name,
		description: `${name} description`,
		systemPrompt: "You are {{agent_name}}.",
		source: "builtin",
		filePath: `/tmp/${name}.md`,
	};
}

interface MockSessionCallbacks {
	callbacks: Array<(event: any) => void>;
	dispose: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	unsubscribe: ReturnType<typeof vi.fn>;
	messages: any[];
	getActiveToolNames: () => string[];
}

function makeMockSession(tools?: string[]): MockSessionCallbacks & AgentSession {
	const callbacks: Array<(event: any) => void> = [];
	const unsubscribe = vi.fn(() => {
		callbacks.length = 0;
	});
	const session = {
		dispose: vi.fn(),
		getActiveToolNames: () => tools ?? [],
		subscribe: vi.fn((cb: (event: any) => void) => {
			callbacks.push(cb);
			return unsubscribe;
		}),
		prompt: vi.fn(),
		abort: vi.fn(),
		messages: [],
		callbacks,
		unsubscribe,
	} as unknown as MockSessionCallbacks & AgentSession;
	return session;
}

function makeMockPiSessionManager(sessionFile: string) {
	return {
		getSessionFile: () => sessionFile,
	};
}

function makeSpyDebugLogger(sink: Array<{ event: string }>): DebugLogger {
	const create = (context: Record<string, unknown>): DebugLogger => ({
		isEnabled: true,
		child: (childContext) => create({ ...context, ...childContext }),
		log: (level, event) => {
			sink.push({ event });
		},
		debug: (event) => create(context).log("debug", event),
		info: (event) => create(context).log("info", event),
		warn: (event) => create(context).log("warn", event),
		error: (event) => create(context).log("error", event),
	});

	return create({});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SubagentSessionManager", () => {
	let tempDir: string;
	let metadataStore: MetadataStore;
	let mockSessionManagerProvider: {
		openOrCreate: ReturnType<typeof vi.fn>;
	};
	let mockAgentSessionFactory: {
		create: ReturnType<typeof vi.fn>;
	};
	let mockModelResolver: {
		resolve: ReturnType<typeof vi.fn>;
	};
	let defaultCreateResourceLoader: ReturnType<typeof vi.fn>;
	let defaultSetupContext: SessionSetupContext;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-session-mgr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		metadataStore = new MetadataStore({
			sessionDir: tempDir,
			sessionId: "test-session",
			sessionFile: join(tempDir, "test-session.jsonl"),
		});
		metadataStore.load();

		mockSessionManagerProvider = {
			openOrCreate: vi.fn(() => makeMockPiSessionManager(join(tempDir, "sub-test.jsonl"))),
		};
		mockAgentSessionFactory = {
			create: vi.fn(() => Promise.resolve(makeMockSession())),
		};
		mockModelResolver = {
			resolve: vi.fn((_name, fallback, _warnings) => fallback),
		};
		defaultCreateResourceLoader = vi.fn(() => Promise.resolve({ reload: vi.fn() } as any));

		defaultSetupContext = {
			metadataStore,
			cwd: tempDir,
			fallbackModel: undefined,
			modelResolver: mockModelResolver,
			createResourceLoader: defaultCreateResourceLoader,
		};
	});

	afterEach(() => {
		if (tempDir) {
			try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	function createManager(options?: { logger?: DebugLogger }): SubagentSessionManager {
		return new SubagentSessionManager(
			mockSessionManagerProvider,
			mockAgentSessionFactory,
			options?.logger,
		);
	}

	// ---- Session tracking ----

	describe("session tracking", () => {
		it("starts with no open sessions", () => {
			const sm = createManager();
			expect(sm.hasOpenSession("abc123")).toBe(false);
			expect(sm.getOpenSession("abc123")).toBeUndefined();
		});

		it("trackSession registers a session for retrieval", () => {
			const sm = createManager();
			const session = makeMockSession();
			sm.trackSession("abc123", session);
			expect(sm.hasOpenSession("abc123")).toBe(true);
			expect(sm.getOpenSession("abc123")).toBe(session);
		});

		it("getOpenSession returns undefined for unknown IDs", () => {
			const sm = createManager();
			sm.trackSession("aaa", makeMockSession());
			expect(sm.getOpenSession("bbb")).toBeUndefined();
		});

		it("trackSession overwrites a previous session for the same ID", () => {
			const sm = createManager();
			const s1 = makeMockSession();
			const s2 = makeMockSession();
			sm.trackSession("x", s1);
			sm.trackSession("x", s2);
			expect(sm.getOpenSession("x")).toBe(s2);
		});
	});

	// ---- Session creation lifecycle ----

	describe("getOrCreateSession", () => {
		it("returns an existing session when already tracked", async () => {
			const sm = createManager();
			const existing = makeMockSession();
			sm.trackSession("abc", existing);

			const result = await sm.getOrCreateSession(
				makeRecord("abc"),
				makeAgent(),
				[],
				defaultSetupContext,
			);
			expect(result).toBe(existing);
			expect(mockAgentSessionFactory.create).not.toHaveBeenCalled();
			expect(defaultCreateResourceLoader).not.toHaveBeenCalled();
		});

		it("creates a new session via the factory when not tracked", async () => {
			const sm = createManager();
			const record = makeRecord("new-id");
			const agent = makeAgent("worker");

			const session = await sm.getOrCreateSession(record, agent, [], defaultSetupContext);
			expect(session).toBeDefined();
			expect(mockAgentSessionFactory.create).toHaveBeenCalledOnce();
			const createArg = mockAgentSessionFactory.create.mock.calls[0][0];
			expect(createArg.cwd).toBe(tempDir);
			expect(createArg.tools).toBeUndefined(); // worker has no tools filter
		});

		it("passes resource loader and session manager to agent session factory", async () => {
			const sm = createManager();
			const record = makeRecord("factory-args");
			const agent = makeAgent("scout");

			await sm.getOrCreateSession(record, agent, [], defaultSetupContext);

			// Resource loader was created
			expect(defaultCreateResourceLoader).toHaveBeenCalledWith(agent);

			// Session manager provider was called — record.sessionFile is "" for new records
			expect(mockSessionManagerProvider.openOrCreate).toHaveBeenCalledWith(
				"",
				tempDir,
				tempDir,
			);

			// Agent session factory received the right args
			const createArg = mockAgentSessionFactory.create.mock.calls[0][0];
			expect(createArg.resourceLoader).toBeDefined();
			expect(createArg.sessionManager).toBeDefined();
		});

		it("calls modelResolver.resolve with agent.model and fallbackModel", async () => {
			const sm = createManager();
			const record = makeRecord("model-test");
			const agent = makeAgent("scout");
			agent.model = "custom-model";
			const fallback = { id: "fallback" } as any;

			await sm.getOrCreateSession(record, agent, [], {
				...defaultSetupContext,
				fallbackModel: fallback,
			});
			expect(mockModelResolver.resolve).toHaveBeenCalledWith(
				"custom-model",
				fallback,
				expect.any(Array),
			);
		});

		it("collects model warnings when configured model not found", async () => {
			const sm = createManager();
			const warnings: string[] = [];
			mockModelResolver.resolve = vi.fn((_name, fallback, w) => {
				w.push("Model not found");
				return fallback;
			});

			await sm.getOrCreateSession(makeRecord("warn-model"), makeAgent(), warnings, defaultSetupContext);
			expect(warnings).toContain("Model not found");
		});

		it("collects tool warnings when configured tools are not available", async () => {
			const sm = createManager();
			const warnings: string[] = [];
			const agent = makeAgent("strict");
			agent.tools = ["read", "bash", "missing-tool"];
			// Mock session only has read and bash
			mockAgentSessionFactory.create = vi.fn(() =>
				Promise.resolve(makeMockSession(["read", "bash"])),
			);

			await sm.getOrCreateSession(makeRecord("tool-warn"), agent, warnings, defaultSetupContext);
			expect(warnings).toContain('Configured tool "missing-tool" is not available for strict.');
			expect(warnings).not.toContain(expect.stringContaining("read"));
			expect(warnings).not.toContain(expect.stringContaining("bash"));
		});

		it("persists sessionFile to metadata via upsertRecord", async () => {
			const sm = createManager();
			const record = makeRecord("persist-sf");
			expect(record.sessionFile).toBe("");

			await sm.getOrCreateSession(record, makeAgent(), [], defaultSetupContext);
			// After creation, sessionFile should be set
			expect(record.sessionFile).toBe(join(tempDir, "sub-test.jsonl"));
			// Metadata store should have it
			const stored = metadataStore.findRecord(record.id);
			expect(stored?.sessionFile).toBe(join(tempDir, "sub-test.jsonl"));
		});

		it("agent_end event updates record.updatedAt via metadata store", async () => {
			const sm = createManager();
			const record = makeRecord("agent-end");
			// Create a session whose subscribe callbacks we can trigger
			let subscribeCb: (event: any) => void = () => {};
			const mockSession = makeMockSession();
			mockSession.subscribe = vi.fn((cb: (event: any) => void) => {
				subscribeCb = cb;
				return () => {};
			});
			mockAgentSessionFactory.create = vi.fn(() => Promise.resolve(mockSession));

			await sm.getOrCreateSession(record, makeAgent(), [], defaultSetupContext);

			const beforeTs = record.updatedAt;

			// Wait a tick so the new timestamp differs
			await new Promise((r) => setTimeout(r, 5));
			subscribeCb({ type: "agent_end" });

			expect(record.updatedAt).not.toBe(beforeTs);
			const newTs = new Date(record.updatedAt).getTime();
			expect(newTs).toBeGreaterThan(new Date(beforeTs).getTime());
		});

		it("disposeSession unsubscribes before calling real dispose", async () => {
			const sm = createManager();
			const record = makeRecord("unsub");
			// Keep a reference to the original dispose spy; the manager wraps it
			// so we must check the original spy, not mockSession.dispose.
			const disposeSpy = vi.fn();
			const mockSession = makeMockSession();
			mockSession.dispose = disposeSpy as any;
			mockSession.subscribe = vi.fn(() => mockSession.unsubscribe);
			mockAgentSessionFactory.create = vi.fn(() => Promise.resolve(mockSession));

			await sm.getOrCreateSession(record, makeAgent(), [], defaultSetupContext);
			expect(mockSession.subscribe).toHaveBeenCalledOnce();

			sm.disposeSession(record.id);
			// Unsubscribe was called before the original dispose
			expect(mockSession.unsubscribe).toHaveBeenCalledOnce();
			expect(disposeSpy).toHaveBeenCalledOnce();
			expect(mockSession.unsubscribe.mock.invocationCallOrder[0])
				.toBeLessThan(disposeSpy.mock.invocationCallOrder[0]);
		});

		it("tracks the newly created session after factory call", async () => {
			const sm = createManager();
			const session = await sm.getOrCreateSession(
				makeRecord("xyz"),
				makeAgent(),
				[],
				defaultSetupContext,
			);
			expect(sm.getOpenSession("xyz")).toBe(session);
		});

		it("returns cached session on second call without calling factory again", async () => {
			const sm = createManager();
			const record = makeRecord("cached");
			const agent = makeAgent();

			const s1 = await sm.getOrCreateSession(record, agent, [], defaultSetupContext);
			const s2 = await sm.getOrCreateSession(record, agent, [], defaultSetupContext);
			expect(s2).toBe(s1);
			expect(mockAgentSessionFactory.create).toHaveBeenCalledTimes(1);
		});
	});

	// ---- Session disposal ----

	describe("disposeSession", () => {
		it("disposes the session and removes it from tracking", () => {
			const sm = createManager();
			const session = makeMockSession();
			sm.trackSession("to-dispose", session);

			sm.disposeSession("to-dispose");
			expect(session.dispose).toHaveBeenCalledOnce();
			expect(sm.hasOpenSession("to-dispose")).toBe(false);
		});

		it("is a no-op when the ID is not tracked", () => {
			const sm = createManager();
			expect(() => sm.disposeSession("nope")).not.toThrow();
		});
	});

	// ---- Async completion ----

	describe("waitForSessionEnd", () => {
		it("resolves immediately when the session is not tracked", async () => {
			const sm = createManager();
			await expect(sm.waitForSessionEnd("nope")).resolves.toBeUndefined();
		});

		it("resolves when agent_end event fires on tracked session", async () => {
			const sm = createManager();
			const session = makeMockSession();
			sm.trackSession("abc", session);

			// Fire agent_end after a tick
			setImmediate(() => {
				for (const cb of session.callbacks) {
					cb({ type: "agent_end" });
				}
			});

			await expect(sm.waitForSessionEnd("abc")).resolves.toBeUndefined();
		});

		it("unsubscribes after agent_end fires", async () => {
			const sm = createManager();
			const session = makeMockSession();
			sm.trackSession("abc", session);

			setImmediate(() => {
				for (const cb of session.callbacks) {
					cb({ type: "agent_end" });
				}
			});

			await sm.waitForSessionEnd("abc");

			// The unsubscribe returned by subscribe should have been called
			expect(session.unsubscribe).toHaveBeenCalled();
		});

		it("only resolves on agent_end, not other events", async () => {
			const sm = createManager();
			const session = makeMockSession();
			sm.trackSession("abc", session);

			let resolved = false;
			const promise = sm.waitForSessionEnd("abc").then(() => { resolved = true; });

			// Fire a non-agent_end event — should not resolve
			for (const cb of session.callbacks) {
				cb({ type: "token" });
			}

			await new Promise((r) => setTimeout(r, 10));
			expect(resolved).toBe(false);

			// Fire agent_end — should resolve
			for (const cb of session.callbacks) {
				cb({ type: "agent_end" });
			}

			await expect(promise).resolves.toBeUndefined();
		});

		it("resolves immediately when agent_end already fired (no race)", async () => {
			const sm = createManager();
			const record = makeRecord("race-test");

			// Create session through getOrCreateSession so the agent_end
			// subscription (which updates completedSessions) is set up.
			const session = await sm.getOrCreateSession(record, makeAgent(), [], defaultSetupContext);

			// Fire agent_end before calling waitForSessionEnd
			// The callbacks were stored by makeMockSession's subscribe impl
			for (const cb of (session as any).callbacks) {
				cb({ type: "agent_end" });
			}

			// Should resolve immediately — completedSessions tracks it
			await expect(sm.waitForSessionEnd(record.id)).resolves.toBeUndefined();
		});
	});

	describe("waitForAsyncResult", () => {
		it("resolves immediately when async result is already stored", async () => {
			const sm = createManager();
			sm.storeAsyncResult("ready", { output: "done", warnings: [] });

			await expect(sm.waitForAsyncResult("ready")).resolves.toBeUndefined();
		});

		it("waits until storeAsyncResult is called", async () => {
			const sm = createManager();
			let resolved = false;
			const promise = sm.waitForAsyncResult("pending").then(() => { resolved = true; });

			await new Promise((r) => setTimeout(r, 10));
			expect(resolved).toBe(false);

			sm.storeAsyncResult("pending", { output: "final", warnings: [] });

			await expect(promise).resolves.toBeUndefined();
			expect(resolved).toBe(true);
		});

		it("removes pending waiters when the wait is cancelled", async () => {
			const sm = createManager();
			const abortController = new AbortController();

			const promise = sm.waitForAsyncResult("pending", abortController.signal);
			expect((sm as any).asyncResultWaiters.get("pending")?.size).toBe(1);

			abortController.abort();

			await expect(promise).rejects.toThrow("wait_for_async_result_cancelled");
			expect((sm as any).asyncResultWaiters.has("pending")).toBe(false);
		});
	});

	describe("disposeAll", () => {
		it("disposes all tracked sessions and clears the map", () => {
			const sm = createManager();
			const s1 = makeMockSession();
			const s2 = makeMockSession();
			const s3 = makeMockSession();
			sm.trackSession("a", s1);
			sm.trackSession("b", s2);
			sm.trackSession("c", s3);

			sm.disposeAll();
			expect(s1.dispose).toHaveBeenCalledOnce();
			expect(s2.dispose).toHaveBeenCalledOnce();
			expect(s3.dispose).toHaveBeenCalledOnce();
			expect(sm.hasOpenSession("a")).toBe(false);
			expect(sm.hasOpenSession("b")).toBe(false);
			expect(sm.hasOpenSession("c")).toBe(false);
		});

		it("does not throw when the map is already empty", () => {
			const sm = createManager();
			expect(() => sm.disposeAll()).not.toThrow();
			expect(() => sm.disposeAll()).not.toThrow();
		});

		it("survives a session whose dispose throws", () => {
			const sm = createManager();
			const bad = makeMockSession();
			bad.dispose = vi.fn(() => {
				throw new Error("boom");
			}) as any;
			const good = makeMockSession();
			sm.trackSession("bad", bad);
			sm.trackSession("good", good);

			expect(() => sm.disposeAll()).not.toThrow();
			expect(good.dispose).toHaveBeenCalledOnce();
			expect(sm.hasOpenSession("bad")).toBe(false);
			expect(sm.hasOpenSession("good")).toBe(false);
		});
	});

	// ---- Run serialization ----

	describe("withRecordRunLock", () => {
		it("executes the function and returns its result", async () => {
			const sm = createManager();
			const result = await sm.withRecordRunLock("id1", async () => 42);
			expect(result).toBe(42);
		});

		it("propagates errors from the function", async () => {
			const sm = createManager();
			await expect(
				sm.withRecordRunLock("id1", async () => {
					throw new Error("function error");
				}),
			).rejects.toThrow("function error");
		});

		it("serializes concurrent calls for the same ID", async () => {
			const sm = createManager();
			const order: string[] = [];

			const p1 = sm.withRecordRunLock("serial", async () => {
				order.push("start-1");
				await new Promise((r) => setTimeout(r, 10));
				order.push("end-1");
				return "one";
			});
			const p2 = sm.withRecordRunLock("serial", async () => {
				order.push("start-2");
				await new Promise((r) => setTimeout(r, 10));
				order.push("end-2");
				return "two";
			});

			const [r1, r2] = await Promise.all([p1, p2]);
			expect(r1).toBe("one");
			expect(r2).toBe("two");
			expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
		});

		it("allows different IDs to run concurrently", async () => {
			const sm = createManager();
			const order: string[] = [];

			const p1 = sm.withRecordRunLock("id-a", async () => {
				order.push("start-a");
				await new Promise((r) => setTimeout(r, 15));
				order.push("end-a");
				return "a";
			});
			const p2 = sm.withRecordRunLock("id-b", async () => {
				order.push("start-b");
				await new Promise((r) => setTimeout(r, 10));
				order.push("end-b");
				return "b";
			});

			const [r1, r2] = await Promise.all([p1, p2]);
			expect(r1).toBe("a");
			expect(r2).toBe("b");
			expect(order[0]).toBe("start-a");
			expect(order[1]).toBe("start-b");
			expect(order[2]).toBe("end-b");
			expect(order[3]).toBe("end-a");
		});

		it("allows a new run for an ID after the previous lock completes", async () => {
			const sm = createManager();
			const r1 = await sm.withRecordRunLock("id1", async () => "first");
			const r2 = await sm.withRecordRunLock("id1", async () => "second");
			expect(r1).toBe("first");
			expect(r2).toBe("second");
		});

		it("clears the lock after the function completes", async () => {
			const sm = createManager();
			await sm.withRecordRunLock("id1", async () => "done");
			const r2 = await sm.withRecordRunLock("id1", async () => "again");
			expect(r2).toBe("again");
		});

		it("clears the lock after the function rejects", async () => {
			const sm = createManager();
			await expect(
				sm.withRecordRunLock("id1", async () => {
					throw new Error("fail");
				}),
			).rejects.toThrow("fail");
			const r2 = await sm.withRecordRunLock("id1", async () => "after-failure");
			expect(r2).toBe("after-failure");
		});

		it("handles a burst of concurrent requests for the same ID", async () => {
			const sm = createManager();
			const results: number[] = [];

			const tasks = Array.from({ length: 10 }, (_, i) =>
				sm.withRecordRunLock("burst", async () => {
					await new Promise((r) => setTimeout(r, 2));
					results.push(i);
					return i;
				}),
			);

			const values = await Promise.all(tasks);
			expect(values.sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
			expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		});
	});

	// ---- Async result ready callback ----

	describe("onAsyncResultReady callback", () => {
		it("emits debug breadcrumbs through session manager logger", async () => {
			const events: Array<{ event: string }> = [];
			const logger = makeSpyDebugLogger(events);
			const sm = createManager({ logger });
			const id = "log-kill";
			const session = makeMockSession();
			session.messages = [{ role: "assistant", content: [{ type: "text", text: "final output" }] }];
			session.prompt = vi.fn().mockResolvedValue(undefined) as any;
			sm.trackSession(id, session);
			sm.markAsyncRunning(id);

			sm.sendKillMessage(id, 5);
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(events.some((entry) => entry.event === "session_send_kill_started")).toBe(true);
			expect(events.some((entry) => entry.event === "session_send_kill_prompt_completed")).toBe(true);
			expect(events.some((entry) => entry.event === "session_finalize")).toBe(true);
			expect(sm.getAsyncResult(id)?.output).toBe("final output");
		});

		it("does not fire when agent_end occurs before async result storage", async () => {
			const sm = createManager();
			const onReady = vi.fn();
			sm.setOnAsyncResultReady(onReady);

			const record = makeRecord("async-cb");
			sm.markAsyncRunning(record.id);

			const session = await sm.getOrCreateSession(record, makeAgent(), [], defaultSetupContext);

			for (const cb of (session as any).callbacks) {
				cb({ type: "agent_end" });
			}

			expect(onReady).not.toHaveBeenCalled();
		});

		it("fires when storeAsyncResult is called", () => {
			const sm = createManager();
			const onReady = vi.fn();
			sm.setOnAsyncResultReady(onReady);

			sm.storeAsyncResult("async-cb", { output: "done", warnings: [] });

			expect(onReady).toHaveBeenCalledWith("async-cb");
		});

		it("does not fire for non-agent_end events", async () => {
			const sm = createManager();
			const onReady = vi.fn();
			sm.setOnAsyncResultReady(onReady);

			const record = makeRecord("non-end");
			sm.markAsyncRunning(record.id);

			const session = await sm.getOrCreateSession(record, makeAgent(), [], defaultSetupContext);

			for (const cb of (session as any).callbacks) {
				cb({ type: "token" });
			}

			expect(onReady).not.toHaveBeenCalled();
		});

		it("does not fire result-ready callback during the original finish-request abort", async () => {
			const sm = createManager();
			const onReady = vi.fn();
			sm.setOnAsyncResultReady(onReady);

			const record = makeRecord("soft-kill-cb");
			sm.markAsyncRunning(record.id);
			const callbacks: Array<(e: any) => void> = [];
			let rejectPrompt: ((err: any) => void) | null = null;
			const mockSession = {
				dispose: vi.fn(),
				subscribe: vi.fn((cb: any) => {
					callbacks.push(cb);
					return vi.fn();
				}),
				prompt: vi.fn(() => {
					return new Promise((_resolve, reject) => {
						rejectPrompt = reject;
					});
				}),
				abort: vi.fn(() => {
					if (rejectPrompt) {
						rejectPrompt(new Error("aborted"));
						rejectPrompt = null;
					}
				}),
				messages: [],
				getActiveToolNames: () => [],
				callbacks,
			} as any;
			(mockAgentSessionFactory as any).create = vi.fn().mockResolvedValue(mockSession);

			await sm.getOrCreateSession(record, makeAgent(), [], defaultSetupContext);
			sm.sendKillMessage(record.id, 5);
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(onReady).not.toHaveBeenCalled();
		});

		it("can clear the callback by setting undefined", () => {
			const sm = createManager();
			const onReady = vi.fn();
			sm.setOnAsyncResultReady(onReady);
			sm.setOnAsyncResultReady(undefined);

			sm.storeAsyncResult("cleared", { output: "done", warnings: [] });

			expect(onReady).not.toHaveBeenCalled();
		});

		it("does not overwrite or re-notify after a finish request rejects following forced abort", async () => {
			const sm = createManager();
			const onReady = vi.fn();
			sm.setOnAsyncResultReady(onReady);

			let rejectKillPrompt: ((error: Error) => void) | undefined;
			const session = makeMockSession();
			session.prompt = vi.fn(() => new Promise<void>((_resolve, reject) => {
				rejectKillPrompt = reject;
			})) as any;
			sm.trackSession("kill-late", session);

			sm.sendKillMessage("kill-late", 1);
			sm.abortSession("kill-late");

			expect(sm.getAsyncResult("kill-late")?.error).toBe("aborted");
			expect(onReady).toHaveBeenCalledTimes(1);

			rejectKillPrompt?.(new Error("late finish-request prompt failure"));
			await Promise.resolve();

			expect(sm.getAsyncResult("kill-late")?.error).toBe("aborted");
			expect(onReady).toHaveBeenCalledTimes(1);
		});

		it("finish request path does not abort before steering", async () => {
			const sm = createManager();
			const id = "finish-before-abort";
			const calls: string[] = [];
			const session = makeMockSession();
			session.abort = vi.fn(() => { calls.push("abort"); }) as any;
			(session as any).steer = vi.fn(() => {
				calls.push("steer");
				return Promise.resolve();
			});
			session.messages = [{ role: "assistant", content: [{ type: "text", text: "finished" }] }];
			sm.trackSession(id, session);
			sm.markAsyncRunning(id);

			sm.sendKillMessage(id, 1);
			await Promise.resolve();

			expect(calls).toEqual(["steer"]);
			expect(session.abort).not.toHaveBeenCalled();
			expect((session as any).steer).toHaveBeenCalledTimes(1);
		});

		it("uses steer when available for finish request", async () => {
			const sm = createManager();
			const id = "kill-steer";
			const session = makeMockSession();
			let steerResolve: (() => void) | undefined;
			session.steer = vi.fn(() => new Promise<void>((resolve) => {
				steerResolve = resolve;
			})) as any;
			session.messages = [{ role: "assistant", content: [{ type: "text", text: "finish-request steer result" }] }];
			sm.trackSession(id, session);
			sm.markAsyncRunning(id);

			sm.sendKillMessage(id, 1);
			steerResolve?.();
			await Promise.resolve();

			expect(session.steer).toHaveBeenCalledTimes(1);
			expect((session.prompt as any)).not.toHaveBeenCalled();
			expect(sm.isCompleted(id)).toBe(true);
			expect(sm.getAsyncResult(id)?.terminalOutcome).toBe("completed");
			expect(sm.getAsyncResult(id)?.terminalError).toBeUndefined();
			expect(sm.isKillInProgress(id)).toBe(false);
		});

		it("finish request failure does not prevent storing the original run output", async () => {
			const sm = createManager();
			const id = "finish-failed-original";
			const session = makeMockSession();
			(session as any).steer = vi.fn().mockRejectedValue(new Error("still processing"));
			session.messages = [{ role: "assistant", content: [{ type: "text", text: "original final" }] }];
			sm.trackSession(id, session);
			sm.markAsyncRunning(id);

			sm.sendKillMessage(id, 1);
			await Promise.resolve();

			expect(sm.getAsyncResult(id)?.terminalOutcome).toBe("abort_request_failed");
			expect(sm.isCompleted(id)).toBe(false);

			sm.finalizeAsyncRun(id, { output: "original final", warnings: [], terminalOutcome: "completed" });

			expect(sm.getAsyncResult(id)?.output).toBe("original final");
			expect(sm.getAsyncResult(id)?.terminalOutcome).toBe("completed");
			expect(sm.isCompleted(id)).toBe(true);
		});

		it("falls back to streamingBehavior steer when steer helper is unavailable", async () => {
			const sm = createManager();
			const id = "kill-fallback";
			const session = makeMockSession();
			let resolveKillPrompt: (() => void) | undefined;
			let promptArgs: any[] | undefined;
			session.prompt = vi.fn((_message: string, opts?: unknown) => {
				promptArgs = [(_message as string), opts as any];
				return new Promise<void>((resolve) => {
					resolveKillPrompt = resolve;
				});
			}) as any;
			sm.trackSession(id, session);
			sm.markAsyncRunning(id);

			sm.sendKillMessage(id, 1);
			resolveKillPrompt?.();
			await Promise.resolve();

			expect(session.steer).toBeUndefined();
			expect(session.prompt).toHaveBeenCalledTimes(1);
			expect(promptArgs?.[1]).toMatchObject({ streamingBehavior: "steer" });
			expect(sm.isCompleted(id)).toBe(true);
			expect(sm.getAsyncResult(id)?.terminalOutcome).toBe("completed");
		});

		it("transitions running finish request to completed", async () => {
			const sm = createManager();
			const onReady = vi.fn();
			sm.setOnAsyncResultReady(onReady);

			const id = "soft-complete";
			let resolveKillPrompt: (() => void) | undefined;
			const session = makeMockSession();
			session.prompt = vi.fn(() => new Promise<void>((resolve) => {
				resolveKillPrompt = resolve;
			})) as any;
			session.messages = [{ role: "assistant", content: [{ type: "text", text: "finish-request final output" }] }];
			sm.trackSession(id, session);
			sm.markAsyncRunning(id);

			sm.sendKillMessage(id, 1);
			expect(sm.isKillInProgress(id)).toBe(true);
			expect(sm.isAsyncRunning(id)).toBe(false);

			resolveKillPrompt?.();
			await Promise.resolve();

			expect(sm.isKillInProgress(id)).toBe(false);
			expect(sm.isCompleted(id)).toBe(true);
			expect(sm.hasOpenSession(id)).toBe(false);
			expect(sm.getAsyncResult(id)?.output).toBe("finish-request final output");
			expect(onReady).toHaveBeenCalledWith(id);
		});

		it("transitions running finish request to forced abort", async () => {
			const sm = createManager();
			const onReady = vi.fn();
			sm.setOnAsyncResultReady(onReady);

			const id = "soft-hard-abort";
			let rejectKillPrompt: ((error: Error) => void) | undefined;
			const session = makeMockSession();
			session.messages = [{ role: "assistant", content: [{ type: "text", text: "partial output" }] }];
			session.prompt = vi.fn(() => new Promise<void>((_resolve, reject) => {
				rejectKillPrompt = reject;
			})) as any;
			sm.trackSession(id, session);
			sm.markAsyncRunning(id);

			sm.sendKillMessage(id, 1);
			expect(sm.isKillInProgress(id)).toBe(true);
			sm.abortSession(id);

			expect(sm.getAsyncResult(id)?.error).toBe("aborted");
			expect(sm.isKillInProgress(id)).toBe(false);
			expect(sm.isCompleted(id)).toBe(true);
			expect(sm.hasOpenSession(id)).toBe(false);

			rejectKillPrompt?.(new Error("late finish-request prompt failure"));
			await Promise.resolve();

			expect(sm.getAsyncResult(id)?.error).toBe("aborted");
			expect(onReady).toHaveBeenCalledTimes(1);
		});

		it("final abort summary cancels in-flight work, disables tools, and records an aborted summary", async () => {
			const sm = createManager();
			const id = "abort-summary";
			const calls: string[] = [];
			const session = makeMockSession(["bash", "read"]);
			session.abort = vi.fn(() => {
				calls.push("abort");
				setTimeout(() => {
					for (const cb of session.callbacks) cb({ type: "agent_end" });
				}, 0);
				return Promise.resolve();
			}) as any;
			(session as any).abortBash = vi.fn(() => { calls.push("abortBash"); });
			const setActiveToolsByName = vi.fn(() => { calls.push("setTools"); });
			(session as any).setActiveToolsByName = setActiveToolsByName;
			session.prompt = vi.fn(() => {
				calls.push("prompt");
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "final abort summary" }] }];
				setTimeout(() => {
					for (const cb of session.callbacks) cb({ type: "agent_end" });
				}, 0);
				return Promise.resolve();
			}) as any;
			sm.trackSession(id, session);
			sm.markAsyncRunning(id);

			const result = await sm.requestAbortSummary(id, 1000);

			expect(calls).toEqual(["abortBash", "abort", "setTools", "prompt"]);
			expect(setActiveToolsByName).toHaveBeenCalledWith([]);
			expect(session.prompt).toHaveBeenCalledWith(ABORT_FINAL_SUMMARY_MESSAGE, { streamingBehavior: "steer" });
			expect(result).toMatchObject({ status: "summarized", output: "final abort summary", toolOverrideApplied: true });
			expect(sm.getAsyncResult(id)).toMatchObject({
				output: "final abort summary",
				error: "aborted",
				abortReason: "final_summary",
				terminalOutcome: "aborted",
			});
		});

		it("final abort summary can replace an abort-request-failed diagnostic", async () => {
			const sm = createManager();
			const id = "abort-summary-after-failed-request";
			const session = makeMockSession(["bash"]);
			session.abort = vi.fn(() => {
				setTimeout(() => {
					for (const cb of session.callbacks) cb({ type: "agent_end" });
				}, 0);
				return Promise.resolve();
			}) as any;
			(session as any).setActiveToolsByName = vi.fn();
			session.prompt = vi.fn(() => {
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "summary after failed finish request" }] }];
				setTimeout(() => {
					for (const cb of session.callbacks) cb({ type: "agent_end" });
				}, 0);
				return Promise.resolve();
			}) as any;
			sm.trackSession(id, session);
			sm.markAsyncRunning(id);
			sm.storeAsyncResult(id, {
				output: "",
				error: "still processing",
				warnings: [],
				terminalOutcome: "abort_request_failed",
			});

			const result = await sm.requestAbortSummary(id, 1000);

			expect(result.status).toBe("summarized");
			expect(sm.getAsyncResult(id)).toMatchObject({
				output: "summary after failed finish request",
				error: "aborted",
				terminalOutcome: "aborted",
			});
		});

		it("final abort summary waits for cancel idle and includes just-finished tool output before prompting", async () => {
			vi.useFakeTimers();
			try {
				const sm = createManager();
				const id = "abort-summary-tool-output";
				const session = makeMockSession(["bash"]);
				(session as any).setActiveToolsByName = vi.fn();
				session.abort = vi.fn(() => {
					setTimeout(() => {
						session.messages.push({
							role: "toolResult",
							toolName: "bash",
							content: [{ type: "text", text: "tests passed before abort" }],
						});
						for (const cb of session.callbacks) cb({ type: "agent_end" });
					}, 100);
				}) as any;
				session.prompt = vi.fn(() => {
					expect(session.messages).toContainEqual(expect.objectContaining({
						role: "toolResult",
						content: [{ type: "text", text: "tests passed before abort" }],
					}));
					session.messages.push({ role: "assistant", content: [{ type: "text", text: "summary includes tests passed" }] });
					return Promise.resolve();
				}) as any;
				sm.trackSession(id, session);
				sm.markAsyncRunning(id);

				const promise = sm.requestAbortSummary(id, 1000);
				await vi.advanceTimersByTimeAsync(100);
				await Promise.resolve();
				expect(session.prompt).toHaveBeenCalledTimes(1);
				for (const cb of [...session.callbacks]) cb({ type: "agent_end" });

				await expect(promise).resolves.toMatchObject({ status: "summarized", output: "summary includes tests passed" });
			} finally {
				vi.useRealTimers();
			}
		});

		it("final abort summary does not reuse stale assistant output when summary turn produces no answer", async () => {
			vi.useFakeTimers();
			try {
				const sm = createManager();
				const id = "abort-summary-stale";
				const session = makeMockSession(["bash"]);
				(session as any).setActiveToolsByName = vi.fn();
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "old assistant text" }] }];
				session.prompt = vi.fn().mockResolvedValue(undefined) as any;
				sm.trackSession(id, session);
				sm.markAsyncRunning(id);

				const promise = sm.requestAbortSummary(id, 1000);
				await vi.advanceTimersByTimeAsync(ABORT_FINAL_SUMMARY_CANCEL_GRACE_MS);
				for (const cb of [...session.callbacks]) cb({ type: "agent_end" });

				await expect(promise).resolves.toMatchObject({ status: "no_output", toolOverrideApplied: true });
				expect(sm.getAsyncResult(id)).toBeUndefined();
			} finally {
				vi.useRealTimers();
			}
		});

		it("final abort summary retries already-processing prompt acceptance during cancel grace", async () => {
			vi.useFakeTimers();
			try {
				const sm = createManager();
				const id = "abort-summary-retry";
				const session = makeMockSession(["bash"]);
				(session as any).setActiveToolsByName = vi.fn();
				session.abort = vi.fn().mockResolvedValue(undefined) as any;
				let attempts = 0;
				session.prompt = vi.fn(() => {
					attempts += 1;
					if (attempts < 3) {
						return Promise.reject(new Error("Agent is already processing."));
					}
					session.messages = [{ role: "assistant", content: [{ type: "text", text: "retry summary" }] }];
					setTimeout(() => {
						for (const cb of session.callbacks) cb({ type: "agent_end" });
					}, 0);
					return Promise.resolve();
				}) as any;
				sm.trackSession(id, session);
				sm.markAsyncRunning(id);

				const promise = sm.requestAbortSummary(id, 1000);
				await vi.advanceTimersByTimeAsync(ABORT_FINAL_SUMMARY_CANCEL_GRACE_MS);
				await vi.advanceTimersByTimeAsync(ABORT_FINAL_SUMMARY_CANCEL_GRACE_MS / 10);
				await vi.advanceTimersByTimeAsync(ABORT_FINAL_SUMMARY_CANCEL_GRACE_MS / 10);
				await vi.advanceTimersByTimeAsync(0);

				await expect(promise).resolves.toMatchObject({ status: "summarized", output: "retry summary" });
				expect(session.prompt).toHaveBeenCalledTimes(3);
				expect((session as any).setActiveToolsByName).toHaveBeenCalledTimes(3);
			} finally {
				vi.useRealTimers();
			}
		});

		it("final abort summary is bounded and leaves forced abort fallback to caller", async () => {
			vi.useFakeTimers();
			try {
				const sm = createManager();
				const id = "abort-summary-timeout";
				const session = makeMockSession(["bash"]);
				(session as any).setActiveToolsByName = vi.fn();
				session.prompt = vi.fn(() => new Promise(() => {})) as any;
				sm.trackSession(id, session);
				sm.markAsyncRunning(id);

				const promise = sm.requestAbortSummary(id);
				await vi.advanceTimersByTimeAsync(ABORT_FINAL_SUMMARY_CANCEL_GRACE_MS + ABORT_FINAL_SUMMARY_TIMEOUT_MS);

				await expect(promise).resolves.toMatchObject({ status: "timed_out", toolOverrideApplied: true });
				expect(sm.getAsyncResult(id)).toBeUndefined();
				expect(session.abort).toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it("transitions running to forced abort", () => {
			const sm = createManager();
			const id = "hard-abort";
			const session = makeMockSession();
			session.messages = [{ role: "assistant", content: [{ type: "text", text: "pre-abort output" }] }];
			sm.trackSession(id, session);
			sm.markAsyncRunning(id);

			sm.abortSession(id);

			expect(sm.getAsyncResult(id)?.error).toBe("aborted");
			expect(sm.getAsyncResult(id)?.output).toBe("pre-abort output");
			expect(sm.isKillInProgress(id)).toBe(false);
			expect(sm.isCompleted(id)).toBe(true);
			expect(sm.hasOpenSession(id)).toBe(false);
		});

		it("forced abort with an empty transcript does not expose killed as output or terminal error", () => {
			const sm = createManager();
			const id = "hard-abort-empty";
			const session = makeMockSession();
			session.messages = [];
			sm.trackSession(id, session);
			sm.markAsyncRunning(id);

			sm.abortSession(id);

			const stored = sm.getAsyncResult(id);
			expect(stored?.output).toBe("");
			expect(stored?.error).toBe("aborted");
			expect(stored?.terminalError).toBeUndefined();
			expect(JSON.stringify(stored)).not.toContain("killed");
		});
	});
});

describe("PiAgentSessionFactory", () => {
	it("binds sub-agent extensions so session_start registered tools are available", async () => {
		const tempDir = join(tmpdir(), `pi-agent-factory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const params = Type.Object({});
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: tempDir,
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "load_time_tool",
						label: "Load Time Tool",
						description: "Registered while the extension loads",
						parameters: params,
						async execute() {
							return { content: [{ type: "text", text: "load" }] };
						},
					});
					pi.on("session_start", () => {
						pi.registerTool({
							name: "session_start_tool",
							label: "Session Start Tool",
							description: "Registered from session_start",
							parameters: params,
							async execute() {
								return { content: [{ type: "text", text: "session" }] };
							},
						});
					});
				},
			],
		});
		await loader.reload();

		const session = await new PiAgentSessionFactory().create({
			cwd: tempDir,
			model: undefined,
			tools: undefined,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(tempDir),
			thinkingLevel: undefined,
		});

		try {
			const allToolNames = session.getAllTools().map((tool) => tool.name);
			const activeToolNames = session.getActiveToolNames();
			expect(allToolNames).toContain("load_time_tool");
			expect(allToolNames).toContain("session_start_tool");
			expect(activeToolNames).toContain("session_start_tool");
		} finally {
			session.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
