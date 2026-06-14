import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectStaleItems, readAgent, scanAgents } from "../../src/tui/file-io/read-agent.js";
import type { AgentConfigState } from "../../src/tui/state/types.js";

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(tmpdir(), "pi-config-read-test-"));
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeAgentDir(): string {
	const dir = path.join(tempDir, "agents");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function writeAgentFile(name: string, content: string): string {
	const agentsDir = makeAgentDir();
	const filePath = path.join(agentsDir, name);
	fs.writeFileSync(filePath, content);
	return filePath;
}

describe("readAgent", () => {
	it("parses a valid agent markdown file", () => {
		const p = writeAgentFile(
			"test-agent.md",
			[
				"---",
				'description: "A test agent"',
				"model: claude-sonnet",
				"tools:",
				"  - read",
				"  - bash",
				"---",
				"",
				"This is the body.",
			].join("\n"),
		);

		const agent = readAgent(p);
		expect(agent.name).toBe("test-agent");
		expect(agent.description).toBe("A test agent");
		expect(agent.error).toBeNull();
		expect(agent.frontmatter).toEqual({
			description: "A test agent",
			model: "claude-sonnet",
			tools: ["read", "bash"],
		});
		expect(agent.body).toBe("This is the body.");
	});

	it("handles missing file gracefully", () => {
		const p = path.join(tempDir, "nonexistent.md");
		const agent = readAgent(p);
		expect(agent.name).toBe("nonexistent");
		expect(agent.error).toContain("Cannot read file");
		expect(agent.frontmatter).toBeNull();
	});

	it("handles invalid YAML frontmatter", () => {
		const p = writeAgentFile("bad.md", ["---", "invalid: [unclosed", "---", "", "body"].join("\n"));
		const agent = readAgent(p);
		expect(agent.error).toContain("Invalid YAML");
		expect(agent.frontmatter).toBeNull();
	});

	it("handles file with no frontmatter", () => {
		const p = writeAgentFile("no-fm.md", "Just a markdown body, no frontmatter.");
		const agent = readAgent(p);
		expect(agent.body).toBe("Just a markdown body, no frontmatter.");
		// parseFrontmatter handles this gracefully
	});

	it("extracts description from frontmatter", () => {
		const p = writeAgentFile("desc.md", ["---", 'description: "Helpful agent"', "---", "", "body"].join("\n"));
		const agent = readAgent(p);
		expect(agent.description).toBe("Helpful agent");
	});

	it("handles numeric and boolean frontmatter values", () => {
		const p = writeAgentFile(
			"nums.md",
			["---", "description: test", "depth: 3", "active: true", "---", "", "body"].join("\n"),
		);
		const agent = readAgent(p);
		expect(agent.frontmatter).toMatchObject({
			description: "test",
			depth: 3,
			active: true,
		});
	});
});

describe("scanAgents", () => {
	it("returns empty array when agents dir does not exist", () => {
		const agents = scanAgents(tempDir);
		expect(agents).toEqual([]);
	});

	it("scans all .md files in agents dir", () => {
		writeAgentFile("a.md", ["---", 'description: "Agent A"', "---", "", "body A"].join("\n"));
		writeAgentFile("b.md", ["---", 'description: "Agent B"', "---", "", "body B"].join("\n"));
		const agents = scanAgents(tempDir);
		expect(agents).toHaveLength(2);
		expect(agents.map((a) => a.name).sort()).toEqual(["a", "b"]);
	});

	it("skips hidden files", () => {
		writeAgentFile(".hidden.md", ["---", 'description: "Hidden"', "---", "", "body"].join("\n"));
		writeAgentFile("visible.md", ["---", 'description: "Visible"', "---", "", "body"].join("\n"));
		const agents = scanAgents(tempDir);
		expect(agents).toHaveLength(1);
		expect(agents[0].name).toBe("visible");
	});

	it("skips non-.md files", () => {
		const agentsDir = path.join(tempDir, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "readme.txt"), "not an agent");
		const agents = scanAgents(tempDir);
		expect(agents).toHaveLength(0);
	});
});

describe("detectStaleItems", () => {
	it("detects stale values in checkbox fields", () => {
		const agents: AgentConfigState[] = [
			{
				name: "test",
				description: "desc",
				filePath: "/tmp/test.md",
				frontmatter: {
					description: "desc",
					can_spawn: ["existing-agent", "deleted-agent"],
					tools: ["read", "unknown-tool"],
				},
				body: "",
				error: null,
				staleItems: {},
			},
		];

		detectStaleItems(agents, ["existing-agent"], ["read", "bash"], [], [], []);

		expect(agents[0].staleItems.can_spawn).toEqual(["deleted-agent"]);
		expect(agents[0].staleItems.tools).toEqual(["unknown-tool"]);
	});

	it("handles empty/undefined fields", () => {
		const agents: AgentConfigState[] = [
			{
				name: "test",
				description: "desc",
				filePath: "/tmp/test.md",
				frontmatter: { description: "desc" },
				body: "",
				error: null,
				staleItems: {},
			},
		];

		detectStaleItems(agents, [], [], [], [], []);
		expect(agents[0].staleItems).toEqual({});
	});

	it("handles null frontmatter (parse error)", () => {
		const agents: AgentConfigState[] = [
			{
				name: "bad",
				description: "",
				filePath: "/tmp/bad.md",
				frontmatter: null,
				body: "",
				error: "parse error",
				staleItems: {},
			},
		];

		detectStaleItems(agents, [], [], [], [], []);
		expect(agents[0].staleItems).toEqual({});
	});
});
