/**
 * Unit tests for the isolated debug logger module.
 */

import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRunCorrelationId,
	makeDebugLogger,
	makeNoopDebugLogger,
	makeSessionDebugLogger,
	makeSessionDebugLogPath,
} from "../subagent/debug-logger.js";

describe("debug logger", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-debug-logger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
	});

	it("can be explicitly disabled", () => {
		const logger = makeSessionDebugLogger({
			getSessionDir: () => tempDir,
			getSessionId: () => "session-disabled",
		}, { enabled: false });

		expect(logger.isEnabled).toBe(false);
		logger.info("task_run_start", { message: "should not persist" });

		const path = makeSessionDebugLogPath(tempDir, "session-disabled");
		expect(existsSync(path)).toBe(false);
	});

	it("writes redacted and truncated JSONL payloads with shared sequence", () => {
		const logPath = join(tempDir, "run.debug.jsonl");
		const logger = makeDebugLogger({
			enabled: true,
			logPath,
			maxValueLength: 12,
			maxArrayLength: 2,
			maxDepth: 4,
		});

		logger.info("parent_event", {
			request: {
				token: "should-be-redacted",
				filePath: "/private/project/secret.md",
				sessionFile: "/private/session.jsonl",
				prompt: "full user prompt",
				output: "full model output",
				toolSchemas: [{ name: "bash", parameters: { token: "nested" } }],
				promptLength: 16,
				outputLength: 17,
				nested: {
					api_key: "redacted-key",
					text: "this-is-a-very-long-text",
					numbers: [1, 2, 3, 4],
				},
			},
		});
		logger.child({ component: "child", recordId: "abc12345" }).warn("child_event", {
			plain: "visible",
		});

		const rows = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
		expect(rows).toHaveLength(2);

		const first = JSON.parse(rows[0]) as Record<string, unknown>;
		const second = JSON.parse(rows[1]) as Record<string, unknown>;

		expect(first.seq).toBe(1);
		expect(first.event).toBe("parent_event");
		expect((first.request as any).token).toBe("[redacted]");
		expect((first.request as any).filePath).toBe("[redacted]");
		expect((first.request as any).sessionFile).toBe("[redacted]");
		expect((first.request as any).prompt).toBe("[redacted]");
		expect((first.request as any).output).toBe("[redacted]");
		expect((first.request as any).toolSchemas).toBe("[redacted]");
		expect((first.request as any).promptLength).toBe(16);
		expect((first.request as any).outputLength).toBe(17);
		expect((first.request as any).nested.api_key).toBe("[redacted]");
		expect(Array.isArray((first.request as any).nested.numbers)).toBe(true);
		expect((first.request as any).nested.numbers.length).toBe(3);
		expect((first.request as any).nested.numbers[2]).toEqual({ _omitted: 2 });
		expect((first.request as any).nested.text).not.toBe("this-is-a-very-long-text");
		expect((first.request as any).nested.text).toContain("…");

		expect(second.seq).toBe(2);
		expect(second.event).toBe("child_event");
		expect(second.recordId).toBe("abc12345");
		expect(second.component).toBe("child");
	});

	it("returns noop logger that never throws", () => {
		const noop = makeNoopDebugLogger();
		expect(noop.isEnabled).toBe(false);
		// Should be safe to call with any payload.
		noop.debug("x", { token: "x", authorization: "y" });
		noop.info("x");
		noop.warn("x");
		noop.error("x", { answer: 42 });
		noop.child({ runId: createRunCorrelationId() }).info("y");
		expect(noop.child({ runId: createRunCorrelationId() }).isEnabled).toBe(false);
	});
});
