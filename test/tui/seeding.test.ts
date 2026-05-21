import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

const tempRoot = fs.mkdtempSync(path.join(tmpdir(), "pi-seed-test-"));

// Set env var before any module that uses getAgentDir() is loaded
process.env.PI_CODING_AGENT_DIR = tempRoot;

beforeEach(() => {
	// Clean temp dir except test files
	for (const entry of fs.readdirSync(tempRoot, { withFileTypes: true })) {
		const p = path.join(tempRoot, entry.name);
		fs.rmSync(p, { recursive: true, force: true });
	}
});

afterAll(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("seedConfig", () => {
	it("does not overwrite existing directories", async () => {
		// Dynamic import to ensure PI_CODING_AGENT_DIR is set before module init
		const { seedConfig } = await import("../../src/tui/discovery/seeding.js");

		const agentsDir = path.join(tempRoot, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "existing.md"), "existing");

		const partsDir = path.join(tempRoot, "prompt-parts");
		fs.mkdirSync(partsDir, { recursive: true });

		const result = seedConfig();
		expect(result.agents).toBe(0);
		expect(result.promptParts).toBe(0);

		// Original file should remain
		expect(fs.readFileSync(path.join(agentsDir, "existing.md"), "utf-8")).toBe("existing");
	});
});
