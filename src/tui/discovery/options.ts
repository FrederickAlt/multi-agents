import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { DiscoveredOptions, ModelOption } from "../state/types.js";

// ---------------------------------------------------------------------------
// Model reference helpers
// ---------------------------------------------------------------------------

/** Compute canonical runtime-reference for every model.
 *  Bare modelId when unique across providers, otherwise `provider/modelId`. */
export function computeCanonicalModelRefs(models: ModelOption[]): void {
	// Count how many providers expose each modelId
	const idCounts = new Map<string, number>();
	for (const m of models) {
		idCounts.set(m.modelId, (idCounts.get(m.modelId) ?? 0) + 1);
	}
	for (const m of models) {
		const isUnique = idCounts.get(m.modelId) === 1;
		m.canonicalRef = isUnique ? m.modelId : `${m.provider}/${m.modelId}`;
	}
}

/**
 * Resolve a stored model value (bare ID, canonical ref, or display name)
 * to the best-matching display name for the TUI dropdown.
 * Returns undefined if no model matches.
 */
export function resolveModelDisplayName(
	value: string | undefined,
	models: ModelOption[],
): string | undefined {
	if (!value) return undefined;
	// Try exact match by canonicalRef
	let match = models.find((m) => m.canonicalRef === value);
	if (match) return match.displayName;
	// Try exact match by modelId
	match = models.find((m) => m.modelId === value);
	if (match) return match.displayName;
	// Try exact match by displayName
	match = models.find((m) => m.displayName === value);
	if (match) return match.displayName;
	// Try constructed provider/modelId match (e.g. "deepseek/deepseek-v4")
	match = models.find((m) => `${m.provider}/${m.modelId}` === value);
	if (match) return match.displayName;
	return undefined;
}

/**
 * Map a display name back to the canonical runtime reference.
 * Returns undefined if no model matches the display name.
 */
export function modelDisplayNameToCanonicalRef(
	displayName: string,
	models: ModelOption[],
): string | undefined {
	const match = models.find((m) => m.displayName === displayName);
	return match?.canonicalRef;
}

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
 * Discover models using Pi's ModelRegistry. The config TUI is standalone, so
 * the Pi package may not be locally installed next to this extension. In that
 * case, fall back to the installed `pi --list-models` command before using the
 * tiny static built-in list.
 */
export interface DiscoveredModelsResult {
	models: ModelOption[];
	defaultModelDisplayName: string;
	status: "ready" | "degraded";
	error?: string;
}

type PiCodingAgentModule = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	AuthStorage?: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ModelRegistry?: any;
};

export async function discoverModels(agentDir: string): Promise<DiscoveredModelsResult> {
	try {
		const pcg = await importPiCodingAgent();
		return discoverModelsFromPiPackage(pcg, agentDir);
	} catch (packageErr) {
		try {
			return discoverModelsFromPiCli(agentDir);
		} catch (cliErr) {
			const builtin = getBuiltInModels();
			return {
				models: builtin,
				defaultModelDisplayName: builtin[0]?.displayName ?? "",
				status: "degraded",
				error: `Pi model discovery failed: ${formatError(packageErr)}; pi --list-models failed: ${formatError(cliErr)}`,
			};
		}
	}
}

async function importPiCodingAgent(): Promise<PiCodingAgentModule> {
	const errors: string[] = [];
	for (const specifier of [
		"@earendil-works/pi-coding-agent",
		"@mariozechner/pi-coding-agent",
	]) {
		try {
			return await import(specifier);
		} catch (err) {
			errors.push(`${specifier}: ${formatError(err)}`);
		}
	}

	const installedIndex = resolveInstalledPiIndex();
	if (installedIndex) {
		try {
			return await import(pathToFileURL(installedIndex).href);
		} catch (err) {
			errors.push(`${installedIndex}: ${formatError(err)}`);
		}
	}

	throw new Error(errors.join("; ") || "Pi package not found");
}

