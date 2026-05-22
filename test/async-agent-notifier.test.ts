/**
 * Unit tests for AsyncAgentNotifier — notification state machine.
 *
 * Tests the notifier in isolation with no Pi runtime dependency:
 * - empty state produces no notification
 * - single completion produces notification
 * - multiple completions produce one batched notification
 * - consumption removes agents from the set
 * - idempotent markCompleted
 * - unknown IDs in consume are no-ops
 */
import { describe, expect, it } from "vitest";
import { AsyncAgentNotifier } from "../subagent/async-agent-notifier.js";

describe("AsyncAgentNotifier", () => {
	describe("empty state", () => {
		it("has no unconsumed agents initially", () => {
			const n = new AsyncAgentNotifier();
			expect(n.hasUnconsumed()).toBe(false);
			expect(n.getUnconsumed()).toEqual([]);
		});

		it("buildNotification returns null when empty", () => {
			const n = new AsyncAgentNotifier();
			expect(n.buildNotification()).toBeNull();
		});
	});

	describe("single completion", () => {
		it("marks an agent as completed-but-unconsumed", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("abc123");
			expect(n.hasUnconsumed()).toBe(true);
			expect(n.getUnconsumed()).toEqual(["abc123"]);
		});

		it("builds notification with the single agent ID", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("abc123");
			const msg = n.buildNotification();
			expect(msg).toBeTruthy();
			expect(msg!).toContain("[System]");
			expect(msg!).toContain("abc123");
			expect(msg!).toContain("wait_for_agent");
		});

		it("markCompleted is idempotent", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("abc123");
			n.markCompleted("abc123");
			expect(n.getUnconsumed()).toEqual(["abc123"]);
		});
	});

	describe("multiple completions", () => {
		it("batches multiple agents in one notification", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("agentA");
			n.markCompleted("agentB");
			n.markCompleted("agentC");
			expect(n.getUnconsumed()).toEqual(["agentA", "agentB", "agentC"]);
		});

		it("builds a single consolidated notification", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("aaa");
			n.markCompleted("bbb");
			const msg = n.buildNotification();
			expect(msg).toBeTruthy();
			expect(msg!).toContain("aaa");
			expect(msg!).toContain("bbb");
			// Should be one [System] header, not multiple
			const systemCount = (msg!.match(/\[System\]/g) || []).length;
			expect(systemCount).toBe(1);
		});
	});

	describe("consumption", () => {
		it("removes consumed agents from the set", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("a");
			n.markCompleted("b");
			n.consume(["a"]);
			expect(n.getUnconsumed()).toEqual(["b"]);
			expect(n.hasUnconsumed()).toBe(true);
		});

		it("clears notification when all are consumed", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("a");
			n.markCompleted("b");
			n.consume(["a", "b"]);
			expect(n.hasUnconsumed()).toBe(false);
			expect(n.buildNotification()).toBeNull();
		});

		it("consume with unknown IDs is a no-op", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("a");
			n.consume(["unknown", "also-unknown"]);
			expect(n.getUnconsumed()).toEqual(["a"]);
		});

		it("partial consumption leaves remaining unconsumed", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("x");
			n.markCompleted("y");
			n.markCompleted("z");
			n.consume(["y"]);
			expect(n.getUnconsumed()).toEqual(["x", "z"]);
		});
	});

	describe("notification message content", () => {
		it("includes all unconsumed IDs in the message", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("id1");
			n.markCompleted("id2");
			const msg = n.buildNotification()!;
			expect(msg).toContain("id1");
			expect(msg).toContain("id2");
		});

		it("instructs to call wait_for_agent with listed IDs", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("abc");
			const msg = n.buildNotification()!;
			expect(msg).toContain("wait_for_agent");
			expect(msg).toContain('"abc"');
		});

		it("does not include consumed agents in the notification", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("keep");
			n.markCompleted("remove");
			n.consume(["remove"]);
			const msg = n.buildNotification()!;
			expect(msg).toContain("keep");
			expect(msg).not.toContain("remove");
		});
	});
});
