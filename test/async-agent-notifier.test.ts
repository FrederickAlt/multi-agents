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
import { AsyncAgentNotifier } from "../src/subagent/async-agent-notifier.js";

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

		it("does not track user-aborted agents for notifications or reminders", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("aborted-agent", "aborted");

			expect(n.getUnconsumed()).toEqual([]);
			expect(n.takeDueNotification()).toBeNull();
		});

		it("notifies again when a consumed agent ID completes a later async run", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("agent-x");
			n.consume(["agent-x"]);
			expect(n.takeNotificationForTurnBoundary()).toBeNull();

			n.markCompleted("agent-x");
			expect(n.takeNotificationForTurnBoundary()).toContain("agent-x");
			expect(n.getUnconsumed()).toEqual(["agent-x"]);
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

		it("consume before completion does not suppress a later async run with the same ID", () => {
			const n = new AsyncAgentNotifier();
			n.consume(["late-completion"]);
			n.markCompleted("late-completion");
			expect(n.getUnconsumed()).toEqual(["late-completion"]);
			expect(n.takeDueNotification()).toContain("late-completion");
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

	describe("turn-boundary reminder policy", () => {
		it("emits the first completion notification at the next boundary", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("abc123");

			const msg = n.takeNotificationForTurnBoundary();
			expect(msg).toContain("abc123");
			expect(msg).not.toContain("Reminder");
		});

		it("aliases due-notification API", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("abc123");

			expect(n.takeDueNotification()).toContain("abc123");
			expect(n.takeDueNotification()).toBeNull();
		});

		it("does not advance reminders on same turn when a completion is consumed mid-turn", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("a");
			n.markCompleted("b");

			const initial = n.takeDueNotification("input");
			expect(initial).toContain("a");
			expect(initial).toContain("b");

			n.consume(["b"]);
			expect(n.takeDueNotification("turn_end")).toBeNull();

			for (let i = 0; i < 4; i++) {
				expect(n.takeDueNotification("input")).toBeNull();
				expect(n.takeDueNotification("turn_end")).toBeNull();
			}

			const reminder = n.takeDueNotification("input");
			expect(reminder).toContain("Reminder");
			expect(reminder).toContain("a");
			expect(reminder).not.toContain("`b`");
		});

		it("advances reminder cadence once per input+turn_end opportunity", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("agent-a");

			expect(n.takeDueNotification("input")).toContain("agent-a");

			for (let i = 0; i < 4; i++) {
				expect(n.takeDueNotification("input")).toBeNull();
				expect(n.takeDueNotification("turn_end")).toBeNull();
			}

			const reminder = n.takeDueNotification("input");
			expect(reminder).toContain("Reminder");
			expect(reminder).toContain("agent-a");
			expect(n.takeDueNotification("turn_end")).toBeNull();
		});

		it("reminds after five turns with no new completion", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("abc123");
			expect(n.takeNotificationForTurnBoundary()).toContain("abc123");

			for (let i = 0; i < 4; i++) {
				expect(n.takeNotificationForTurnBoundary()).toBeNull();
			}

			const reminder = n.takeNotificationForTurnBoundary();
			expect(reminder).toContain("Reminder");
			expect(reminder).toContain("abc123");
		});

		it("does not spam duplicate reminders before the threshold", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("abc123");
			expect(n.takeNotificationForTurnBoundary()).not.toBeNull();

			for (let i = 0; i < 4; i++) {
				expect(n.takeNotificationForTurnBoundary()).toBeNull();
			}
		});

		it("resets the reminder counter when a new completion arrives", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("first");
			expect(n.takeNotificationForTurnBoundary()).toContain("first");

			for (let i = 0; i < 4; i++) {
				expect(n.takeNotificationForTurnBoundary()).toBeNull();
			}

			n.markCompleted("second");
			const fresh = n.takeNotificationForTurnBoundary();
			expect(fresh).toContain("first");
			expect(fresh).toContain("second");
			expect(fresh).not.toContain("Reminder");

			for (let i = 0; i < 4; i++) {
				expect(n.takeNotificationForTurnBoundary()).toBeNull();
			}
			expect(n.takeNotificationForTurnBoundary()).toContain("Reminder");
		});

		it("removes consumed agents from future reminders", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("keep");
			n.markCompleted("done");
			expect(n.takeNotificationForTurnBoundary()).toContain("done");
			n.consume(["done"]);

			for (let i = 0; i < 4; i++) {
				expect(n.takeNotificationForTurnBoundary()).toBeNull();
			}

			const reminder = n.takeNotificationForTurnBoundary();
			expect(reminder).toContain("keep");
			expect(reminder).not.toContain("done");
		});

		it("is a no-op at turn boundaries when empty", () => {
			const n = new AsyncAgentNotifier();
			expect(n.takeNotificationForTurnBoundary()).toBeNull();
			expect(n.takeNotificationForTurnBoundary()).toBeNull();
		});

		it("includes multiple unconsumed agents in reminder content", () => {
			const n = new AsyncAgentNotifier();
			n.markCompleted("aaa");
			n.markCompleted("bbb");
			expect(n.takeNotificationForTurnBoundary()).not.toBeNull();

			for (let i = 0; i < 4; i++) {
				expect(n.takeNotificationForTurnBoundary()).toBeNull();
			}

			const reminder = n.takeNotificationForTurnBoundary();
			expect(reminder).toContain("Reminder");
			expect(reminder).toContain("aaa");
			expect(reminder).toContain("bbb");
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
