import * as fs from "node:fs";
import * as path from "node:path";
import type { DiscoveredOptions, ModelOption } from "../state/types.js";

// ---------------------------------------------------------------------------
// Tools Discovery
// ---------------------------------------------------------------------------

/** Built-in Pi tool names (hardcoded from pi-coding-agent SDK). */
const BUILTIN_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"Task",
];

/**
 * Discover available tools.
 * Combines built-in tool names with any tool names found in existing agent definitions.
 */
export function discoverTools(
	agentDir: string,
	agentToolLists: string[][],
): string[] {
	const toolSet = new Set(BUILTIN_TOOLS);

	// Collect from existing agent definitions
	for (const tools of agentToolLists) {
		for (const t of tools) {
			toolSet.add(t);
		}
	}

	return [...toolSet].sort();
}

// ---------------------------------------------------------------------------
// Extensions Discovery
// ---------------------------------------------------------------------------

/**
 * Discover extensions from ~/.pi/agent/extensions/.
 * Returns basenames of directories and files (stripped of extensions).
 */
export function discoverExtensions(agentDir: string): string[] {
	const extDir = path.join(agentDir, "extensions");
	if (!fs.existsSync(extDir)) return [];

	const entries = fs.readdirSync(extDir, { withFileTypes: true });
	const names: string[] = [];
	for (const e of entries) {
		if (e.isDirectory()) {
			names.push(e.name);
		} else if (e.isFile()) {
			names.push(path.basename(e.name, path.extname(e.name)));
		}
	}
	return [...new Set(names)].sort();
}

// ---------------------------------------------------------------------------
// Models Discovery
// ---------------------------------------------------------------------------

/**
 * Discover models using ModelRegistry from @mariozechner/pi-coding-agent.
 * Falls back to built-in models if registry fails or package is unavailable.
 */
export async function discoverModels(agentDir: string): Promise<ModelOption[]> {
	try {
		const pcg = await import("@mariozechner/pi-coding-agent");
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const AuthStorage = (pcg as any).AuthStorage;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const ModelRegistry = (pcg as any).ModelRegistry;

		if (!AuthStorage || !ModelRegistry) {
			return getBuiltInModels();
		}

		const authStorage = AuthStorage.create(
			path.join(agentDir, "auth.json"),
		);
		const registry = new ModelRegistry(
			authStorage,
			path.join(agentDir, "models.json"),
		);
		registry.refresh();

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return registry.getAll().map((m: any) => ({
			provider: m.provider ?? "",
			modelId: m.id ?? "",
			displayName: m.name ?? `${m.provider}/${m.id}`,
		}));
	} catch {
		// Fall back to built-in models
		return getBuiltInModels();
	}
}

function getBuiltInModels(): ModelOption[] {
	return [
		{ provider: "anthropic", modelId: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
		{ provider: "anthropic", modelId: "claude-opus-4-20250514", displayName: "Claude Opus 4" },
		{ provider: "anthropic", modelId: "claude-haiku-4-5-20250514", displayName: "Claude Haiku 4.5" },
		{ provider: "openai", modelId: "gpt-5", displayName: "GPT-5" },
	];
}

// ---------------------------------------------------------------------------
// Can Spawn Discovery
// ---------------------------------------------------------------------------

/**
 * Discover spawnable agent names from ~/.pi/agent/agents/*.md.
 * Excludes the agent itself (selfName).
 */
export function discoverCanSpawn(
	agentDir: string,
	selfName: string,
): string[] {
	const agentsDir = path.join(agentDir, "agents");
	if (!fs.existsSync(agentsDir)) return [];

	const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
	return entries
		.filter(
			(e) =>
				e.isFile() &&
				e.name.endsWith(".md") &&
				!e.name.startsWith("."),
		)
		.map((e) => path.basename(e.name, ".md"))
		.filter((name) => name !== selfName)
		.sort();
}

/**
 * Discover all agent names (for the full can_spawn option list).
 */
export function discoverAllAgentNames(agentDir: string): string[] {
	const agentsDir = path.join(agentDir, "agents");
	if (!fs.existsSync(agentsDir)) return [];

	const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
	return entries
		.filter(
			(e) =>
				e.isFile() &&
				e.name.endsWith(".md") &&
				!e.name.startsWith("."),
		)
		.map((e) => path.basename(e.name, ".md"))
		.sort();
}

// ---------------------------------------------------------------------------
// Skills Discovery
// ---------------------------------------------------------------------------

/**
 * Discover skills from ~/.pi/agent/skills/<name>/SKILL.md.
 * Skill name is the parent directory name.
 */
export function discoverSkills(agentDir: string): string[] {
	const skillsDir = path.join(agentDir, "skills");
	if (!fs.existsSync(skillsDir)) return [];

	const result: string[] = [];
	for (const entry of fs.readdirSync(skillsDir, {
		withFileTypes: true,
	})) {
		if (!entry.isDirectory()) continue;
		const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
		if (fs.existsSync(skillFile)) {
			result.push(entry.name);
		}
	}
	return result.sort();
}

// ---------------------------------------------------------------------------
// Prompt Parts Discovery
// ---------------------------------------------------------------------------

/**
 * Discover prompt parts from ~/.pi/agent/prompt-parts/*.md.
 * Name is the filename stem.
 */
export function discoverPromptParts(agentDir: string): string[] {
	const ppDir = path.join(agentDir, "prompt-parts");
	if (!fs.existsSync(ppDir)) return [];

	return fs
		.readdirSync(ppDir, { withFileTypes: true })
		.filter(
			(e) =>
				e.isFile() &&
				e.name.endsWith(".md") &&
				!e.name.startsWith("."),
		)
		.map((e) => path.basename(e.name, ".md"))
		.sort();
}

// ---------------------------------------------------------------------------
// Discovery Orchestration
// ---------------------------------------------------------------------------

/**
 * Run all discovery functions and return DiscoveredOptions.
 */
export async function discoverAllOptions(
	agentDir: string,
	agentToolLists: string[][],
	allAgentNames: string[],
): Promise<DiscoveredOptions> {
	return {
		tools: discoverTools(agentDir, agentToolLists),
		extensions: discoverExtensions(agentDir),
		models: await discoverModels(agentDir),
		reasoningEfforts: ["low", "medium", "high", "maximum"],
		depths: [0, 1, 2, 3, 4, 5],
		canSpawn: allAgentNames,
		skills: discoverSkills(agentDir),
		promptParts: discoverPromptParts(agentDir),
	};
}
