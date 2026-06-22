import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { extensionAliasSet } from "../../subagent/extension-filter.js";
import type { ModelOption } from "../state/types.js";

type LoadedPiExtension = {
	path?: string;
	resolvedPath?: string;
	sourceInfo?: {
		source?: string;
		origin?: string;
		scope?: string;
		baseDir?: string;
	};
	metadata?: {
		source?: string;
		baseDir?: string;
	};
	tools?: Map<string, unknown>;
};

type PiResourceLoader = {
	reload(): Promise<void>;
	getExtensions(): { extensions?: LoadedPiExtension[] };
	getSkills(): { skills?: Array<{ name?: string }> };
};

type PiSession = {
	bindExtensions(bindings: { onError?: (error: unknown) => void }): Promise<void>;
	getAllTools(): Array<{ name?: string; sourceInfo?: LoadedPiExtension["sourceInfo"] }>;
	resourceLoader?: PiResourceLoader;
	extensionRunner?: {
		emit?(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
		shutdown?(): void;
	};
	dispose?(): void;
};

type PiCodingAgentApi = {
	DefaultResourceLoader?: new (options: {
		cwd: string;
		agentDir: string;
		settingsManager?: unknown;
	}) => PiResourceLoader;
	SettingsManager?: { create(cwd?: string, agentDir?: string): unknown };
	SessionManager?: { create(cwd: string, sessionDir?: string): unknown };
	createAgentSession?: (options: {
		cwd: string;
		agentDir: string;
		settingsManager?: unknown;
		sessionManager?: unknown;
	}) => Promise<{ session: PiSession; extensionsResult?: { extensions?: LoadedPiExtension[] } }>;
};

// ---------------------------------------------------------------------------
// Pi runtime resource helpers
// ---------------------------------------------------------------------------

function stripTsJsExtension(filePath: string): string {
	return path.basename(filePath, path.extname(filePath));
}

function displayNameFromPackageSource(source: string): string {
	let s = source.replace(/^npm:/, "");
	if (s.startsWith("git:")) s = s.slice(4);

	if (s.startsWith("@")) {
		const parts = s.split("@");
		return parts.length > 2 ? `@${parts[1]}` : s;
	}

	if (/^https?:\/\//.test(s) || /^ssh:\/\//.test(s)) {
		s = s.replace(/\.git(?:@[^/]+)?$/, "");
		const urlTail = s.split(/[/:]/).filter(Boolean).pop();
		return urlTail ?? source;
	}

	if (s.includes(path.sep) || s.startsWith(".")) {
		return path.basename(s);
	}

	const atIndex = s.lastIndexOf("@");
	if (atIndex > 0) s = s.slice(0, atIndex);
	return s;
}

function readPackageName(baseDir: string | undefined): string | undefined {
	if (!baseDir) return undefined;
	try {
		const packageJson = JSON.parse(fs.readFileSync(path.join(baseDir, "package.json"), "utf-8"));
		return typeof packageJson.name === "string" && packageJson.name.trim() ? packageJson.name.trim() : undefined;
	} catch {
		return undefined;
	}
}

function addUniqueName(target: string[], value: string | undefined): void {
	if (value && !target.includes(value)) target.push(value);
}

function getExtensionNameCandidates(extension: {
	path?: string;
	resolvedPath?: string;
	sourceInfo?: { source?: string; origin?: string; baseDir?: string };
}): string[] {
	const candidates: string[] = [];
	const displayName = displayNameFromExtension(extension);
	addUniqueName(candidates, displayName);
	addUniqueName(candidates, extension.sourceInfo?.source);
	addUniqueName(candidates, extension.path ? path.basename(extension.path) : undefined);
	addUniqueName(candidates, extension.resolvedPath ? path.basename(extension.resolvedPath) : undefined);
	addUniqueName(candidates, extension.resolvedPath ? path.basename(path.dirname(extension.resolvedPath)) : undefined);
	return candidates;
}

export type ExtensionAliasMap = Record<string, string[]>;

function addUniqueNameToAliasSet(
	aliasesByExtension: ExtensionAliasMap,
	extensionName: string | undefined,
	aliases: string[],
) {
	if (!extensionName) return;
	if (aliases.length === 0) return;
	const merged = aliasesByExtension[extensionName] ?? [];
	for (const alias of aliases) {
		addUniqueName(merged, alias);
	}
	aliasesByExtension[extensionName] = merged;
}

function displayNameFromExtension(extension: {
	path?: string;
	resolvedPath?: string;
	sourceInfo?: { source?: string; origin?: string; baseDir?: string };
}): string | undefined {
	const source = extension.sourceInfo?.source;
	if (extension.sourceInfo?.origin === "package") {
		return (
			readPackageName(extension.sourceInfo.baseDir) ?? (source ? displayNameFromPackageSource(source) : undefined)
		);
	}

	const p = extension.resolvedPath || extension.path;
	if (!p) return source;
	const fileName = path.basename(p);
	const stem = stripTsJsExtension(p);
	if (fileName === "index.ts" || fileName === "index.js") {
		return path.basename(path.dirname(p));
	}
	return stem;
}

export interface PiRuntimeDiscovery {
	tools: string[];
	toolExtensionNames: Record<string, string[]>;
	extensions: string[];
	extensionAliases?: ExtensionAliasMap;
	skills: string[];
}

/**
 * Discover enabled resources the same way Pi does for `pi config`/startup.
 * Falls back silently when the Pi package is unavailable so the standalone TUI
 * still works from a fresh checkout.
 */
export async function discoverPiRuntimeResources(
	agentDir: string,
	_agentToolLists: string[][],
	cwd = process.cwd(),
): Promise<PiRuntimeDiscovery | undefined> {
	let pi: PiCodingAgentApi;
	try {
		pi = (await importPiCodingAgent()) as PiCodingAgentApi;
	} catch {
		return undefined;
	}
	if (!pi.DefaultResourceLoader) return undefined;

	const settingsManager = pi.SettingsManager?.create?.(cwd, agentDir);
	let loader: PiResourceLoader | undefined;
	let dynamicTools: Array<{ name: string; sourceInfo?: LoadedPiExtension["sourceInfo"] }> = [];

	if (pi.createAgentSession && pi.SessionManager?.create) {
		const tempSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-config-session-"));
		let session: PiSession | undefined;
		try {
			const sessionManager = pi.SessionManager.create(cwd, path.join(tempSessionDir, "sessions"));
			const result = await pi.createAgentSession({ cwd, agentDir, settingsManager, sessionManager });
			session = result.session;
			await session.bindExtensions({ onError: () => undefined });
			dynamicTools = session
				.getAllTools()
				.map((tool) => ({ name: String(tool.name ?? ""), sourceInfo: tool.sourceInfo }))
				.filter((tool) => tool.name.length > 0);
			loader = session.resourceLoader;
		} catch {
			// Fall back to resource-loader-only discovery below.
		} finally {
			try {
				await session?.extensionRunner?.emit?.({ type: "session_shutdown", reason: "quit" });
				session?.extensionRunner?.shutdown?.();
			} catch {
				// Best effort cleanup for extensions that opened resources during session_start.
			}
			session?.dispose?.();
			fs.rmSync(tempSessionDir, { recursive: true, force: true });
		}
	}

	if (!loader) {
		loader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();
	}

	const toolSet = new Set(BUILTIN_TOOLS);
	const toolExtensionNames: Record<string, string[]> = {};
	for (const tool of dynamicTools) toolSet.add(tool.name);

	const extensionSet = new Set<string>();
	const extensionAliases: ExtensionAliasMap = {};
	const extensions = loader.getExtensions().extensions ?? [];
	const sourceToExtensionCandidates = new Map<string, string[]>();
	for (const extension of extensions) {
		const extensionName = displayNameFromExtension(extension);
		if (extensionName) extensionSet.add(extensionName);
		const candidates = getExtensionNameCandidates(extension);
		const aliasCandidates = [
			...extensionAliasSet({
				path: extension.path,
				resolvedPath: extension.resolvedPath,
				sourceInfo: extension.sourceInfo,
				metadata: extension.metadata,
			}),
		];
		addUniqueNameToAliasSet(extensionAliases, extensionName, aliasCandidates);
		const source = extension.sourceInfo?.source;
		if (source) sourceToExtensionCandidates.set(source, candidates);
		if (extension.path) sourceToExtensionCandidates.set(extension.path, candidates);
		if (extension.resolvedPath) sourceToExtensionCandidates.set(extension.resolvedPath, candidates);
		for (const toolName of extension.tools?.keys?.() ?? []) {
			const name = String(toolName);
			toolSet.add(name);
			if (!BUILTIN_TOOLS.includes(name) && candidates.length > 0) {
				toolExtensionNames[name] = candidates;
			}
		}
	}
	for (const tool of dynamicTools) {
		const source = tool.sourceInfo?.source;
		if (BUILTIN_TOOLS.includes(tool.name) || !source || source === "builtin" || source === "sdk") continue;
		const candidates = sourceToExtensionCandidates.get(source) ?? [source];
		toolExtensionNames[tool.name] = candidates;
	}

	const skillSet = new Set<string>();
	for (const skill of loader.getSkills().skills ?? []) {
		if (skill.name) skillSet.add(String(skill.name));
	}

	return {
		tools: [...toolSet].sort(),
		toolExtensionNames,
		extensions: [...extensionSet].sort(),
		extensionAliases,
		skills: [...skillSet].sort(),
	};
}

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

function modelDisplayBase(model: ModelOption): string {
	const fallback =
		model.provider && model.modelId ? `${model.provider}/${model.modelId}` : model.modelId || model.provider;
	return (model.displayName || fallback).trim();
}

function withModelQualifier(base: string, qualifier: string): string {
	const trimmedQualifier = qualifier.trim();
	if (!trimmedQualifier || base === trimmedQualifier) return base;
	return `${base} (${trimmedQualifier})`;
}

/**
 * Keep model labels unique for dropdown selection. Pi can expose the same model
 * name from multiple providers, and the TUI uses displayName as the selected
 * item key, so duplicate labels would otherwise be indistinguishable.
 */
function compareModelOptionsByProvider(a: ModelOption, b: ModelOption): number {
	return (
		a.provider.localeCompare(b.provider) ||
		a.displayName.localeCompare(b.displayName) ||
		a.modelId.localeCompare(b.modelId) ||
		a.canonicalRef.localeCompare(b.canonicalRef)
	);
}

export function orderModelsByProvider(models: ModelOption[]): void {
	models.sort(compareModelOptionsByProvider);
}

export function disambiguateModelDisplayNames(models: ModelOption[]): void {
	const baseNames = models.map(modelDisplayBase);
	const baseCounts = new Map<string, number>();
	for (const base of baseNames) {
		baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
	}

	const providerQualified = baseNames.map((base, index) => {
		if (baseCounts.get(base) === 1) return base;
		const model = models[index];
		return withModelQualifier(base, model?.provider ?? "");
	});
	const providerQualifiedCounts = new Map<string, number>();
	for (const name of providerQualified) {
		providerQualifiedCounts.set(name, (providerQualifiedCounts.get(name) ?? 0) + 1);
	}

	const finalCounts = new Map<string, number>();
	for (let index = 0; index < models.length; index += 1) {
		const model = models[index];
		const base = baseNames[index] ?? "";
		let displayName = providerQualified[index] ?? base;
		if (baseCounts.get(base)! > 1 && providerQualifiedCounts.get(displayName)! > 1) {
			const qualifier =
				model.provider && model.modelId
					? `${model.provider}/${model.modelId}`
					: model.canonicalRef || model.modelId || model.provider;
			displayName = withModelQualifier(base, qualifier);
		}

		const seen = finalCounts.get(displayName) ?? 0;
		finalCounts.set(displayName, seen + 1);
		model.displayName = seen === 0 ? displayName : `${displayName} #${seen + 1}`;
	}
}

/**
 * Resolve a stored model value (bare ID, canonical ref, or display name)
 * to the best-matching display name for the TUI dropdown.
 * Returns undefined if no model matches or if a bare/display value is ambiguous.
 */
export function resolveModelDisplayName(value: string | undefined, models: ModelOption[]): string | undefined {
	if (!value) return undefined;
	// Try exact match by canonicalRef.
	let match = models.find((m) => m.canonicalRef === value);
	if (match) return match.displayName;

	// Bare model IDs and display names are only safe when they identify one model.
	let matches = models.filter((m) => m.modelId === value);
	if (matches.length === 1) return matches[0]!.displayName;
	matches = models.filter((m) => m.displayName === value);
	if (matches.length === 1) return matches[0]!.displayName;

	// Try constructed provider/modelId match (e.g. "deepseek/deepseek-v4").
	match = models.find((m) => `${m.provider}/${m.modelId}` === value);
	if (match) return match.displayName;
	return undefined;
}

/**
 * Map a display name back to the canonical runtime reference.
 * Returns undefined if no model matches the display name.
 */
export function modelDisplayNameToCanonicalRef(displayName: string, models: ModelOption[]): string | undefined {
	const matches = models.filter((m) => m.displayName === displayName);
	return matches.length === 1 ? matches[0]!.canonicalRef : undefined;
}

// ---------------------------------------------------------------------------
// Tools Discovery
// ---------------------------------------------------------------------------

/** Built-in Pi tool names (hardcoded from pi-coding-agent SDK). */
const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "Task"];

