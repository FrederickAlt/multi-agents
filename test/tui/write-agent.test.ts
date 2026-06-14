import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAgent } from "../../src/tui/file-io/read-agent.js";
import { writeFieldToFile } from "../../src/tui/file-io/write-agent.js";

const mockWriteFile = vi.hoisted(() => ({ shouldFail: false }));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
			if (mockWriteFile.shouldFail) {
				const err: NodeJS.ErrnoException = new Error("permission denied") as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			}
			return actual.writeFileSync(...args);
		},
	};
});

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(tmpdir(), "pi-config-write-test-"));
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeTempFile(content: string): string {
	const p = path.join(tempDir, "agent.md");
	fs.writeFileSync(p, content);
	return p;
}

function readTempFile(filePath: string): string {
	return fs.readFileSync(filePath, "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("writeFieldToFile", () => {
	describe("scalar fields", () => {
		it("writes a new scalar field to frontmatter", () => {
			const p = writeTempFile(["---", "description: test", "---", "", "body"].join("\n"));
			const result = writeFieldToFile(p, "model", "claude-sonnet");
			expect(result.success).toBe(true);
			const content = readTempFile(p);
			expect(content).toContain("model: claude-sonnet");
			expect(content).toContain("description: test");
			expect(content).toContain("body");
		});

		it("modifies an existing scalar field", () => {
			const p = writeTempFile(["---", "description: test", "model: old-model", "---", "", "body"].join("\n"));
			const result = writeFieldToFile(p, "model", "new-model");
			expect(result.success).toBe(true);
			const content = readTempFile(p);
			expect(content).toContain("model: new-model");
			expect(content).not.toContain("old-model");
			expect(content).toContain("description: test");
		});

		it("removes a field when value is undefined", () => {
			const p = writeTempFile(["---", "description: test", "model: old-model", "---", "", "body"].join("\n"));
			const result = writeFieldToFile(p, "model", undefined);
			expect(result.success).toBe(true);
			const content = readTempFile(p);
			expect(content).not.toContain("model");
			expect(content).toContain("description: test");
		});

		it("writes numeric field", () => {
			const p = writeTempFile(["---", "description: test", "---", "", "body"].join("\n"));
			const result = writeFieldToFile(p, "depth", 3);
			expect(result.success).toBe(true);
			expect(readTempFile(p)).toContain("depth: 3");
		});

		it("quotes special YAML characters in strings", () => {
			const p = writeTempFile(["---", "description: test", "---", "", "body"].join("\n"));
			const result = writeFieldToFile(p, "model", "model#with#hash");
			expect(result.success).toBe(true);
			expect(readTempFile(p)).toContain('model: "model#with#hash"');
		});
	});

	describe("list fields", () => {
		it("writes a new list field", () => {
			const p = writeTempFile(["---", "description: test", "---", "", "body"].join("\n"));
			const result = writeFieldToFile(p, "tools", ["read", "bash"]);
			expect(result.success).toBe(true);
			const content = readTempFile(p);
			expect(content).toContain("tools:");
			expect(content).toContain("  - read");
			expect(content).toContain("  - bash");
		});

		it("modifies an existing list field", () => {
			const p = writeTempFile(
				["---", "description: test", "tools:", "  - read", "  - bash", "---", "", "body"].join("\n"),
			);
			const result = writeFieldToFile(p, "tools", ["edit", "write"]);
			expect(result.success).toBe(true);
			const content = readTempFile(p);
			expect(content).toContain("  - edit");
			expect(content).toContain("  - write");
			expect(content).not.toContain("  - read");
			expect(content).not.toContain("  - bash");
		});

		it("writes empty list as []", () => {
			const p = writeTempFile(["---", "description: test", "---", "", "body"].join("\n"));
			const result = writeFieldToFile(p, "tools", []);
			expect(result.success).toBe(true);
			const content = readTempFile(p);
			expect(content).toContain("tools: []");
		});

		it("replaces existing list with empty []", () => {
			const p = writeTempFile(
				["---", "description: test", "tools:", "  - read", "  - bash", "---", "", "body"].join("\n"),
			);
			const result = writeFieldToFile(p, "tools", []);
			expect(result.success).toBe(true);
			const content = readTempFile(p);
			expect(content).toContain("tools: []");
			expect(content).not.toContain("  - read");
		});

		it("does not touch other fields when modifying one", () => {
			const p = writeTempFile(
				[
					"---",
					"description: test",
					"model: claude",
					"depth: 2",
					"tools:",
					"  - read",
					"extensions: []",
					"---",
					"",
					"body content here",
				].join("\n"),
			);
			writeFieldToFile(p, "model", "gpt-5");
			const content = readTempFile(p);
			expect(content).toContain("model: gpt-5");
			expect(content).toContain("description: test");
			expect(content).toContain("depth: 2");
			expect(content).toContain("tools:");
			expect(content).toContain("  - read");
			expect(content).toContain("extensions: []");
			expect(content).toContain("body content here");
		});

		it("does not modify the body markdown", () => {
			const bodyContent = "# Heading\n\nSome markdown with --- in it\n\n* list item";
			const p = writeTempFile(["---", "description: test", "---", "", bodyContent].join("\n"));
			writeFieldToFile(p, "model", "claude");
			const content = readTempFile(p);
			expect(content).toContain(bodyContent);
		});
	});

	describe("edge cases", () => {
		it("handles file with no frontmatter block", () => {
			const p = writeTempFile("Just a markdown file, no frontmatter.");
			const result = writeFieldToFile(p, "model", "claude");
			expect(result.success).toBe(true);
			const content = readTempFile(p);
			expect(content).toContain("model: claude");
			expect(content).toContain("Just a markdown file");
		});

		it("handles file with CRLF line endings", () => {
			const p = writeTempFile(["---\r", "description: test\r", "model: old\r", "---\r", "body\r"].join("\r\n"));
			const result = writeFieldToFile(p, "model", "new");
			expect(result.success).toBe(true);
			const content = readTempFile(p);
			expect(content).toContain("model: new");
		});

		it("returns error for nonexistent file", () => {
			const result = writeFieldToFile(path.join(tempDir, "nope.md"), "model", "claude");
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});

		it("includes 'read-only' in error for EACCES / EPERM", () => {
			const p = writeTempFile(["---", "description: test", "---", "", "body"].join("\n"));
			mockWriteFile.shouldFail = true;

			try {
				const result = writeFieldToFile(p, "model", "claude");
				expect(result.success).toBe(false);
				expect(result.error).toBeDefined();
				expect(result.error!.toLowerCase()).toMatch(/read.only|readonly/);
			} finally {
				mockWriteFile.shouldFail = false;
			}
		});

		it("removing a field works even when field had list value", () => {
			const p = writeTempFile(
				["---", "description: test", "tools:", "  - read", "  - bash", "model: claude", "---", "", "body"].join(
					"\n",
				),
			);
			const result = writeFieldToFile(p, "tools", undefined);
			expect(result.success).toBe(true);
			const content = readTempFile(p);
			expect(content).not.toContain("tools:");
			expect(content).not.toContain("  - read");
			expect(content).toContain("model: claude");
		});

		it("round-trip: write then read matches", () => {
			const p = writeTempFile(["---", "description: test agent", "---", "", "some body"].join("\n"));

			writeFieldToFile(p, "tools", ["read", "bash", "edit"]);
			writeFieldToFile(p, "model", "claude-sonnet");
			writeFieldToFile(p, "depth", 2);

			const agent = readAgent(p);
			expect(agent.error).toBeNull();
			expect(agent.frontmatter).toMatchObject({
				description: "test agent",
				model: "claude-sonnet",
				depth: 2,
				tools: ["read", "bash", "edit"],
			});
			expect(agent.body).toBe("some body");
		});
	});
});
