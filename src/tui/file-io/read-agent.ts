import * as fs from "node:fs";
import * as path from "node:path";
import { aliasesMatchSelector } from "../../subagent/extension-filter.js";
import { parseFrontmatter } from "../pi-compat.js";
import type { AgentConfigState } from "../state/types.js";

/**
 * Read and parse a single agent .md file into an AgentConfigState.
 *
 * Uses the TUI's standalone frontmatter parser to parse the YAML
 * frontmatter block. The markdown body is preserved but never
 * modified by the TUI.
 */
export function readAgent(filePath: string): AgentConfigState {
	const name = path.basename(filePath, ".md");

	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch (err) {
		return {
			name,
			description: "",
			filePath,
			frontmatter: null,
			body: "",
			error: `Cannot read file: ${(err as Error).message}`,
			staleItems: {},
		};
	}

	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(content);
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch (err) {
		return {
			name,
			description: "",
			filePath,
			frontmatter: null,
			body: content,
			error: `Invalid YAML: ${(err as Error).message}`,
			staleItems: {},
		};
	}

	const description = frontmatter.description ? String(frontmatter.description) : "";

	return {
		name,
		description,
		filePath,
		frontmatter,
		body,
		error: null,
		staleItems: {},
	};
}

/**
 * Scan the agents directory and read all agent markdown files.
 * Returns an array of AgentConfigState, one per .md file.
 */
export function scanAgents(agentDir: string): AgentConfigState[] {
	const agentsDir = path.join(agentDir, "agents");
	if (!fs.existsSync(agentsDir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(agentsDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfigState[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (entry.name.startsWith(".")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(agentsDir, entry.name);
		agents.push(readAgent(filePath));
	}

	return agents;
}

/**
 * Detect stale items in checkbox fields by comparing against discovered options.
 */
export function detectStaleItems(
	agents: AgentConfigState[],
	allAgentNames: string[],
	availableTools: string[],
	availableExtensions: string[],
	availableSkills: string[],
	availablePromptParts: string[],
	extensionAliases?: Record<string, string[]>,
): void {
	const agentNameSet = new Set(allAgentNames);
	const toolsSet = new Set(availableTools);
	const extSet = new Set(availableExtensions);
	const skillsSet = new Set(availableSkills);
	const ppSet = new Set(availablePromptParts);

	for (const agent of agents) {
		const fm = agent.frontmatter;
		if (!fm) continue;

		agent.staleItems = {};

		checkStale(fm.tools, toolsSet, agent, "tools");
		checkStale(fm.extensions, extSet, agent, "extensions", extensionAliases);
		checkStale(fm.can_spawn, agentNameSet, agent, "can_spawn");
		checkStale(fm.skills, skillsSet, agent, "skills");
		checkStale(fm.prompt_parts, ppSet, agent, "prompt_parts");
	}
}

function checkStale(
	raw: unknown,
	valid: Set<string>,
	agent: AgentConfigState,
	fieldName: string,
	extensionAliases?: Record<string, string[]>,
): void {
	if (raw === undefined || raw === null) return;
	const items = Array.isArray(raw) ? raw.map(String) : [String(raw)];
	const stale = items.filter((item) => {
		if (!item) return false;
		if (valid.has(item)) return false;
		if (fieldName === "extensions" && extensionAliases) {
			return !Object.values(extensionAliases).some((aliases) => aliasesMatchSelector(item, aliases));
		}
		return true;
	});
	if (stale.length > 0) {
		agent.staleItems[fieldName] = stale;
	}
}
