/**
 * Unit tests for agent discovery and configuration (agents.ts).
 *
 * Tests pure functions first, then I/O-dependent functions with temp directories.
 * Since runtime discovery now uses only ~/.pi/agent/ paths, tests set
 * PI_CODING_AGENT_DIR to point to a temp directory.
 */
import * as fs from "node:fs";
const { mkdirSync, readdirSync, rmSync, writeFileSync } = fs;
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	discoverAgents,
	formatAgentList,
	AgentRegistry,
	type AgentConfig,
	type AgentDiagnostic,
} from "../subagent/agents.js";

// ---------------------------------------------------------------------------
// Pure functions — no I/O
// ---------------------------------------------------------------------------

describe("formatAgentList", () => {
	const agent = (name: string, source: "builtin" | "user" | "project" = "user"): AgentConfig => ({
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
		expect(result.text).toContain("user");
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
		expect(result.text).toMatch(/A \(user\): A description; B \(user\): B description/);
	});
});

// ---------------------------------------------------------------------------
// discoverAgents — I/O-dependent tests with temp directories
// ---------------------------------------------------------------------------

describe("discoverAgents", () => {
	let tempDir: string;
	let agentsDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-agents-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentsDir = join(tempDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = tempDir;
	});

	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		if (tempDir) {
			try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	/**
	 * Write an agent definition file.
	 * Values in extra can be strings (inline YAML) or arrays (YAML list blocks).
	 */
	const writeAgent = (
		dir: string,
		name: string,
		description: string,
		extra: Record<string, unknown> = {},
	) => {
		const frontmatterLines: string[] = [`description: ${description}`];
		for (const [key, value] of Object.entries(extra)) {
			if (Array.isArray(value)) {
				// YAML list: render each item on its own line with "- " prefix
				frontmatterLines.push(`${key}:`);
				for (const item of value) {
					frontmatterLines.push(`  - ${String(item)}`);
				}
			} else if (value === "" || value === null || value === undefined) {
				frontmatterLines.push(`${key}:`);
			} else {
				frontmatterLines.push(`${key}: ${value}`);
			}
		}
		const frontmatter = frontmatterLines.join("\n");
		const content = `---\n${frontmatter}\n---\n\nYou are ${name}.\n\nTools: {{tools}}\nGuidelines: {{guidelines}}\n`;
		writeFileSync(join(dir, `${name.toLowerCase()}.md`), content, "utf-8");
	};

	it("discovers agents from the user agents directory", () => {
		writeAgent(agentsDir, "CustomExplorer", "Custom exploration agent", { depth: 1, tools: "read, grep" });

		const result = discoverAgents();
		const names = result.agents.map((a) => a.name);
		expect(names).toContain("customexplorer");
		expect(result.projectAgentsDir).toBeNull();
	});

	it("parses agent config fields correctly (YAML arrays)", () => {
		writeAgent(agentsDir, "FullAgent", "Full featured agent", {
			tools: ["read", "bash", "edit"],
			extensions: ["web", "github"],
			model: "claude-haiku-4-5",
			reasoning_effort: "high",
			depth: 2,
			can_spawn: ["explorer", "planner"],
			skills: ["tdd", "diagnose"],
		});

		const result = discoverAgents();
		const agent = result.agents.find((a) => a.name === "fullagent")!;
		expect(agent).toBeDefined();
		expect(agent.tools).toEqual(["read", "bash", "edit"]);
		expect(agent.extensions).toEqual(["web", "github"]);
		expect(agent.model).toBe("claude-haiku-4-5");
		expect(agent.reasoningEffort).toBe("high");
		expect(agent.depth).toBe(2);
		expect(agent.can_spawn).toEqual(["explorer", "planner"]);
		expect(agent.skills).toEqual(["tdd", "diagnose"]);
		expect(agent.source).toBe("user");
		expect(agent.systemPrompt).toContain("You are FullAgent");
	});

	it("parses checkbox fields as YAML arrays", () => {
		writeAgent(agentsDir, "ArrayAgent", "Agent with YAML arrays", {
			tools: ["read", "bash", "edit"],
			extensions: ["web"],
			can_spawn: ["explorer", "reviewer"],
			skills: ["tdd"],
			prompt_parts: ["010-tools", "020-runtime-context"],
		});

		const result = discoverAgents();
		const agent = result.agents.find((a) => a.name === "arrayagent")!;
		expect(agent).toBeDefined();
		expect(agent.tools).toEqual(["read", "bash", "edit"]);
		expect(agent.extensions).toEqual(["web"]);
		expect(agent.can_spawn).toEqual(["explorer", "reviewer"]);
		expect(agent.skills).toEqual(["tdd"]);
		expect(agent.prompt_parts).toEqual(["010-tools", "020-runtime-context"]);
	});

	it("treats blank tools/extensions fields as missing while preserving explicit empty arrays", () => {
		writeFileSync(join(agentsDir, "blank-runtime.md"), `---
description: Agent with blank runtime fields
tools:
extensions:
---

Blank runtime fields.
`, "utf-8");
		writeFileSync(join(agentsDir, "empty-runtime.md"), `---
description: Agent with explicit empty runtime arrays
tools: []
extensions: []
---

Empty runtime arrays.
`, "utf-8");

		const result = discoverAgents();
		const blankRuntime = result.agents.find((a) => a.name === "blank-runtime")!;
		const emptyRuntime = result.agents.find((a) => a.name === "empty-runtime")!;

		expect(blankRuntime.tools).toBeUndefined();
		expect(blankRuntime.extensions).toBeUndefined();
		expect(emptyRuntime.tools).toEqual([]);
		expect(emptyRuntime.extensions).toEqual([]);
	});

	it("parses skills field with tri-state semantics", () => {
		// Missing skills: should be undefined
		writeAgent(agentsDir, "NoSkills", "Agent with no skills field");
		// Blank skills: empty array → []
		writeAgent(agentsDir, "BlankSkills", "Agent with blank skills", { skills: [] });
		// Comma-separated skills (legacy)
		writeAgent(agentsDir, "FilteredSkills", "Agent with filtered skills", { skills: ["tdd", "diagnose"] });

		const result = discoverAgents();

		const noSkills = result.agents.find((a) => a.name === "noskills")!;
		expect(noSkills).toBeDefined();
		expect(noSkills.skills).toBeUndefined();

		const blankSkills = result.agents.find((a) => a.name === "blankskills")!;
		expect(blankSkills).toBeDefined();
		expect(blankSkills.skills).toEqual([]);

		const filteredSkills = result.agents.find((a) => a.name === "filteredskills")!;
		expect(filteredSkills).toBeDefined();
		expect(filteredSkills.skills).toEqual(["tdd", "diagnose"]);
	});

	it("parses can_spawn field with tri-state semantics", () => {
		// Missing can_spawn: should be undefined (unrestricted)
		writeAgent(agentsDir, "Unrestricted", "Agent with no can_spawn field");
		// Blank can_spawn: empty array → [] (no spawns)
		writeAgent(agentsDir, "NoSpawns", "Agent with blank can_spawn", { can_spawn: [] });
		// Comma-separated can_spawn (legacy)
		writeAgent(agentsDir, "LimitedSpawns", "Agent with filtered can_spawn", { can_spawn: ["explorer", "planner"] });

		const result = discoverAgents();

		const unrestricted = result.agents.find((a) => a.name === "unrestricted")!;
		expect(unrestricted).toBeDefined();
		expect(unrestricted.can_spawn).toBeUndefined();

		const noSpawns = result.agents.find((a) => a.name === "nospawns")!;
		expect(noSpawns).toBeDefined();
		expect(noSpawns.can_spawn).toEqual([]);

		const limitedSpawns = result.agents.find((a) => a.name === "limitedspawns")!;
		expect(limitedSpawns).toBeDefined();
		expect(limitedSpawns.can_spawn).toEqual(["explorer", "planner"]);
	});


	it("parses can_spawn boolean false as empty array (not as string 'false')", () => {
		// Write raw YAML with boolean false value - the writeAgent helper always
		// stringifies values, so writeFileSync directly to get a real YAML boolean.
		const yaml = `---\ndescription: Agent with boolean can_spawn\ncan_spawn: false\n---\n\nSystem prompt.\n`;
		writeFileSync(join(agentsDir, "boolcanspawn.md"), yaml, "utf-8");

		const result = discoverAgents();
		const agent = result.agents.find((a) => a.name === "boolcanspawn")!;
		expect(agent).toBeDefined();
		expect(agent.can_spawn).toEqual([]);
	});


	it("parses prompt_parts field with tri-state semantics", () => {
		// Missing: undefined (all parts)
		writeAgent(agentsDir, "AllParts", "Agent with no prompt_parts field");
		// Empty array: [] (no parts)
		writeAgent(agentsDir, "NoParts", "Agent with empty prompt_parts", { prompt_parts: [] });
		// Explicit list
		writeAgent(agentsDir, "FilteredParts", "Agent with specific parts", {
			prompt_parts: ["010-tools", "020-runtime-context"],
		});

		const result = discoverAgents();

		const allParts = result.agents.find((a) => a.name === "allparts")!;
		expect(allParts).toBeDefined();
		expect(allParts.prompt_parts).toBeUndefined();

		const noParts = result.agents.find((a) => a.name === "noparts")!;
		expect(noParts).toBeDefined();
		expect(noParts.prompt_parts).toEqual([]);

		const filteredParts = result.agents.find((a) => a.name === "filteredparts")!;
		expect(filteredParts).toBeDefined();
		expect(filteredParts.prompt_parts).toEqual(["010-tools", "020-runtime-context"]);
	});

	it("handles the depth field as number or string", () => {
		writeAgent(agentsDir, "DepthNum", "Depth as number", { depth: 3 });
		writeAgent(agentsDir, "DepthStr", "Depth as string", { depth: "4" });

		const result = discoverAgents();
		const numAgent = result.agents.find((a) => a.name === "depthnum")!;
		const strAgent = result.agents.find((a) => a.name === "depthstr")!;
		expect(numAgent.depth).toBe(3);
		expect(strAgent.depth).toBe(4);
	});

	it("handles empty depth as undefined", () => {
		writeAgent(agentsDir, "NoDepth", "No depth config", { depth: "" });

		const result = discoverAgents();
		const agent = result.agents.find((a) => a.name === "nodepth")!;
		expect(agent.depth).toBeUndefined();
	});

	it("skips malformed YAML files gracefully without crashing agent discovery", () => {
		writeAgent(agentsDir, "GoodAgent", "A working agent");

		const brokenYaml = `---\ndescription: "Valid agent with broken YAML syntax\ntools: read\n---\n\nSystem prompt here.\n`;
		writeFileSync(join(agentsDir, "brokenagent.md"), brokenYaml, "utf-8");

		const result = discoverAgents();
		expect(result.agents.map((a) => a.name)).toContain("goodagent");
		expect(result.agents.find((a) => a.name === "brokenagent")).toBeUndefined();
	});

	it("skips hidden files (starting with dot) in agents directory", () => {
		writeAgent(agentsDir, "Visible", "A visible agent");
		const hiddenContent = `---\ndescription: Should be invisible\n---\n\nHidden agent.\n`;
		writeFileSync(join(agentsDir, ".hidden.md"), hiddenContent, "utf-8");

		const result = discoverAgents();
		expect(result.agents.map((a) => a.name)).toContain("visible");
		expect(result.agents.find((a) => a.name === ".hidden")).toBeUndefined();
	});

	it("skips non-markdown files in agents directory", () => {
		writeAgent(agentsDir, "RealAgent", "A real agent");
		writeFileSync(join(agentsDir, "notes.txt"), "Just some notes.", "utf-8");
		writeFileSync(join(agentsDir, "readme.md"), "---\ndescription: Readme description\n---\n\nReadme body.\n", "utf-8");

		const result = discoverAgents();
		expect(result.agents.find((a) => a.name === "notes")).toBeUndefined();
		expect(result.agents.map((a) => a.name)).toContain("readme");
	});

	it("returns null projectAgentsDir (project scanning removed)", () => {
		const result = discoverAgents();
		expect(result.projectAgentsDir).toBeNull();
	});

	it("returns empty agents when directory is empty", () => {
		const emptyDir = join(tmpdir(), `pi-agents-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const emptyAgentsDir = join(emptyDir, "agents");
		mkdirSync(emptyAgentsDir, { recursive: true });

		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = emptyDir;
		try {
			const result = discoverAgents();
			expect(result.agents).toEqual([]);
			expect(result.projectAgentsDir).toBeNull();
		} finally {
			process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			try { rmSync(emptyDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	it("returns empty agents when agents directory does not exist", () => {
		const noAgentsDir = join(tmpdir(), `pi-agents-none-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(noAgentsDir, { recursive: true });

		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = noAgentsDir;
		try {
			const result = discoverAgents();
			expect(result.agents).toEqual([]);
		} finally {
			process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			try { rmSync(noAgentsDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});

// ---------------------------------------------------------------------------
// AgentRegistry — class-based interface with diagnostics
// ---------------------------------------------------------------------------

describe("AgentRegistry", () => {
	let tempDir: string;
	let agentsDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentsDir = join(tempDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = tempDir;
	});

	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		if (tempDir) {
			try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	const writeAgent = (
		dir: string,
		name: string,
		description: string,
		extra: Record<string, unknown> = {},
	) => {
		const frontmatterLines: string[] = [`description: ${description}`];
		for (const [key, value] of Object.entries(extra)) {
			if (Array.isArray(value)) {
				frontmatterLines.push(`${key}:`);
				for (const item of value) {
					frontmatterLines.push(`  - ${String(item)}`);
				}
			} else if (value === "" || value === null || value === undefined) {
				frontmatterLines.push(`${key}:`);
			} else {
				frontmatterLines.push(`${key}: ${value}`);
			}
		}
		const frontmatter = frontmatterLines.join("\n");
		const content = `---\n${frontmatter}\n---\n\nYou are ${name}.\n\nTools: {{tools}}\n`;
		writeFileSync(join(dir, `${name.toLowerCase()}.md`), content, "utf-8");
	};

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	it("throws if agents are accessed before discover()", () => {
		const registry = new AgentRegistry();
		expect(() => registry.agents).toThrow("has not been initialized");
		expect(() => registry.projectAgentsDir).toThrow("has not been initialized");
	});

	it("discovers agents from the user agents directory", () => {
		writeAgent(agentsDir, "MyCustomAgent", "Custom agent");

		const registry = new AgentRegistry();
		registry.discover();
		const agent = registry.find("mycustomagent");
		expect(agent).toBeDefined();
		expect(agent!.description).toBe("Custom agent");
		expect(agent!.source).toBe("user");
	});

	it("find() returns undefined for non-existent agent", () => {
		const registry = new AgentRegistry();
		registry.discover();
		expect(registry.find("nonexistent")).toBeUndefined();
	});

	it("projectAgentsDir always returns null (project scanning removed)", () => {
		writeAgent(agentsDir, "Agent1", "Test agent");
		const registry = new AgentRegistry();
		registry.discover();
		expect(registry.projectAgentsDir).toBeNull();
	});

	it("re-discover() re-runs discovery after file changes", () => {
		const registry = new AgentRegistry();
		registry.discover();
		expect(registry.find("newagent")).toBeUndefined();

		writeAgent(agentsDir, "NewAgent", "Added after first discover");
		registry.discover();
		expect(registry.find("newagent")).toBeDefined();
	});



	// -----------------------------------------------------------------------
	// formatList
	// -----------------------------------------------------------------------

	it("formatList returns 'none' when no agents discovered", () => {
		const registry = new AgentRegistry();
		registry.discover();
		const result = registry.formatList(10);
		expect(result.text).toBe("none");
		expect(result.remaining).toBe(0);
	});

	it("formatList truncates at maxItems", () => {
		for (let i = 0; i < 10; i++) {
			writeAgent(agentsDir, `Agent${i}`, `Agent ${i} description`);
		}
		const registry = new AgentRegistry();
		registry.discover();
		const result = registry.formatList(3);
		expect(result.text.split("; ").length).toBe(3);
		expect(result.remaining).toBe(7);
	});

	// -----------------------------------------------------------------------
	// Diagnostics
	// -----------------------------------------------------------------------

	it("collects diagnostics for broken YAML frontmatter", () => {
		writeAgent(agentsDir, "GoodAgent", "A working agent");
		const brokenYaml = `---\ndescription: "Valid agent with broken YAML syntax\ntools: read\n---\n\nSystem prompt here.\n`;
		writeFileSync(join(agentsDir, "brokenagent.md"), brokenYaml, "utf-8");

		const registry = new AgentRegistry();
		registry.discover();

		expect(registry.find("goodagent")).toBeDefined();

		const diag = registry.diagnostics.find((d) => d.filePath.includes("brokenagent.md"));
		expect(diag).toBeDefined();
		expect(diag!.level).toBe("error");
		expect(diag!.reason).toContain("Malformed YAML");
	});

	it("collects diagnostics for missing description field", () => {
		const noDescContent = `---\nname: NoDesc\n---\n\nMissing description.\n`;
		writeFileSync(join(agentsDir, "nodesc.md"), noDescContent, "utf-8");

		const registry = new AgentRegistry();
		registry.discover();

		const diag = registry.diagnostics.find((d) => d.filePath.includes("nodesc.md"));
		expect(diag).toBeDefined();
		expect(diag!.level).toBe("error");
		expect(diag!.reason).toContain("description");
	});

	it("collects diagnostics for hidden (dot-prefixed) files", () => {
		const hiddenContent = `---\ndescription: Hidden agent\n---\n\nHidden body.\n`;
		writeFileSync(join(agentsDir, ".hidden.md"), hiddenContent, "utf-8");

		const registry = new AgentRegistry();
		registry.discover();

		const diag = registry.diagnostics.find((d) => d.filePath.endsWith(".hidden.md"));
		expect(diag).toBeDefined();
		expect(diag!.level).toBe("warn");
		expect(diag!.reason).toContain("Hidden");
	});

	it("collects diagnostics for unreadable files", () => {
		const agentPath = join(agentsDir, "locked.md");
		writeFileSync(agentPath, `---\ndescription: Locked agent\n---\n\nCan't read me.\n`, "utf-8");

		try {
			fs.chmodSync(agentPath, 0o000);
			const registry = new AgentRegistry();
			registry.discover();

			const diag = registry.diagnostics.find((d) => d.filePath.includes("locked.md"));
			expect(diag).toBeDefined();
			expect(diag!.level).toBe("error");
			expect(diag!.reason).toContain("Cannot read file");
		} finally {
			try { fs.chmodSync(agentPath, 0o644); } catch { /* ignore */ }
		}
	});

	it("does not collect diagnostics for non-.md files (skipped silently)", () => {
		writeFileSync(join(agentsDir, "notes.txt"), "Just some notes.", "utf-8");
		writeAgent(agentsDir, "RealAgent", "A working agent");

		const registry = new AgentRegistry();
		registry.discover();

		const txtDiag = registry.diagnostics.find((d) => d.filePath.includes("notes.txt"));
		expect(txtDiag).toBeUndefined();
		expect(registry.find("realagent")).toBeDefined();
	});

	it("collects multiple diagnostics in one discovery pass", () => {
		writeAgent(agentsDir, "Good1", "First good agent");
		writeAgent(agentsDir, "Good2", "Second good agent");

		const hiddenContent = `---\ndescription: Hidden\n---\n\nHidden.\n`;
		writeFileSync(join(agentsDir, ".hidden.md"), hiddenContent, "utf-8");

		writeFileSync(join(agentsDir, "nodesc.md"), "---\nname: Missing desc\n---\n\nBody.\n", "utf-8");

		const brokenYaml = `---\ndescription: "unclosed\ntools: read\n---\n\nBroken.\n`;
		writeFileSync(join(agentsDir, "broken.md"), brokenYaml, "utf-8");

		const registry = new AgentRegistry();
		registry.discover();

		expect(registry.diagnostics.length).toBeGreaterThanOrEqual(3);
		expect(registry.diagnostics.filter((d) => d.level === "error").length).toBeGreaterThanOrEqual(2);
		expect(registry.diagnostics.filter((d) => d.level === "warn").length).toBeGreaterThanOrEqual(1);

		expect(registry.find("good1")).toBeDefined();
		expect(registry.find("good2")).toBeDefined();
	});

	it("discover() resets diagnostics on each call", () => {
		const brokenYaml = `---\ndescription: "unclosed\n---\n`;
		writeFileSync(join(agentsDir, "broken.md"), brokenYaml, "utf-8");

		const registry = new AgentRegistry();
		registry.discover();
		expect(registry.diagnostics.length).toBeGreaterThanOrEqual(1);

		writeFileSync(join(agentsDir, "broken.md"), `---\ndescription: Fixed agent\n---\n\nWorking.\n`, "utf-8");
		registry.discover();
		expect(registry.diagnostics.length).toBe(0);
	});

	it("diagnostics are readonly (cannot be mutated from outside)", () => {
		writeAgent(agentsDir, "GoodAgent", "A working agent");

		const registry = new AgentRegistry();
		registry.discover();

		const diags: readonly AgentDiagnostic[] = registry.diagnostics;
		expect(Array.isArray(diags)).toBe(true);
		expect(diags.length).toBe(0);
	});

	// -----------------------------------------------------------------------
	// Compatibility wrappers
	// -----------------------------------------------------------------------

	it("discoverAgents compatibility wrapper still works", () => {
		writeAgent(agentsDir, "CompatAgent", "Compatibility test agent");

		const result = discoverAgents();
		const names = result.agents.map((a) => a.name);
		expect(names).toContain("compatagent");
		expect(result.projectAgentsDir).toBeNull();
	});

	it("Registry formatList matches standalone formatAgentList", () => {
		writeAgent(agentsDir, "Alpha", "Alpha agent");
		writeAgent(agentsDir, "Beta", "Beta agent");

		const registry = new AgentRegistry();
		registry.discover();

		const registryResult = registry.formatList(10).text;
		const standaloneResult = formatAgentList(registry.agents, 10).text;
		expect(registryResult).toBe(standaloneResult);
	});

	it("AgentRegistry works without explicit scope (defaults to user discovery)", () => {
		writeAgent(agentsDir, "ProjectAgent", "Project-specific agent");

		const registry = new AgentRegistry();
		registry.discover();

		expect(registry.find("projectagent")).toBeDefined();
	});
});
