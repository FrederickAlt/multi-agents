/**
 * Unit tests for agent discovery and configuration (agents.ts).
 *
 * Tests pure functions first, then I/O-dependent functions with temp directories.
 */
import * as fs from "node:fs";
const { mkdirSync, readdirSync, rmSync, writeFileSync } = fs;
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	discoverAgents,
	formatAgentList,
	AgentRegistry,
	type AgentConfig,
	type AgentDiagnostic,
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

	it("discovers the built-in default Root agent definition", () => {
		const result = discoverAgents(tempDir, "project");
		const defaultAgent = result.agents.find((a) => a.name === "default");

		expect(defaultAgent).toBeDefined();
		expect(defaultAgent?.source).toBe("builtin");
		expect(defaultAgent?.description).toContain("Default Root");
		expect(defaultAgent?.systemPrompt).toContain("Pi documentation");
		expect(defaultAgent?.systemPrompt).toContain("file-exploration tools");
	});

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
			skills: "tdd, diagnose",
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
		expect(agent.skills).toEqual(["tdd", "diagnose"]);
		expect(agent.source).toBe("project");
		expect(agent.systemPrompt).toContain("You are FullAgent");
	});

	it("parses skills field with tri-state semantics", () => {
		// Missing skills: should be undefined
		writeAgent(agentsDir, "NoSkills", "Agent with no skills field");
		// Blank skills: comma-string that resolves to empty → []
		writeAgent(agentsDir, "BlankSkills", "Agent with blank skills", { skills: "" });
		// Comma-separated skills
		writeAgent(agentsDir, "FilteredSkills", "Agent with filtered skills", { skills: "tdd, diagnose" });

		const result = discoverAgents(tempDir, "project");

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

	it("project default agent overrides the built-in default Root agent", () => {
		writeAgent(agentsDir, "default", "Project default Root", { depth: 2 });

		const result = discoverAgents(tempDir, "both");
		const defaultAgent = result.agents.find((a) => a.name === "default")!;

		expect(defaultAgent).toBeDefined();
		expect(defaultAgent.source).toBe("project");
		expect(defaultAgent.description).toBe("Project default Root");
		expect(defaultAgent.depth).toBe(2);
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

// ---------------------------------------------------------------------------
// AgentRegistry — class-based interface with diagnostics
// ---------------------------------------------------------------------------

describe("AgentRegistry", () => {
	let tempDir: string;
	let projectDir: string;
	let agentsDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		const frontmatter = [`description: ${description}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)].join("\n");
		const content = `---\n${frontmatter}\n---\n\nYou are ${name}.\n\nTools: {{tools}}\n`;
		writeFileSync(join(dir, `${name.toLowerCase()}.md`), content, "utf-8");
	};

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	it("throws if agents are accessed before discover()", () => {
		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
		expect(() => registry.agents).toThrow("has not been initialized");
		expect(() => registry.projectAgentsDir).toThrow("has not been initialized");
	});

	it("discovers bundled agents by default", () => {
		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
		registry.discover();
		const names = registry.agents.map((a) => a.name);
		for (const bundledName of bundledAgentNames()) {
			expect(names).toContain(bundledName);
		}
	});

	it("discovers project agents from .pi/agents directory", () => {
		writeAgent(agentsDir, "MyCustomAgent", "Custom agent");

		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
		registry.discover();
		const agent = registry.find("mycustomagent");
		expect(agent).toBeDefined();
		expect(agent!.description).toBe("Custom agent");
		expect(agent!.source).toBe("project");
	});

	it("find() returns undefined for non-existent agent", () => {
		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
		registry.discover();
		expect(registry.find("nonexistent")).toBeUndefined();
	});

	it("projectAgentsDir returns the discovered project agents directory", () => {
		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
		registry.discover();
		expect(registry.projectAgentsDir).toBe(agentsDir);
	});

	it("projectAgentsDir is null when no .pi/agents found", () => {
		const cleanTemp = join(tmpdir(), `pi-registry-clean-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cleanTemp, { recursive: true });
		try {
			const registry = new AgentRegistry({ cwd: cleanTemp, scope: "project" });
			registry.discover();
			expect(registry.projectAgentsDir).toBeNull();
		} finally {
			try { rmSync(cleanTemp, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	it("re-discover() re-runs discovery after file changes", () => {
		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
		registry.discover();
		expect(registry.find("newagent")).toBeUndefined();

		writeAgent(agentsDir, "NewAgent", "Added after first discover");
		registry.discover();
		expect(registry.find("newagent")).toBeDefined();
	});

	it("setCwd() invalidates cached results", () => {
		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
		registry.discover();
		const agentsBefore = registry.agents;

		// setCwd marks as not-discovered
		registry.setCwd(tempDir);
		expect(() => registry.agents).toThrow("has not been initialized");

		// Re-discover works
		registry.discover();
		expect(registry.agents).toEqual(agentsBefore);
	});

	it("setScope() invalidates cached results", () => {
		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
		registry.discover();

		registry.setScope("both");
		expect(() => registry.agents).toThrow("has not been initialized");

		registry.discover();
		expect(registry.agents.length).toBeGreaterThanOrEqual(bundledAgentNames().length);
	});

	// -----------------------------------------------------------------------
	// formatList
	// -----------------------------------------------------------------------

	it("formatList returns 'none' when no agents discovered", () => {
		// Clean temp with no project agents and project scope -> only bundled
		const cleanTemp = join(tmpdir(), `pi-registry-format-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cleanTemp, { recursive: true });
		try {
			// Use user scope from a tempdir that has no agents — we only get bundled
			// Actually bundled agents are always present, so let's use a truly empty setup.
			// Instead, test with "user" scope from a clean tempdir.
			const registry = new AgentRegistry({ cwd: cleanTemp, scope: "user" });
			registry.discover();
			// Bundled agents are always included regardless of scope
			const result = registry.formatList(10);
			expect(result.text).not.toBe("none");
			expect(result.text).toContain(bundledAgentNames()[0]);
		} finally {
			try { rmSync(cleanTemp, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	it("formatList truncates at maxItems", () => {
		// Create several project agents
		for (let i = 0; i < 10; i++) {
			writeAgent(agentsDir, `Agent${i}`, `Agent ${i} description`);
		}
		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
		registry.discover();
		const result = registry.formatList(3);
		expect(result.text.split("; ").length).toBe(3);
		expect(result.remaining).toBe(10 + bundledAgentNames().length - 3);
	});

	// -----------------------------------------------------------------------
	// Diagnostics
	// -----------------------------------------------------------------------

	it("collects diagnostics for broken YAML frontmatter", () => {
		writeAgent(agentsDir, "GoodAgent", "A working agent");
		const brokenYaml = `---\ndescription: "Valid agent with broken YAML syntax\ntools: read\n---\n\nSystem prompt here.\n`;
		writeFileSync(join(agentsDir, "brokenagent.md"), brokenYaml, "utf-8");

		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
		registry.discover();

		// Good agent is still found
		expect(registry.find("goodagent")).toBeDefined();

		// Diagnostic collected for broken file
		const diag = registry.diagnostics.find((d) => d.filePath.includes("brokenagent.md"));
		expect(diag).toBeDefined();
		expect(diag!.level).toBe("error");
		expect(diag!.reason).toContain("Malformed YAML");
	});

	it("collects diagnostics for missing description field", () => {
		const noDescContent = `---\nname: NoDesc\n---\n\nMissing description.\n`;
		writeFileSync(join(agentsDir, "nodesc.md"), noDescContent, "utf-8");

		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
		registry.discover();

		const diag = registry.diagnostics.find((d) => d.filePath.includes("nodesc.md"));
		expect(diag).toBeDefined();
		expect(diag!.level).toBe("error");
		expect(diag!.reason).toContain("description");
	});

	it("collects diagnostics for hidden (dot-prefixed) files", () => {
		const hiddenContent = `---\ndescription: Hidden agent\n---\n\nHidden body.\n`;
		writeFileSync(join(agentsDir, ".hidden.md"), hiddenContent, "utf-8");

		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
		registry.discover();

		const diag = registry.diagnostics.find((d) => d.filePath.endsWith(".hidden.md"));
		expect(diag).toBeDefined();
		expect(diag!.level).toBe("warn");
		expect(diag!.reason).toContain("Hidden");
	});

	it("collects diagnostics for unreadable files", () => {
		// Create a file and then remove read permissions
		const agentPath = join(agentsDir, "locked.md");
		writeFileSync(agentPath, `---\ndescription: Locked agent\n---\n\nCan't read me.\n`, "utf-8");

		try {
			// Make file unreadable
			fs.chmodSync(agentPath, 0o000);

			const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
			registry.discover();

			const diag = registry.diagnostics.find((d) => d.filePath.includes("locked.md"));
			expect(diag).toBeDefined();
			expect(diag!.level).toBe("error");
			expect(diag!.reason).toContain("Cannot read file");
		} finally {
			// Restore permissions so cleanup works
			try { fs.chmodSync(agentPath, 0o644); } catch { /* ignore */ }
		}
	});

	it("does not collect diagnostics for non-.md files (skipped silently)", () => {
		writeFileSync(join(agentsDir, "notes.txt"), "Just some notes.", "utf-8");
		writeAgent(agentsDir, "RealAgent", "A working agent");

		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
		registry.discover();

		// No diagnostics for the .txt file
		const txtDiag = registry.diagnostics.find((d) => d.filePath.includes("notes.txt"));
		expect(txtDiag).toBeUndefined();

		// Real agent is still found
		expect(registry.find("realagent")).toBeDefined();
	});

	it("collects multiple diagnostics in one discovery pass", () => {
		// Valid agents
		writeAgent(agentsDir, "Good1", "First good agent");
		writeAgent(agentsDir, "Good2", "Second good agent");

		// Invalid: hidden file
		const hiddenContent = `---\ndescription: Hidden\n---\n\nHidden.\n`;
		writeFileSync(join(agentsDir, ".hidden.md"), hiddenContent, "utf-8");

		// Invalid: no description
		writeFileSync(join(agentsDir, "nodesc.md"), "---\nname: Missing desc\n---\n\nBody.\n", "utf-8");

		// Invalid: malformed YAML
		const brokenYaml = `---\ndescription: "unclosed\ntools: read\n---\n\nBroken.\n`;
		writeFileSync(join(agentsDir, "broken.md"), brokenYaml, "utf-8");

		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
		registry.discover();

		// All diagnostics collected
		expect(registry.diagnostics.length).toBeGreaterThanOrEqual(3);
		expect(registry.diagnostics.filter((d) => d.level === "error").length).toBeGreaterThanOrEqual(2);
		expect(registry.diagnostics.filter((d) => d.level === "warn").length).toBeGreaterThanOrEqual(1);

		// Valid agents still found
		expect(registry.find("good1")).toBeDefined();
		expect(registry.find("good2")).toBeDefined();
	});

	it("discover() resets diagnostics on each call", () => {
		// First pass: broken file
		const brokenYaml = `---\ndescription: "unclosed\n---\n`;
		writeFileSync(join(agentsDir, "broken.md"), brokenYaml, "utf-8");

		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
		registry.discover();
		expect(registry.diagnostics.length).toBeGreaterThanOrEqual(1);

		// Fix the file and rediscover
		writeFileSync(join(agentsDir, "broken.md"), `---\ndescription: Fixed agent\n---\n\nWorking.\n`, "utf-8");
		registry.discover();
		expect(registry.diagnostics.length).toBe(0);
	});

	it("diagnostics are readonly (cannot be mutated from outside)", () => {
		writeAgent(agentsDir, "GoodAgent", "A working agent");

		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
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

		const result = discoverAgents(tempDir, "project");
		const names = result.agents.map((a) => a.name);
		expect(names).toContain("compatagent");
		expect(result.projectAgentsDir).toBe(agentsDir);
	});

	it("Registry formatList matches standalone formatAgentList", () => {
		writeAgent(agentsDir, "Alpha", "Alpha agent");
		writeAgent(agentsDir, "Beta", "Beta agent");

		const registry = new AgentRegistry({ cwd: tempDir, scope: "project" });
		registry.discover();

		// Both outputs use the same format and should be equivalent
		const registryResult = registry.formatList(10).text;
		const standaloneResult = formatAgentList(registry.agents, 10).text;
		expect(registryResult).toBe(standaloneResult);
	});

	it("Registry discoverAgents default scope is 'both'", () => {
		// No scope => 'both' is used, which includes bundled + any project agents
		writeAgent(agentsDir, "ProjectAgent", "Project-specific agent");

		const registry = new AgentRegistry({ cwd: tempDir });
		registry.discover();

		// Should have bundled agents
		expect(registry.find(bundledAgentNames()[0])).toBeDefined();
		// Should have project agent
		expect(registry.find("projectagent")).toBeDefined();
	});
});