/**
 * Discover available tools.
 * Fallback discovery only knows Pi's built-in tools; agent-declared values are
 * not availability evidence because that would hide stale tool references.
 */
export function discoverTools(_agentDir: string, _agentToolLists: string[][]): string[] {
	const toolSet = new Set(BUILTIN_TOOLS);
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
	for (const specifier of ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"]) {
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
		})
			.trim()
			.split(/\r?\n/)[0];
		if (!piPath) return undefined;

		const realPiPath = fs.realpathSync(piPath);
		const packageRoot = path.dirname(path.dirname(realPiPath));
		const indexPath = path.join(packageRoot, "dist", "index.js");
		return fs.existsSync(indexPath) ? indexPath : undefined;
	} catch {
		return undefined;
	}
}

function discoverModelsFromPiPackage(pcg: PiCodingAgentModule, agentDir: string): DiscoveredModelsResult {
	const AuthStorage = pcg.AuthStorage;
	const ModelRegistry = pcg.ModelRegistry;
	if (!AuthStorage || !ModelRegistry) {
		throw new Error("Pi package does not export AuthStorage and ModelRegistry");
	}

	const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
	const modelsJsonPath = path.join(agentDir, "models.json");
	const registry =
		typeof ModelRegistry.create === "function"
			? ModelRegistry.create(authStorage, modelsJsonPath)
			: new ModelRegistry(authStorage, modelsJsonPath);
	registry.refresh?.();

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const allModels: ModelOption[] = registry
		.getAll()
		.map((m: any) => ({
			provider: m.provider ?? "",
			modelId: m.id ?? m.modelId ?? "",
			displayName: m.name ?? m.id ?? `${m.provider}/${m.id}`,
			canonicalRef: "", // populated below
		}))
		.filter((m: ModelOption) => m.modelId.length > 0);
	computeCanonicalModelRefs(allModels);
	disambiguateModelDisplayNames(allModels);
	orderModelsByProvider(allModels);

	let defaultModelDisplayName = "";
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const available = registry.getAvailable?.() as any[] | undefined;
		if (available && available.length > 0) {
			const firstProvider: string = available[0].provider ?? "";
			const firstId: string = available[0].id ?? available[0].modelId;
			const match =
				allModels.find((m) => m.provider === firstProvider && m.modelId === firstId) ??
				allModels.find((m) => m.modelId === firstId);
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

export function discoverModelsFromPiCli(agentDir: string, piCommand = "pi"): DiscoveredModelsResult {
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
	disambiguateModelDisplayNames(models);
	orderModelsByProvider(models);
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
		{
			provider: "anthropic",
			modelId: "claude-haiku-4-5-20250514",
			displayName: "Claude Haiku 4.5",
			canonicalRef: "",
		},
		{ provider: "openai", modelId: "gpt-5", displayName: "GPT-5", canonicalRef: "" },
	];
	computeCanonicalModelRefs(models);
	disambiguateModelDisplayNames(models);
	orderModelsByProvider(models);
	return models;
}

// ---------------------------------------------------------------------------
// Can Spawn Discovery
// ---------------------------------------------------------------------------

/**
 * Discover spawnable agent names from ~/.pi/agent/agents/*.md.
 * Includes the agent itself; self-spawn is a valid configuration.
 */
export function discoverCanSpawn(agentDir: string, _selfName: string): string[] {
	const agentsDir = path.join(agentDir, "agents");
	if (!fs.existsSync(agentsDir)) return [];

	const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
	return entries
		.filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".md") && !e.name.startsWith("."))
		.map((e) => path.basename(e.name, ".md"))
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
		.filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".md") && !e.name.startsWith("."))
		.map((e) => path.basename(e.name, ".md"))
		.sort();
}

// ---------------------------------------------------------------------------
// Skills Discovery
// ---------------------------------------------------------------------------

/**
 * Discover skills from any SKILL.md/skill.md file under ~/.pi/agent/skills/.
 * Skill name is the parent directory name.
 */
export function discoverSkills(agentDir: string): string[] {
	const skillsDir = path.join(agentDir, "skills");
	if (!fs.existsSync(skillsDir)) return [];

	const result = new Set<string>();
	const visit = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(entryPath);
			} else if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
				result.add(path.basename(dir));
			}
		}
	};

	visit(skillsDir);
	return [...result].sort();
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
		.filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
		.map((e) => path.basename(e.name, ".md"))
		.sort();
}
