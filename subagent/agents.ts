/**
 * AgentRegistry for Sub-agent discovery and lookup.
 *
 * Owns cwd-aware discovery, bundled/user/project precedence,
 * validation diagnostics for skipped definitions, lookup by name,
 * and formatted agent lists for user-facing messages.
 *
 * Compatibility wrappers (discoverAgents, formatAgentList) preserve
 * the existing public API for callers that don't need diagnostics.
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

/**
 * Describes why a Sub-agent definition file was skipped or produced a warning.
 * Consumers can inspect these to provide feedback (e.g. surface in UI or logs).
 */
export interface AgentDiagnostic {
	filePath: string;
	level: "error" | "warn";
	reason: string;
}

export interface AgentRegistryOptions {
	cwd: string;
	scope?: AgentScope;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

function loadAgentsFromDir(
	dir: string,
	source: AgentSource,
	diagnostics: AgentDiagnostic[],
): AgentConfig[] {
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

		// Agent name is derived from the filename stem, not from a frontmatter field.
		const name = path.basename(entry.name, ".md");
		if (name.startsWith(".")) {
			diagnostics.push({
				filePath,
				level: "warn",
				reason: `Hidden file "${entry.name}" is skipped; agent names must not start with a dot.`,
			});
			continue;
		}

		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch (err) {
			diagnostics.push({
				filePath,
				level: "error",
				reason: `Cannot read file: ${(err as Error).message}`,
			});
			continue;
		}

		let frontmatter: Record<string, string | number>;
		let body: string;
		try {
			const parsed = parseFrontmatter<Record<string, string | number>>(content);
			frontmatter = parsed.frontmatter;
			body = parsed.body;
		} catch (err) {
			diagnostics.push({
				filePath,
				level: "error",
				reason: `Malformed YAML frontmatter: ${(err as Error).message}`,
			});
			continue;
		}

		if (!frontmatter.description) {
			diagnostics.push({
				filePath,
				level: "error",
				reason: `Missing required "description" field in frontmatter.`,
			});
			continue;
		}

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

// ---------------------------------------------------------------------------
// AgentRegistry
// ---------------------------------------------------------------------------

const BUNDLED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

/**
 * Encapsulates Sub-agent discovery and lookup.
 *
 * Create an instance with a cwd and scope, then call .discover() to run
 * discovery. After discovery, inspect .agents, .find(name), .formatList(),
 * and .diagnostics to see why certain definitions were skipped.
 *
 * ```ts
 * const registry = new AgentRegistry({ cwd: process.cwd(), scope: "both" });
 * registry.discover();
 * const scout = registry.find("scout");
 * console.log(registry.diagnostics); // skipped-file reasons
 * ```
 */
export class AgentRegistry {
	private _cwd: string;
	private _scope: AgentScope;
	private _agents: AgentConfig[];
	private _projectAgentsDir: string | null;
	private _diagnostics: AgentDiagnostic[];
	private _discovered: boolean;

	constructor(options: AgentRegistryOptions) {
		this._cwd = options.cwd;
		this._scope = options.scope ?? "both";
		this._agents = [];
		this._projectAgentsDir = null;
		this._diagnostics = [];
		this._discovered = false;
	}

	/**
	 * Run (or re-run) agent discovery. Collects diagnostics for any
	 * definition files that were skipped. Returns this for chaining.
	 */
	discover(): this {
		this._diagnostics = [];

		const userDir = path.join(getAgentDir(), "agents");
		const projectAgentsDir = findNearestProjectAgentsDir(this._cwd);

		const bundledAgents = loadAgentsFromDir(BUNDLED_DIR, "builtin", this._diagnostics);
		const userAgents = this._scope === "project"
			? []
			: loadAgentsFromDir(userDir, "user", this._diagnostics);
		const projectAgents = this._scope === "user" || !projectAgentsDir
			? []
			: loadAgentsFromDir(projectAgentsDir, "project", this._diagnostics);

		const agentMap = new Map<string, AgentConfig>();

		// Bundled agents are always the base layer.
		for (const agent of bundledAgents) agentMap.set(agent.name, agent);

		// User agents override bundled; project agents override both.
		if (this._scope === "both" || this._scope === "user") {
			for (const agent of userAgents) agentMap.set(agent.name, agent);
		}
		if (this._scope === "both" || this._scope === "project") {
			for (const agent of projectAgents) agentMap.set(agent.name, agent);
		}

		this._agents = Array.from(agentMap.values());
		this._projectAgentsDir = projectAgentsDir;
		this._discovered = true;
		return this;
	}

	/**
	 * All discovered agents (after .discover() has been called).
	 * Throws if discovery has not been run yet.
	 */
	get agents(): AgentConfig[] {
		this._ensureDiscovered();
		return this._agents;
	}

	/**
	 * Diagnostics collected during the last .discover() call.
	 * Each entry describes a definition file that was skipped or produced a warning.
	 */
	get diagnostics(): readonly AgentDiagnostic[] {
		return this._diagnostics;
	}

	/**
	 * The nearest .pi/agents directory found during discovery, or null.
	 */
	get projectAgentsDir(): string | null {
		this._ensureDiscovered();
		return this._projectAgentsDir;
	}

	/**
	 * Find an agent by name (case-sensitive match against the filename stem).
	 * Returns undefined if no agent with that name was discovered.
	 */
	find(name: string): AgentConfig | undefined {
		return this.agents.find((agent) => agent.name === name);
	}

	/**
	 * Format the agent list for user-facing messages.
	 * Returns at most `maxItems` entries, with a count of remaining agents.
	 */
	formatList(maxItems: number): { text: string; remaining: number } {
		return formatAgentList(this.agents, maxItems);
	}

	/** Re-discover with a different working directory. */
	setCwd(cwd: string): void {
		this._cwd = cwd;
		this._discovered = false;
	}

	/** Change the scope for the next discover() call. */
	setScope(scope: AgentScope): void {
		this._scope = scope;
		this._discovered = false;
	}

	private _ensureDiscovered(): void {
		if (!this._discovered) {
			throw new Error(
				"AgentRegistry has not been initialized. Call .discover() before accessing agents.",
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Compatibility wrappers — preserve the existing public API
// ---------------------------------------------------------------------------

/**
 * Discover available Sub-agent definitions.
 *
 * Compatibility wrapper that creates a temporary AgentRegistry, runs
 * discovery, and returns the result. For access to diagnostics use
 * the AgentRegistry class directly.
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const registry = new AgentRegistry({ cwd, scope });
	registry.discover();
	return { agents: registry.agents, projectAgentsDir: registry.projectAgentsDir };
}

/**
 * Format a list of AgentConfig entries for user-facing messages.
 *
 * This function is stateless and does not depend on AgentRegistry.
 */
export function formatAgentList(
	agents: AgentConfig[],
	maxItems: number,
): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
