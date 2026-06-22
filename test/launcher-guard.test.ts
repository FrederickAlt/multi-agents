import { describe, expect, it } from "vitest";
import taskExtension from "../src/subagent/index.js";
import { MULTI_AGENTS_LAUNCHER_ENV, MULTI_AGENTS_LAUNCHER_ERROR } from "../src/subagent/launcher-contract.js";

describe("multi-agents launcher activation contract", () => {
	it("fails loudly when extension is not started by launcher", () => {
		const original = process.env[MULTI_AGENTS_LAUNCHER_ENV];
		delete process.env[MULTI_AGENTS_LAUNCHER_ENV];
		try {
			expect(() => taskExtension({} as any)).toThrowError(MULTI_AGENTS_LAUNCHER_ERROR);
		} finally {
			if (original === undefined) {
				delete process.env[MULTI_AGENTS_LAUNCHER_ENV];
			} else {
				process.env[MULTI_AGENTS_LAUNCHER_ENV] = original;
			}
		}
	});
});
