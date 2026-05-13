/**
 * Unit tests for agent discovery and configuration (agents.ts).
 *
 * Tests pure functions first, then I/O-dependent functions with temp directories.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	discoverAgents,
	formatAgentList,
	type AgentConfig,
} from "../subagent/agents.js";

const bundledAgentsDir = fileURLToPath(new URL("../subagent/agents/", import.meta.url));
const bundledAgentNames = () => readdirSync(bundledAgentsDir)
	.filter((name) => name.endsWith(".md") && !name.startsWith("."))
	.map((name) => name.slice(0, -".md".length));

// ---------------------------------------------------------------------------
// Pure functions — no I/O
// ---------------------------------------------------------------------------

describe("formatAgentList", () => {
	const agent = (name: string, source: "builtin" | "user" | "project" = "builtin"): AgentConfig => ({
		name,
		description: `${name} description`,
		systemPrompt: "prompt",
		source,
		filePath: `/tmp/${name}.md`,
	});

	it("returns 'none' for empty list", () => {
		expect(formatAgentList([], 10)).toEqual({ text: "none", remaining: 0 });
	});

	it("formats a single agent", () => {
		const result = formatAgentList([agent("Explore")], 10);
		expect(result.text).toContain("Explore");
		expect(result.text).toContain("builtin");
		expect(result.remaining).toBe(0);
	});

	it("truncates at maxItems and reports remaining count", () => {
		const agents = Array.from({ length: 10 }, (_, i) => agent(`Agent${i}`));
		const result = formatAgentList(agents, 3);
		expect(result.text.split("; ").length).toBe(3);
		expect(result.remaining).toBe(7);
	});

	it("separates multiple agents with semicolons", () => {
		const result = formatAgentList([agent("A"), agent("B")], 10);
		expect(result.text).toMatch(/A \(builtin\): A description; B \(builtin\): B description/);
	});
});

// ---------------------------------------------------------------------------
// discoverAgents — I/O-dependent tests with temp directories
// ---------------------------------------------------------------------------

describe("discoverAgents", () => {
	let tempDir: string;
	let projectDir: string;
	let agentsDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-agents-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(tempDir, ".pi");
		agentsDir = join(projectDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	const writeAgent = (dir: string, name: string, description: string, extra: Record<string, string | number> = {}) => {
		// Agent name comes from the filename stem, not from a frontmatter field.
		const frontmatter = [`description: ${description}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)].join("\n");
		const content = `---\n${frontmatter}\n---\n\nYou are ${name}.\n\nTools: {{tools}}\nGuidelines: {{guidelines}}\n`;
		writeFileSync(join(dir, `${name.toLowerCase()}.md`), content, "utf-8");
	};

	it("discovers agents from project .pi/agents directory", () => {
		writeAgent(agentsDir, "CustomExplorer", "Custom exploration agent", { depth: 1, tools: "read, grep" });

		const result = discoverAgents(tempDir, "project");
		const names = result.agents.map((a) => a.name);
		expect(names).toContain("customexplorer");
		expect(result.projectAgentsDir).toBe(agentsDir);
	});

	it("parses agent config fields correctly", () => {
		writeAgent(agentsDir, "FullAgent", "Full featured agent", {
			tools: "read, bash, edit",
			extensions: "web, github",
			model: "claude-haiku-4-5",
			reasoning_effort: "high",
			depth: 2,
			canSpawn: "Explore, Planner",
		});

		const result = discoverAgents(tempDir, "project");
		const agent = result.agents.find((a) => a.name === "fullagent")!;
		expect(agent).toBeDefined();
		expect(agent.tools).toEqual(["read", "bash", "edit"]);
		expect(agent.extensions).toEqual(["web", "github"]);
		expect(agent.model).toBe("claude-haiku-4-5");
		expect(agent.reasoningEffort).toBe("high");
		expect(agent.depth).toBe(2);
		expect(agent.canSpawn).toEqual(["Explore", "Planner"]);
		expect(agent.source).toBe("project");
		expect(agent.systemPrompt).toContain("You are FullAgent");
	});

	it("project agents override same-named agents from other sources", () => {
		writeAgent(agentsDir, "explore", "Project override Explore");

		// With "project" scope we only get project agents
		const result = discoverAgents(tempDir, "project");
		const explorer = result.agents.find((a) => a.name === "explore")!;
		expect(explorer).toBeDefined();
		expect(explorer.description).toBe("Project override Explore");
		expect(explorer.source).toBe("project");
	});

	it("with 'both' scope, project agents override bundled agents of the same name", () => {
		const [builtinName, otherBuiltinName] = bundledAgentNames();
		writeAgent(agentsDir, builtinName, "Project-specific override");

		const result = discoverAgents(tempDir, "both");
		const overridden = result.agents.find((a) => a.name === builtinName)!;
		expect(overridden).toBeDefined();
		expect(overridden.description).toBe("Project-specific override");
		expect(overridden.source).toBe("project");
		// Other bundled agents should still be present
		expect(result.agents.map((a) => a.name)).toContain(otherBuiltinName);
	});

	it("skips markdown files without required frontmatter", () => {
		writeFileSync(join(agentsDir, "invalid.md"), "# No frontmatter\n\nJust a markdown file.", "utf-8");
		writeFileSync(join(agentsDir, "nodesc.md"), "---\nname: NoDesc\n---\n\nMissing description.", "utf-8");

		const result = discoverAgents(tempDir, "project");
		expect(result.agents.find((a) => a.name === "nodesc")).toBeUndefined();
	});

	it("returns null projectAgentsDir when no .pi/agents found in any parent", () => {
		// Use a tempDir that doesn't have .pi/agents in beforeEach
		const cleanTemp = join(tmpdir(), `pi-agents-clean-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cleanTemp, { recursive: true });
		try {
			// create a subdir without any .pi parent
			const deep = join(cleanTemp, "a", "b", "c");
			mkdirSync(deep, { recursive: true });
			// But wait — the system might have real .pi/agents up the tree.
			// Run discoverAgents from a truly isolated tempdir.
			// Since /tmp typically has no .pi/agents, discoverAgents from /tmp should return null.
			// Actually, the nearest .pi/agents detection walks up to root.
			// Let's just verify from the clean temp root (no .pi dir exists).
			const result = discoverAgents(cleanTemp, "project");
			expect(result.projectAgentsDir).toBeNull();
		} finally {
			try { rmSync(cleanTemp, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	it("returns bundled agents even with project scope when no project agents found", () => {
		// discoverAgents always includes bundled agents regardless of scope.
		// With "project" scope and no project agents, we still get builtins.
		const cleanTemp = join(tmpdir(), `pi-agents-clean2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cleanTemp, { recursive: true });
		try {
			const result = discoverAgents(cleanTemp, "project");
			const names = result.agents.map((a) => a.name);
			for (const bundledName of bundledAgentNames()) {
				expect(names).toContain(bundledName);
			}
			expect(result.projectAgentsDir).toBeNull();
		} finally {
			try { rmSync(cleanTemp, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	it("discovers agents from nearest parent .pi/agents", () => {
		writeAgent(agentsDir, "ParentAgent", "Found from parent");
		const childDir = join(tempDir, "deeply", "nested");
		mkdirSync(childDir, { recursive: true });

		const result = discoverAgents(childDir, "project");
		expect(result.agents.map((a) => a.name)).toContain("parentagent");
		expect(result.projectAgentsDir).toBe(agentsDir);
	});

	it("handles the depth field as number or string", () => {
		writeAgent(agentsDir, "DepthNum", "Depth as number", { depth: 3 });
		writeAgent(agentsDir, "DepthStr", "Depth as string", { depth: "4" });

		const result = discoverAgents(tempDir, "project");
		const numAgent = result.agents.find((a) => a.name === "depthnum")!;
		const strAgent = result.agents.find((a) => a.name === "depthstr")!;
		expect(numAgent.depth).toBe(3);
		expect(strAgent.depth).toBe(4);
	});

	it("handles empty depth as undefined", () => {
		writeAgent(agentsDir, "NoDepth", "No depth config", { depth: "" });

		const result = discoverAgents(tempDir, "project");
		const agent = result.agents.find((a) => a.name === "nodepth")!;
		expect(agent.depth).toBeUndefined();
	});

	it("skips malformed YAML files gracefully without crashing agent discovery", () => {
		// Write a valid agent file
		writeAgent(agentsDir, "GoodAgent", "A working agent");

		// Write an agent file with broken YAML — unbalanced quotes, illegal syntax
		const brokenYaml = `---\ndescription: "Valid agent with broken YAML syntax\ntools: read\n---\n\nSystem prompt here.\n`;
		writeFileSync(join(agentsDir, "brokenagent.md"), brokenYaml, "utf-8");

		// discovery should NOT throw — the broken file should be skipped
		const result = discoverAgents(tempDir, "project");
		expect(result.agents.map((a) => a.name)).toContain("goodagent");
		// The broken agent should be silently omitted
		expect(result.agents.find((a) => a.name === "brokenagent")).toBeUndefined();
	});

	it("skips hidden files (starting with dot) in agents directory", () => {
		writeAgent(agentsDir, "Visible", "A visible agent");
		// A hidden .md file — its stem starts with "."
		const hiddenContent = `---\ndescription: Should be invisible\n---\n\nHidden agent.\n`;
		writeFileSync(join(agentsDir, ".hidden.md"), hiddenContent, "utf-8");

		const result = discoverAgents(tempDir, "project");
		expect(result.agents.map((a) => a.name)).toContain("visible");
		expect(result.agents.find((a) => a.name === ".hidden")).toBeUndefined();
	});

	it("skips non-markdown files in agents directory", () => {
		writeAgent(agentsDir, "RealAgent", "A real agent");
		writeFileSync(join(agentsDir, "notes.txt"), "Just some notes.", "utf-8");
		writeFileSync(join(agentsDir, "readme.md"), "---\ndescription: Readme description\n---\n\nReadme body.\n", "utf-8");

		const result = discoverAgents(tempDir, "project");
		// notes.txt should be skipped (not .md)
		expect(result.agents.find((a) => a.name === "notes")).toBeUndefined();
		// readme.md should be discovered (has .md extension and valid frontmatter)
		expect(result.agents.map((a) => a.name)).toContain("readme");
	});
});