function resolveInstalledPiIndex(): string | undefined {
	try {
		const piPath = execFileSync("which", ["pi"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim().split(/\r?\n/)[0];
		if (!piPath) return undefined;

		const realPiPath = fs.realpathSync(piPath);
		const packageRoot = path.dirname(path.dirname(realPiPath));
		const indexPath = path.join(packageRoot, "dist", "index.js");
		return fs.existsSync(indexPath) ? indexPath : undefined;
	} catch {
		return undefined;
	}
}

function discoverModelsFromPiPackage(
	pcg: PiCodingAgentModule,
	agentDir: string,
): DiscoveredModelsResult {
	const AuthStorage = pcg.AuthStorage;
	const ModelRegistry = pcg.ModelRegistry;
	if (!AuthStorage || !ModelRegistry) {
		throw new Error("Pi package does not export AuthStorage and ModelRegistry");
	}

	const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
	const modelsJsonPath = path.join(agentDir, "models.json");
	const registry = typeof ModelRegistry.create === "function"
		? ModelRegistry.create(authStorage, modelsJsonPath)
		: new ModelRegistry(authStorage, modelsJsonPath);
	registry.refresh?.();

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const allModels: ModelOption[] = registry.getAll().map((m: any) => ({
		provider: m.provider ?? "",
		modelId: m.id ?? m.modelId ?? "",
		displayName: m.name ?? m.id ?? `${m.provider}/${m.id}`,
		canonicalRef: "", // populated below
	})).filter((m: ModelOption) => m.modelId.length > 0);
	computeCanonicalModelRefs(allModels);

	let defaultModelDisplayName = "";
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const available = registry.getAvailable?.() as any[] | undefined;
		if (available && available.length > 0) {
			const firstProvider: string = available[0].provider ?? "";
			const firstId: string = available[0].id ?? available[0].modelId;
			const match = allModels.find(
				(m) => m.provider === firstProvider && m.modelId === firstId,
			) ?? allModels.find((m) => m.modelId === firstId);
			if (match) defaultModelDisplayName = match.displayName;
		}
	} catch {
		// getAvailable may not exist on older registry versions
	}

	if (!defaultModelDisplayName && allModels.length > 0) {
		defaultModelDisplayName = allModels[0].displayName;
	}

	return {
		models: allModels,
		defaultModelDisplayName,
		status: "ready",
		error: undefined,
	};
}

export function discoverModelsFromPiCli(
	agentDir: string,
	piCommand = "pi",
): DiscoveredModelsResult {
	const result = spawnSync(piCommand, ["--list-models"], {
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		maxBuffer: 10 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `pi --list-models exited ${result.status}`);
	}
	// Pi's list-models renderer writes to stderr in some terminal modes; parse both.
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	const models = parsePiListModelsOutput(output);
	if (models.length === 0) {
		throw new Error("pi --list-models returned no parseable models");
	}
	computeCanonicalModelRefs(models);
	return {
		models,
		defaultModelDisplayName: models[0]?.displayName ?? "",
		status: "ready",
		error: undefined,
	};
}

export function parsePiListModelsOutput(output: string): ModelOption[] {
	const models: ModelOption[] = [];
	for (const rawLine of output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("Warning:")) continue;
		const match = line.match(/^(\S+)\s+(\S+)(?:\s+|$)/);
		if (!match) continue;
		const [, provider, modelId] = match;
		if (provider === "provider" && modelId === "model") continue;
		models.push({
			provider,
			modelId,
			displayName: modelId,
			canonicalRef: "",
		});
	}
	return models;
}

function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function getBuiltInModels(): ModelOption[] {
	const models: ModelOption[] = [
		{ provider: "anthropic", modelId: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4", canonicalRef: "" },
		{ provider: "anthropic", modelId: "claude-opus-4-20250514", displayName: "Claude Opus 4", canonicalRef: "" },
		{ provider: "anthropic", modelId: "claude-haiku-4-5-20250514", displayName: "Claude Haiku 4.5", canonicalRef: "" },
		{ provider: "openai", modelId: "gpt-5", displayName: "GPT-5", canonicalRef: "" },
	];
	computeCanonicalModelRefs(models);
	return models;
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
				(e.isFile() || e.isSymbolicLink()) &&
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
				(e.isFile() || e.isSymbolicLink()) &&
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
	const { models, defaultModelDisplayName, status, error } = await discoverModels(agentDir);
	return {
		tools: discoverTools(agentDir, agentToolLists),
		extensions: discoverExtensions(agentDir),
		models,
		defaultModel: defaultModelDisplayName,
		modelDiscovery: {
			status,
			error,
		},
		reasoningEfforts: ["low", "medium", "high", "maximum"],
		depths: [0, 1, 2, 3, 4, 5],
		canSpawn: allAgentNames,
		skills: discoverSkills(agentDir),
		promptParts: discoverPromptParts(agentDir),
	};
}
