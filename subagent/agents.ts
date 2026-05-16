/**
 * AgentRegistry for Sub-agent discovery and lookup.
 *
 * Owns cwd-aware discovery, bundled/user/project precedence,
 * validation diagnostics for skipped definitions, lookup by name,
 * and formatted agent lists for user-facing messages.
 *
 * Internally delegates to the generic markdown-definitions loader
 * for directory walking and frontmatter parsing, then maps raw
 * definitions to agent-specific configs.
 *
 * Compatibility wrappers (discoverAgents, formatAgentList) preserve
 * the existing public API for callers that don't need diagnostics.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type RawMarkdownDefinition,
	type MarkdownDiagnostic,
	discoverMarkdownDefinitions,
} from "./markdown-definitions.js";

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
	/**
	 * Skill prompt filtering with tri-state semantics.
	 * - `undefined` (field missing) → all inherited skill prompt content
	 * - `[]` (blank value) → no skill prompt content
	 * - `["skill1", "skill2"]` → only matching named skill prompt content
	 */
	skills?: string[];
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
// Mapping helpers — RawMarkdownDefinition -> AgentConfig
// ---------------------------------------------------------------------------

// Path to the bundled agents directory, relative to this source file.
const BUNDLED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

/**
 * Map a generic RawMarkdownDefinition to an agent-specific AgentConfig.
 *
 * Parses agent-specific frontmatter fields (tools, extensions, model,
 * reasoning_effort, depth, canSpawn, skills) from the raw frontmatter map.
 */
function mapToAgentConfig(raw: RawMarkdownDefinition): AgentConfig {
	const fm = raw.frontmatter;

	const tools = String(fm.tools ?? "")
		.split(",")
		.map((t: string) => t.trim())
		.filter(Boolean);
	const extensions = String(fm.extensions ?? "")
		.split(",")
		.map((t: string) => t.trim())
		.filter(Boolean);
	const canSpawn = String(fm.canSpawn ?? "")
		.split(",")
		.map((t: string) => t.trim())
		.filter(Boolean);

	// skills: tri-state — undefined when missing, [] when blank, string[] when values
	let skills: string[] | undefined;
	if (fm.skills === undefined || fm.skills === null) {
		// Null (from bare `skills:` in YAML) is treated as blank → []
		skills = fm.skills === undefined ? undefined : [];
	} else {
		const raw = String(fm.skills).trim();
		skills = raw.length > 0
			? raw.split(",").map((s: string) => s.trim()).filter(Boolean)
			: [];
	}

	const reasoningEffort = fm.reasoning_effort ? String(fm.reasoning_effort) : undefined;
	const rawDepth = fm.depth;
	const depth =
		rawDepth === undefined || rawDepth === ""
			? undefined
			: typeof rawDepth === "number"
				? rawDepth
				: Number.parseInt(String(rawDepth), 10);

	return {
		name: raw.name,
		description: raw.description,
		reasoningEffort,
		tools: tools.length > 0 ? tools : undefined,
		extensions: extensions.length > 0 ? extensions : undefined,
		model: fm.model ? String(fm.model) : undefined,
		depth: Number.isFinite(depth) ? depth : undefined,
		canSpawn: canSpawn.length > 0 ? canSpawn : undefined,
		skills,
		systemPrompt: raw.body,
		source: raw.source,
		filePath: raw.filePath,
	};
}

/** Map a generic MarkdownDiagnostic to an agent-specific AgentDiagnostic. */
function mapToAgentDiagnostic(d: MarkdownDiagnostic): AgentDiagnostic {
	return { filePath: d.filePath, level: d.level, reason: d.reason };
}

// ---------------------------------------------------------------------------
// AgentRegistry
// ---------------------------------------------------------------------------

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
 * const explorer = registry.find("explorer");
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
	 * Run (or re-run) agent discovery. Delegates to the generic
	 * markdown-definitions loader, then maps raw definitions to
	 * agent-specific configs. Returns this for chaining.
	 */
	discover(): this {
		const result = discoverMarkdownDefinitions({
			cwd: this._cwd,
			scope: this._scope,
			bundledDir: BUNDLED_DIR,
			userSubdir: "agents",
			projectSubdir: "agents",
		});

		this._agents = result.definitions.map(mapToAgentConfig);
		this._diagnostics = result.diagnostics.map(mapToAgentDiagnostic);
		this._projectAgentsDir = result.projectDir;
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
