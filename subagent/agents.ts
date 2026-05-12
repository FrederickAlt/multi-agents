/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "builtin" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	extensions?: string[];
	model?: string;
	/** Thinking/reasoning effort level for the model. Maps to ThinkingLevel from pi-ai. */
	reasoningEffort?: string;
	depth?: number;
	canSpawn?: string[];
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		let frontmatter: Record<string, string | number>;
		let body: string;
		try {
			const parsed = parseFrontmatter<Record<string, string | number>>(content);
			frontmatter = parsed.frontmatter;
			body = parsed.body;
		} catch {
			// Skip files with malformed YAML frontmatter.
			continue;
		}

		if (!frontmatter.description) {
			continue;
		}

		// Agent name is derived from the filename stem, not from a frontmatter field.
		// This makes agent discovery predictable: the file you drop in is the agent you get.
		const name = path.basename(entry.name, ".md");
		if (name.startsWith(".")) continue; // skip hidden files

		const tools = String(frontmatter.tools ?? "")
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);
		const extensions = String(frontmatter.extensions ?? "")
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);
		const canSpawn = String(frontmatter.canSpawn ?? "")
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		const reasoningEffort = frontmatter.reasoning_effort ? String(frontmatter.reasoning_effort) : undefined;
		const rawDepth = frontmatter.depth;
		const depth =
			rawDepth === undefined || rawDepth === ""
				? undefined
				: typeof rawDepth === "number"
					? rawDepth
					: Number.parseInt(String(rawDepth), 10);

		agents.push({
			name,
			description: String(frontmatter.description),
			reasoningEffort,
			tools: tools && tools.length > 0 ? tools : undefined,
			extensions: extensions && extensions.length > 0 ? extensions : undefined,
			model: frontmatter.model ? String(frontmatter.model) : undefined,
			depth: Number.isFinite(depth) ? depth : undefined,
			canSpawn: canSpawn && canSpawn.length > 0 ? canSpawn : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const bundledDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const bundledAgents = loadAgentsFromDir(bundledDir, "builtin");
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	for (const agent of bundledAgents) agentMap.set(agent.name, agent);
	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
