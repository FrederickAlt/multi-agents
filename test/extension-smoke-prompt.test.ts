import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROMPT_PATH = join(PROJECT_ROOT, "docs", "prompts", "extension-full-smoke-test.md");

describe("extension smoke prompt", () => {
	it("covers the extension surface in one reusable prompt", () => {
		const content = readFileSync(PROMPT_PATH, "utf-8");

		for (const phrase of [
			"Task",
			"blocking: false",
			"resume",
			"wait_for_agent",
			"timed_out_still_running",
			"killed",
			"/agent",
			"/dump-prompt",
			"defaultRootAgent",
			"prompt parts",
			"kill_on_timeout",
			"RUN_REAL_LLM_TESTS=1",
		]) {
			expect(content).toContain(phrase);
		}
	});
});
