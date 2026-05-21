import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	discoverTools,
	discoverExtensions,
	discoverCanSpawn,
	discoverAllAgentNames,
	discoverSkills,
	discoverPromptParts,
} from "../../src/tui/discovery/options.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(tmpdir(), "pi-agent-config-test-"));
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function mkdir(...segments: string[]): string {
	const p = path.join(tempDir, ...segments);
	fs.mkdirSync(p, { recursive: true });
	return p;
}

function writeFile(...segments: string[]): string {
	const p = path.join(tempDir, ...segments);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, "");
	return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discoverTools", () => {
	it("returns built-in tools plus tools from agent definitions", () => {
		const agentToolLists = [["custom-tool", "bash"], ["another-tool"]];
		const tools = discoverTools(tempDir, agentToolLists);
		expect(tools).toContain("read");
		expect(tools).toContain("bash");
		expect(tools).toContain("custom-tool");
		expect(tools).toContain("another-tool");
	});

	it("returns built-in tools when no agent definitions", () => {
		const tools = discoverTools(tempDir, []);
		expect(tools).toContain("read");
		expect(tools).toContain("bash");
		expect(tools).toContain("edit");
	});

	it("deduplicates tools", () => {
		const tools = discoverTools(tempDir, [["read", "read"]]);
		const count = tools.filter((t) => t === "read").length;
		expect(count).toBe(1);
	});

	it("returns sorted array", () => {
		const tools = discoverTools(tempDir, [["z-tool", "a-tool"]]);
		const sorted = [...tools].sort();
		expect(tools).toEqual(sorted);
	});
});

describe("discoverExtensions", () => {
	it("returns empty array when extensions dir does not exist", () => {
		const exts = discoverExtensions(tempDir);
		expect(exts).toEqual([]);
	});

	it("returns directory names as extension names", () => {
		mkdir("extensions", "my-ext");
		mkdir("extensions", "another-ext");
		const exts = discoverExtensions(tempDir);
		expect(exts).toContain("my-ext");
		expect(exts).toContain("another-ext");
	});

	it("returns file names stripped of extension", () => {
		writeFile("extensions", "my-ext.js");
		writeFile("extensions", "another-ext.ts");
		const exts = discoverExtensions(tempDir);
		expect(exts).toContain("my-ext");
		expect(exts).toContain("another-ext");
	});

	it("returns sorted and deduplicated", () => {
		mkdir("extensions", "b-ext");
		mkdir("extensions", "a-ext");
		writeFile("extensions", "a-ext.js");
		const exts = discoverExtensions(tempDir);
		const aCount = exts.filter((e) => e === "a-ext").length;
		expect(aCount).toBe(1);
		expect(exts[0]).toBe("a-ext");
		expect(exts[1]).toBe("b-ext");
	});
});

describe("discoverCanSpawn", () => {
	it("excludes self from spawnable agents", () => {
		writeFile("agents", "self.md");
		writeFile("agents", "other.md");
		const names = discoverCanSpawn(tempDir, "self");
		expect(names).toEqual(["other"]);
	});

	it("returns empty when only self exists", () => {
		writeFile("agents", "self.md");
		const names = discoverCanSpawn(tempDir, "self");
		expect(names).toEqual([]);
	});

	it("skips hidden files", () => {
		writeFile("agents", ".hidden.md");
		writeFile("agents", "visible.md");
		const names = discoverCanSpawn(tempDir, "self");
		expect(names).toEqual(["visible"]);
	});

	it("returns sorted names", () => {
		writeFile("agents", "c-agent.md");
		writeFile("agents", "a-agent.md");
		writeFile("agents", "b-agent.md");
		const names = discoverCanSpawn(tempDir, "self");
		expect(names).toEqual(["a-agent", "b-agent", "c-agent"]);
	});
});

describe("discoverAllAgentNames", () => {
	it("returns all agent names including self", () => {
		writeFile("agents", "self.md");
		writeFile("agents", "other.md");
		const names = discoverAllAgentNames(tempDir);
		expect(names).toContain("self");
		expect(names).toContain("other");
	});
});

describe("discoverSkills", () => {
	it("returns skill names from directories with SKILL.md", () => {
		writeFile("skills", "my-skill", "SKILL.md");
		writeFile("skills", "another-skill", "SKILL.md");
		const skills = discoverSkills(tempDir);
		expect(skills).toContain("my-skill");
		expect(skills).toContain("another-skill");
	});

	it("ignores directories without SKILL.md", () => {
		mkdir("skills", "empty-skill");
		writeFile("skills", "valid-skill", "SKILL.md");
		const skills = discoverSkills(tempDir);
		expect(skills).toEqual(["valid-skill"]);
	});

	it("returns empty when skills dir does not exist", () => {
		const skills = discoverSkills(tempDir);
		expect(skills).toEqual([]);
	});
});

describe("discoverPromptParts", () => {
	it("returns prompt part names from .md files", () => {
		writeFile("prompt-parts", "010-tools.md");
		writeFile("prompt-parts", "020-context.md");
		const parts = discoverPromptParts(tempDir);
		expect(parts).toContain("010-tools");
		expect(parts).toContain("020-context");
	});

	it("skips hidden files", () => {
		writeFile("prompt-parts", ".hidden.md");
		writeFile("prompt-parts", "010-tools.md");
		const parts = discoverPromptParts(tempDir);
		expect(parts).toEqual(["010-tools"]);
	});

	it("returns empty when prompt-parts dir does not exist", () => {
		const parts = discoverPromptParts(tempDir);
		expect(parts).toEqual([]);
	});
});
