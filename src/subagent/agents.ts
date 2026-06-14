/**
 * AgentRegistry for Sub-agent discovery and lookup.
 *
 * Owns user-level agent discovery from ~/.pi/agent/agents/,
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

import {
	discoverMarkdownDefinitions,
	type MarkdownDiagnostic,
	type RawMarkdownDefinition,
} from "./markdown-definitions.js";

/** Source origin of an agent definition.
 * `"user"` is the only source returned at runtime; `"builtin"` and
 * `"project"` are reserved for future seeding/registration. */
export type AgentSource = "builtin" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	/** Tool whitelist. Missing or blank field means use Pi defaults; explicit [] means no tools. */
	tools?: string[];
	/** Extension allowlist. Missing or blank field means unrestricted; explicit [] means no extensions. */
	extensions?: string[];
	model?: string;
	/** Thinking/reasoning effort level for the model. Maps to ThinkingLevel from pi-ai. */
	reasoningEffort?: string;
	depth?: number;
	/**
	 * Spawn allowlist with tri-state semantics.
	 * - `undefined` (field missing) → unrestricted
	 * - `[]` (blank value) → no spawnable agents
	 * - `["agent1", "agent2"]` → only those agent types
	 */
	can_spawn?: string[];
	/**
	 * Skill prompt filtering with tri-state semantics.
	 * - `undefined` (field missing) → all inherited skill prompt content
	 * - `[]` (blank value) → no skill prompt content
	 * - `["skill1", "skill2"]` → only matching named skill prompt content
	 */
	skills?: string[];
	/**
	 * Prompt-part filtering with tri-state semantics.
	 * - `undefined` (field missing) → all prompt parts included
	 * - `[]` (blank value) → no prompt parts included
	 * - `["010-tools", "020-runtime-context"]` → only those named parts
	 */
	prompt_parts?: string[];
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

export interface AgentRegistryOptions {}

// ---------------------------------------------------------------------------
// Mapping helpers — RawMarkdownDefinition -> AgentConfig
// ---------------------------------------------------------------------------

// Helper: parse a checkbox field value to string[] | undefined with tri-state semantics.
// - undefined → field is missing (unrestricted)
// - null or empty array → empty array (none allowed)
// - array → use directly
// - any other type → empty array
function parseCheckboxField(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (value === null) return [];
	if (Array.isArray(value)) {
		const items = value.map((v: unknown) => String(v).trim()).filter(Boolean);
		return items.length > 0 ? items : [];
	}
	return [];
}

function parseRuntimeResourceField(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (Array.isArray(value)) {
		const items = value.map((v: unknown) => String(v).trim()).filter(Boolean);
		return items.length > 0 ? items : [];
	}
	if (typeof value === "string") {
		const items = value
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean);
		return items.length > 0 ? items : undefined;
	}
	return [];
}

function parseAgentDepth(rawDepth: unknown, filePath: string, warnings: AgentDiagnostic[]): number | undefined {
	if (rawDepth === undefined || rawDepth === null || rawDepth === "") {
		return undefined;
	}

	if (typeof rawDepth === "number") {
		if (Number.isSafeInteger(rawDepth) && rawDepth >= 0) return rawDepth;
		warnings.push({
			filePath,
			level: "warn",
			reason: `Invalid depth value in ${filePath}: ${rawDepth} is not a valid non-negative integer. Using 0.`,
		});
		return 0;
	}

	if (typeof rawDepth === "string") {
		const trimmed = rawDepth.trim();
		if (trimmed === "") return undefined;
		if (/^-?\d+$/.test(trimmed)) {
			const parsed = Number.parseInt(trimmed, 10);
			if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
		}
		warnings.push({
			filePath,
			level: "warn",
			reason: `Invalid depth value in ${filePath}: ${rawDepth} is not a valid non-negative integer. Using 0.`,
		});
		return 0;
	}

	warnings.push({
		filePath,
		level: "warn",
		reason: `Invalid depth value in ${filePath}: ${String(rawDepth)} is not a valid non-negative integer. Using 0.`,
	});
	return 0;
}

/**
 * Map a generic RawMarkdownDefinition to an agent-specific AgentConfig.
 *
 * Parses agent-specific frontmatter fields (tools, extensions, model,
 * reasoning_effort, depth, can_spawn, skills, prompt_parts) from the raw frontmatter map.
 */
function mapToAgentConfig(raw: RawMarkdownDefinition, warnings: AgentDiagnostic[]): AgentConfig {
	const fm = raw.frontmatter;

	const tools = parseRuntimeResourceField(fm.tools);
	const extensions = parseRuntimeResourceField(fm.extensions);
	const can_spawn = parseCheckboxField(fm.can_spawn);
	const skills = parseCheckboxField(fm.skills);
	const prompt_parts = parseCheckboxField(fm.prompt_parts);

	const reasoningEffort = fm.reasoning_effort ? String(fm.reasoning_effort) : undefined;
	const depth = parseAgentDepth(fm.depth, raw.filePath, warnings);

	return {
		name: raw.name,
		description: raw.description,
		reasoningEffort,
		tools,
		extensions,
		model: fm.model ? String(fm.model) : undefined,
		depth,
		can_spawn,
		skills,
		prompt_parts,
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
 * Create an instance, then call .discover() to run
 * discovery. After discovery, inspect .agents, .find(name), .formatList(),
 * and .diagnostics to see why certain definitions were skipped.
 *
 * ```ts
 * const registry = new AgentRegistry();
 * registry.discover();
 * const explorer = registry.find("explorer");
 * console.log(registry.diagnostics); // skipped-file reasons
 * ```
 */
export class AgentRegistry {
	private _agents: AgentConfig[];
	private _projectAgentsDir: string | null;
	private _diagnostics: AgentDiagnostic[];
	private _discovered: boolean;

	constructor(_options?: AgentRegistryOptions) {
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
			userSubdir: "agents",
		});

		this._diagnostics = result.diagnostics.map(mapToAgentDiagnostic);
		this._agents = result.definitions.map((definition) => mapToAgentConfig(definition, this._diagnostics));
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
	 * Always returns null. Project directory scanning is no longer used;
	 * agents are discovered from ~/.pi/agent/agents/.
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

	private _ensureDiscovered(): void {
		if (!this._discovered) {
			throw new Error("AgentRegistry has not been initialized. Call .discover() before accessing agents.");
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
export function discoverAgents(): AgentDiscoveryResult {
	const registry = new AgentRegistry();
	registry.discover();
	return { agents: registry.agents, projectAgentsDir: registry.projectAgentsDir };
}

/**
 * Format a list of AgentConfig entries for user-facing messages.
 *
 * This function is stateless and does not depend on AgentRegistry.
 */
export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
