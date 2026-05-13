/**
 * Docs-as-contract tests: verify that documentation matches implementation.
 *
 * These tests parse the project's markdown documentation and compare it
 * against the actual agent definition files and registered commands.
 * They fail when documented behavior drifts from implementation — making
 * the docs a contract that must stay in sync.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	AgentRegistry,
	type AgentConfig,
} from "../subagent/agents.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const AGENTS_MD_PATH = join(PROJECT_ROOT, "AGENTS.md");
const SUBAGENT_README_PATH = join(PROJECT_ROOT, "subagent", "README.md");
const BUNDLED_AGENTS_DIR = fileURLToPath(new URL("../subagent/agents/", import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a file or return empty string if missing. */
function readFile(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

/** Load all built-in agent configs from the bundled agents directory. */
function loadBundledAgents(): AgentConfig[] {
	const registry = new AgentRegistry({ cwd: PROJECT_ROOT, scope: "project" });
	registry.discover();
	// Filter to only builtin agents (not project overrides from test temp dirs)
	return registry.agents.filter((a) => a.source === "builtin");
}

/** Extract the "Built-in agent definitions" table rows from AGENTS.md. */
function extractAgentsMdTable(content: string): Array<Record<string, string>> {
	// Find the table after "Built-in agent definitions" heading
	const tableStart = content.indexOf("### `subagent/agents/*.md` — Built-in agent definitions");
	if (tableStart === -1) return [];
	const section = content.slice(tableStart);
	const lines = section.split("\n");

	const rows: Array<Record<string, string>> = [];
	let header: string[] = [];
	let inTable = false;

	for (const line of lines) {
		if (line.startsWith("|") && line.includes("---")) {
			// Separator row
			continue;
		}
		if (line.startsWith("| Agent")) {
			header = line.split("|").map((c) => c.trim()).filter(Boolean);
			inTable = true;
			continue;
		}
		if (inTable && line.startsWith("|")) {
			const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
			if (cells.length === 0 || cells[0] === "") continue;
			const row: Record<string, string> = {};
			for (let i = 0; i < header.length && i < cells.length; i++) {
				// Strip backticks from cell values
				row[header[i].toLowerCase().replace(/`/g, "")] = cells[i].replace(/`/g, "");
			}
			rows.push(row);
		} else if (inTable && !line.startsWith("|")) {
			// End of table
			break;
		}
	}
	return rows;
}

/** Extract the "Included Agents" table rows from subagent/README.md. */
function extractSubagentReadmeTable(content: string): Array<Record<string, string>> {
	const tableStart = content.indexOf("## Included Agents");
	if (tableStart === -1) return [];
	const section = content.slice(tableStart);
	const lines = section.split("\n");

	const rows: Array<Record<string, string>> = [];
	let header: string[] = [];
	let inTable = false;

	for (const line of lines) {
		if (line.startsWith("|") && line.includes("---")) continue;
		if (line.startsWith("| Agent")) {
			header = line.split("|").map((c) => c.trim()).filter(Boolean);
			inTable = true;
			continue;
		}
		if (inTable && line.startsWith("|")) {
			const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
			if (cells.length === 0 || cells[0] === "") continue;
			const row: Record<string, string> = {};
			for (let i = 0; i < header.length && i < cells.length; i++) {
				row[header[i].toLowerCase().replace(/`/g, "")] = cells[i].replace(/`/g, "");
			}
			rows.push(row);
		} else if (inTable && !line.startsWith("|")) {
			break;
		}
	}
	return rows;
}

// ---------------------------------------------------------------------------
// Test: Built-in agent names match between docs and definition files
// ---------------------------------------------------------------------------

describe("docs-as-contract: built-in agent names", () => {
	const actualAgents = loadBundledAgents();
	const agentsMd = readFile(AGENTS_MD_PATH);
	const subagentReadme = readFile(SUBAGENT_README_PATH);

	it("all actual built-in agents are documented in AGENTS.md table", () => {
		const tableRows = extractAgentsMdTable(agentsMd);
		const documentedNames = tableRows.map((r) => r["agent"]);

		for (const agent of actualAgents) {
			expect(documentedNames, `Agent "${agent.name}" is not in AGENTS.md table. Found: ${documentedNames.join(", ")}`).toContain(agent.name);
		}
	});

	it("all agents in AGENTS.md table exist as built-in definition files", () => {
		const tableRows = extractAgentsMdTable(agentsMd);
		const actualNames = new Set(actualAgents.map((a) => a.name));

		for (const row of tableRows) {
			const name = row["agent"];
			expect(actualNames, `AGENTS.md documents agent "${name}" but no built-in definition file exists. Files: ${[...actualNames].join(", ")}`).toContain(name);
		}
	});

	it("all actual built-in agents are documented in subagent/README.md table", () => {
		const tableRows = extractSubagentReadmeTable(subagentReadme);
		const documentedNames = tableRows.map((r) => r["agent"]);

		for (const agent of actualAgents) {
			expect(documentedNames, `Agent "${agent.name}" is not in subagent/README.md table. Found: ${documentedNames.join(", ")}`).toContain(agent.name);
		}
	});

	it("all agents in subagent/README.md table exist as built-in definition files", () => {
		const tableRows = extractSubagentReadmeTable(subagentReadme);
		const actualNames = new Set(actualAgents.map((a) => a.name));

		for (const row of tableRows) {
			const name = row["agent"];
			expect(actualNames, `subagent/README.md documents agent "${name}" but no built-in definition file exists. Files: ${[...actualNames].join(", ")}`).toContain(name);
		}
	});

	it("AGENTS.md and subagent/README.md document the same agent set", () => {
		const agentsMdNames = extractAgentsMdTable(agentsMd).map((r) => r["agent"]).sort();
		const readmeNames = extractSubagentReadmeTable(subagentReadme).map((r) => r["agent"]).sort();
		expect(agentsMdNames).toEqual(readmeNames);
	});
});

// ---------------------------------------------------------------------------
// Test: Documented tool lists match actual agent definitions
// ---------------------------------------------------------------------------

describe("docs-as-contract: documented tool lists match agent definitions", () => {
	const actualAgents = loadBundledAgents();
	const actualByName = new Map(actualAgents.map((a) => [a.name, a]));

	const agentsMd = readFile(AGENTS_MD_PATH);
	const agentsMdTable = extractAgentsMdTable(agentsMd);

	const subagentReadme = readFile(SUBAGENT_README_PATH);
	const subagentReadmeTable = extractSubagentReadmeTable(subagentReadme);

	for (const agent of actualAgents) {
		const agentName = agent.name;
		const actualTools = agent.tools?.sort().join(", ") || "Pi defaults (all tools)";

		it(`AGENTS.md tools for ${agentName} match definition`, () => {
			const docRow = agentsMdTable.find((r) => r["agent"] === agentName);
			expect(docRow, `Agent "${agentName}" not found in AGENTS.md table`).toBeDefined();

			const docTools = docRow!["tools"] || "";
			// "All" in docs means no tools restriction (Pi defaults)
			if (docTools.toLowerCase() === "all") {
				expect(agent.tools, `AGENTS.md says "All" tools for ${agentName} but definition restricts tools to: ${agent.tools?.join(", ")}`).toBeUndefined();
			} else if (docTools.toLowerCase().includes("pi defaults")) {
				expect(agent.tools, `subagent/README.md says "Pi defaults" for ${agentName} but definition restricts tools to: ${agent.tools?.join(", ")}`).toBeUndefined();
			} else {
				// Doc lists specific tools — compare with actual
				const docToolList = docTools.split(",").map((t: string) => t.trim()).sort();
				const actualToolList = agent.tools?.sort() || [];
				expect(actualToolList, `Tool mismatch for ${agentName}: docs say [${docToolList.join(", ")}] but definition says [${actualToolList.join(", ")}]`).toEqual(docToolList);
			}
		});

		it(`subagent/README.md tools for ${agentName} match definition`, () => {
			const docRow = subagentReadmeTable.find((r) => r["agent"] === agentName);
			expect(docRow, `Agent "${agentName}" not found in subagent/README.md table`).toBeDefined();

			const docTools = docRow!["tools"] || "";
			if (docTools.toLowerCase() === "all") {
				expect(agent.tools, `subagent/README.md says "All" tools for ${agentName} but definition restricts tools to: ${agent.tools?.join(", ")}`).toBeUndefined();
			} else if (docTools.toLowerCase().includes("pi defaults")) {
				expect(agent.tools, `subagent/README.md says "Pi defaults" for ${agentName} but definition restricts tools to: ${agent.tools?.join(", ")}`).toBeUndefined();
			} else {
				const docToolList = docTools.split(",").map((t: string) => t.trim()).sort();
				const actualToolList = agent.tools?.sort() || [];
				expect(actualToolList, `Tool mismatch for ${agentName}: docs say [${docToolList.join(", ")}] but definition says [${actualToolList.join(", ")}]`).toEqual(docToolList);
			}
		});
	}
});

// ---------------------------------------------------------------------------
// Test: Documented agent models match actual definitions
// ---------------------------------------------------------------------------

describe("docs-as-contract: documented models match agent definitions", () => {
	const actualAgents = loadBundledAgents();
	const actualByName = new Map(actualAgents.map((a) => [a.name, a]));
	const agentsMdTable = extractAgentsMdTable(readFile(AGENTS_MD_PATH));

	for (const agent of actualAgents) {
		it(`AGENTS.md model for ${agent.name} matches definition`, () => {
			const docRow = agentsMdTable.find((r) => r["agent"] === agent.name);
			expect(docRow, `Agent "${agent.name}" not found in AGENTS.md table`).toBeDefined();
			expect(docRow!["model"] || "", `Model mismatch for ${agent.name}`).toBe(agent.model || "");
		});
	}
});

// ---------------------------------------------------------------------------
// Test: Documented canSpawn values match actual definitions
// ---------------------------------------------------------------------------

describe("docs-as-contract: documented canSpawn matches agent definitions", () => {
	const actualAgents = loadBundledAgents();
	const actualByName = new Map(actualAgents.map((a) => [a.name, a]));
	const agentsMdTable = extractAgentsMdTable(readFile(AGENTS_MD_PATH));

	for (const agent of actualAgents) {
		it(`AGENTS.md canSpawn for ${agent.name} matches definition`, () => {
			const docRow = agentsMdTable.find((r) => r["agent"] === agent.name);
			expect(docRow, `Agent "${agent.name}" not found in AGENTS.md table`).toBeDefined();

			const docCanSpawn = docRow!["canspawn"] || "";
			const actualCanSpawn = agent.canSpawn?.join(", ") || "—";
			// "—" in docs means undefined (no restriction)
			if (docCanSpawn === "—") {
				expect(agent.canSpawn, `AGENTS.md says canSpawn is "—" for ${agent.name} but definition has: [${agent.canSpawn?.join(", ")}]`).toBeUndefined();
			} else {
				const docList = docCanSpawn.split(",").map((s: string) => s.trim()).sort();
				const actualList = (agent.canSpawn || []).sort();
				expect(actualList, `canSpawn mismatch for ${agent.name}: docs say [${docList.join(", ")}] but definition says [${actualList.join(", ")}]`).toEqual(docList);
			}
		});
	}
});

// ---------------------------------------------------------------------------
// Test: Documented commands are registered in the extension
// ---------------------------------------------------------------------------

describe("docs-as-contract: documented commands are registered", () => {
	it("/agent command is documented in AGENTS.md", () => {
		const content = readFile(AGENTS_MD_PATH);
		expect(content).toContain("/agent");
		expect(content).toContain("selects a configured agent persona");
	});

	it("/dump-prompt command is documented in AGENTS.md with ownership clarified", () => {
		const content = readFile(AGENTS_MD_PATH);
		expect(content).toContain("/dump-prompt");
		// Ownership must be unambiguous: either "Implemented by this extension" or
		// explicit statement of which module provides it
		expect(content).toMatch(/Implemented by this extension|provided by|Pi built-in/);
	});

	it("/agent command is documented in subagent/README.md", () => {
		const content = readFile(SUBAGENT_README_PATH);
		expect(content).toContain("/agent");
	});

	it("/dump-prompt command is documented in subagent/README.md", () => {
		const content = readFile(SUBAGENT_README_PATH);
		expect(content).toContain("/dump-prompt");
	});
});

// ---------------------------------------------------------------------------
// Test: No undocumented agent files exist
// ---------------------------------------------------------------------------

describe("docs-as-contract: no undocumented agent definition files", () => {
	const actualAgents = loadBundledAgents();
	const agentsMdTable = extractAgentsMdTable(readFile(AGENTS_MD_PATH));
	const documentedNames = new Set(agentsMdTable.map((r) => r["agent"]));

	// Check that the bundled agents directory contains exactly the documented files
	const dirEntries = readdirSync(BUNDLED_AGENTS_DIR, { withFileTypes: true });
	const mdFiles = dirEntries
		.filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
		.map((e) => e.name.replace(/\.md$/, ""));

	it("every .md file in subagent/agents/ is documented in AGENTS.md", () => {
		for (const fileName of mdFiles) {
			expect(documentedNames, `Agent file "${fileName}.md" exists but is not documented in AGENTS.md`).toContain(fileName);
		}
	});

	it("every documented agent has a corresponding .md file", () => {
		for (const docName of documentedNames) {
			expect(mdFiles, `AGENTS.md documents "${docName}" but no ${docName}.md exists in subagent/agents/`).toContain(docName);
		}
	});
});

// ---------------------------------------------------------------------------
// Test: explorer/scout duplication is resolved
// ---------------------------------------------------------------------------

describe("docs-as-contract: explorer/scout duplication is resolved", () => {
	it("no reference to 'scout' as an agent name in AGENTS.md", () => {
		const content = readFile(AGENTS_MD_PATH);
		// "scout" should not appear as an agent name in the docs
		// but might appear in other contexts (e.g. worker description or historical notes)
		// Check the table doesn't contain scout
		const tableRows = extractAgentsMdTable(content);
		const tableNames = tableRows.map((r) => r["agent"]);
		expect(tableNames).not.toContain("scout");
	});

	it("no reference to 'worker' as an agent name in AGENTS.md", () => {
		const content = readFile(AGENTS_MD_PATH);
		const tableRows = extractAgentsMdTable(content);
		const tableNames = tableRows.map((r) => r["agent"]);
		expect(tableNames).not.toContain("worker");
	});

	it("the bundled agents directory contains explorer.md, not scout.md", () => {
		const entries = readdirSync(BUNDLED_AGENTS_DIR, { withFileTypes: true });
		const names = entries.filter((e) => e.isFile()).map((e) => e.name);
		expect(names).toContain("explorer.md");
		expect(names).not.toContain("scout.md");
	});

	it("the bundled agents directory contains coder.md, not worker.md", () => {
		const entries = readdirSync(BUNDLED_AGENTS_DIR, { withFileTypes: true });
		const names = entries.filter((e) => e.isFile()).map((e) => e.name);
		expect(names).toContain("coder.md");
		expect(names).not.toContain("worker.md");
	});
});

// ---------------------------------------------------------------------------
// Test: Prompt template variables documented match implementation
// ---------------------------------------------------------------------------

describe("docs-as-contract: prompt template variables documented match implementation", () => {
	const REQUIRED_VARS = [
		"tools",
		"guidelines",
		"context_files",
		"skills",
		"cwd",
		"date",
		"agent_name",
		"agent_description",
		"parent_agent_id",
		"depth",
	];

	it("root README.md documents all required template variables", () => {
		const content = readFile(join(PROJECT_ROOT, "README.md"));
		for (const varName of REQUIRED_VARS) {
			expect(content, `README.md missing documentation for {{${varName}}}`).toContain(`{{${varName}}}`);
		}
	});

	it("subagent/README.md documents all required template variables", () => {
		const content = readFile(SUBAGENT_README_PATH);
		for (const varName of REQUIRED_VARS) {
			expect(content, `subagent/README.md missing documentation for {{${varName}}}`).toContain(`{{${varName}}}`);
		}
	});
});
