/**
 * Unit tests for configuration seeding (seeding.ts).
 *
 * Seeds bundled Agent definitions and Prompt parts into ~/.pi/agent/
 * when the target directories don't exist. Uses PI_CODING_AGENT_DIR to
 * redirect the user config dir to a temp directory for isolation.
 */
import * as fs from "node:fs";
const { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } = fs;
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedAgentConfig } from "../subagent/seeding.js";

// ---------------------------------------------------------------------------
// seedAgentConfig — I/O-dependent tests with temp directories
// ---------------------------------------------------------------------------

describe("seedAgentConfig", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(
			tmpdir(),
			`pi-seeding-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		process.env.PI_CODING_AGENT_DIR = tempDir;
	});

	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		if (tempDir) {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});

	/**
	 * Get the list of .md filenames in a directory, excluding hidden files
	 * (those starting with ".").
	 */
	const mdFiles = (dir: string): string[] => {
		if (!existsSync(dir)) return [];
		return readdirSync(dir).filter(
			(f) => f.endsWith(".md") && !f.startsWith("."),
		);
	};

	/**
	 * Read a file's raw content, or return null if not found.
	 */
	const readFileContent = (filePath: string): string | null => {
		try {
			return fs.readFileSync(filePath, "utf-8");
		} catch {
			return null;
		}
	};

	it("creates agents/ and prompt-parts/ directories with bundled files", () => {
		// Before seeding, nothing exists.
		expect(existsSync(join(tempDir, "agents"))).toBe(false);
		expect(existsSync(join(tempDir, "prompt-parts"))).toBe(false);

		seedAgentConfig();

		// Directories should now exist.
		expect(existsSync(join(tempDir, "agents"))).toBe(true);
		expect(existsSync(join(tempDir, "prompt-parts"))).toBe(true);

		// Both directories should contain .md files.
		const agentFiles = mdFiles(join(tempDir, "agents"));
		const partFiles = mdFiles(join(tempDir, "prompt-parts"));

		expect(agentFiles.length).toBeGreaterThan(0);
		expect(partFiles.length).toBeGreaterThan(0);
	});

	it("copies agent .md files with their frontmatter content intact", () => {
		seedAgentConfig();

		const coderPath = join(tempDir, "agents", "coder.md");
		const content = readFileContent(coderPath);
		expect(content).not.toBeNull();
		expect(content).toContain("---");
		expect(content).toContain("description:");
	});

	it("copies prompt-part .md files with content intact", () => {
		seedAgentConfig();

		const toolsPath = join(tempDir, "prompt-parts", "010-tools.md");
		const content = readFileContent(toolsPath);
		expect(content).not.toBeNull();
		expect(content).toContain("Available Tools");
	});

	it("skips hidden files (starting with '.')", () => {
		seedAgentConfig();

		const agentFiles = readdirSync(join(tempDir, "agents"));
		const hiddenFiles = agentFiles.filter((f) => f.startsWith("."));
		expect(hiddenFiles).toHaveLength(0);
	});

	it("is idempotent — second call does not overwrite or duplicate", () => {
		seedAgentConfig();

		// Record initial state: file names and modification times.
		const agentsDir = join(tempDir, "agents");
		const partsDir = join(tempDir, "prompt-parts");
		const initialAgentMtimes = Object.fromEntries(
			readdirSync(agentsDir).map((f) => [
				f,
				fs.statSync(join(agentsDir, f)).mtimeMs,
			]),
		);
		const initialPartMtimes = Object.fromEntries(
			readdirSync(partsDir).map((f) => [
				f,
				fs.statSync(join(partsDir, f)).mtimeMs,
			]),
		);
		const initialAgentFiles = readdirSync(agentsDir).sort();
		const initialPartFiles = readdirSync(partsDir).sort();

		// Second call should be a no-op because directories already exist.
		seedAgentConfig();

		// File count should be the same.
		expect(readdirSync(agentsDir).sort()).toEqual(initialAgentFiles);
		expect(readdirSync(partsDir).sort()).toEqual(initialPartFiles);

		// Modification times should be unchanged (no overwrite).
		for (const [name, mtime] of Object.entries(initialAgentMtimes)) {
			expect(fs.statSync(join(agentsDir, name)).mtimeMs).toBe(mtime);
		}
		for (const [name, mtime] of Object.entries(initialPartMtimes)) {
			expect(fs.statSync(join(partsDir, name)).mtimeMs).toBe(mtime);
		}
	});

	it("seeds only the missing directory when one already exists", () => {
		// Pre-create the agents/ directory (simulating partial config).
		mkdirSync(join(tempDir, "agents"), { recursive: true });

		seedAgentConfig();

		// prompt-parts/ should now exist.
		const partsDir = join(tempDir, "prompt-parts");
		expect(existsSync(partsDir)).toBe(true);
		expect(mdFiles(partsDir).length).toBeGreaterThan(0);

		// agents/ should still be empty (pre-existing, no backfill).
		const agentFiles = mdFiles(join(tempDir, "agents"));
		expect(agentFiles).toHaveLength(0);
	});

	it("creates parent ~/.pi/agent/ directory if it doesn't exist", () => {
		// tempDir was set to PI_CODING_AGENT_DIR but the directory
		// itself hasn't been created yet. Seeding must create it.
		seedAgentConfig();

		expect(existsSync(tempDir)).toBe(true);
		expect(existsSync(join(tempDir, "agents"))).toBe(true);
		expect(existsSync(join(tempDir, "prompt-parts"))).toBe(true);
	});

	it("does not overwrite user-modified files", () => {
		seedAgentConfig();

		// Modify a seeded file to simulate user edits.
		const coderPath = join(tempDir, "agents", "coder.md");
		const customContent = "---\ndescription: User customized\n---\n\nCustom body\n";
		writeFileSync(coderPath, customContent, "utf-8");

		// Second seeding should not touch it.
		seedAgentConfig();

		const content = readFileContent(coderPath);
		expect(content).toBe(customContent);
	});
});
