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

export interface ConfiguredExtensionDiscovery {
	extensions: string[];
	disabledExtensions: string[];
	extensionAliases: ExtensionAliasMap;
}

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

const TOOL_EXTENSION_CACHE_FILE = "tool-extension-cache.json";
const TOOL_EXTENSION_CACHE_VERSION = 1;

type ToolExtensionCacheFile = {
	version?: number;
	updatedAt?: string;
	tools?: Record<string, { extensions?: unknown; updatedAt?: unknown }>;
	extensions?: unknown;
	extensionAliases?: unknown;
};

function addUniqueNames(target: string[], values: Iterable<string | undefined>): void {
	for (const value of values) {
		addUniqueName(target, value);
	}
}

function sortedUnique(values: Iterable<string | undefined>): string[] {
	return [
		...new Set([...values].filter((value): value is string => typeof value === "string" && value.length > 0)),
	].sort();
}

function cacheFilePath(agentDir: string): string {
	return path.join(agentDir, TOOL_EXTENSION_CACHE_FILE);
}

function readStringArray(value: unknown): string[] {
	return Array.isArray(value) ? sortedUnique(value.map((item) => String(item))) : [];
}

/**
 * Reads the last successfully observed mapping between runtime tools and the
 * extensions that provided them. This lets the TUI show and filter tools from
 * config-dependent extensions even before/without a successful runtime scan.
 */
export function discoverCachedPiRuntimeResources(agentDir: string): PiRuntimeDiscovery {
	const parsed = readJsonObject(cacheFilePath(agentDir)) as ToolExtensionCacheFile | undefined;
	const toolExtensionNames: Record<string, string[]> = {};
	const toolNames: string[] = [];
	if (parsed?.version === TOOL_EXTENSION_CACHE_VERSION && parsed.tools && typeof parsed.tools === "object") {
		for (const [toolName, entry] of Object.entries(parsed.tools)) {
			const extensions = readStringArray(entry?.extensions);
			if (toolName && extensions.length > 0) {
				addUniqueName(toolNames, toolName);
				toolExtensionNames[toolName] = extensions;
			}
		}
	}

	const extensionAliases: ExtensionAliasMap = {};
	if (
		parsed?.extensionAliases &&
		typeof parsed.extensionAliases === "object" &&
		!Array.isArray(parsed.extensionAliases)
	) {
		for (const [extensionName, aliases] of Object.entries(parsed.extensionAliases)) {
			const values = readStringArray(aliases);
			if (extensionName && values.length > 0) extensionAliases[extensionName] = values;
		}
	}

	const extensions = sortedUnique([
		...readStringArray(parsed?.extensions),
		...Object.keys(extensionAliases),
		...Object.values(toolExtensionNames).flat(),
	]);

	return {
		tools: sortedUnique(toolNames),
		toolExtensionNames,
		extensions,
		extensionAliases,
		skills: [],
	};
}

function mergeExtensionAliases(...maps: Array<ExtensionAliasMap | undefined>): ExtensionAliasMap {
	const merged: ExtensionAliasMap = {};
	for (const map of maps) {
		for (const [extensionName, aliases] of Object.entries(map ?? {})) {
			const values = merged[extensionName] ?? [];
			addUniqueNames(values, aliases);
			merged[extensionName] = values;
		}
	}
	return merged;
}

function mergeToolExtensionNames(...maps: Array<Record<string, string[]> | undefined>): Record<string, string[]> {
	const merged: Record<string, string[]> = {};
	for (const map of maps) {
		for (const [toolName, extensions] of Object.entries(map ?? {})) {
			const values = merged[toolName] ?? [];
			addUniqueNames(values, extensions);
			merged[toolName] = values;
		}
	}
	return merged;
}

export function mergePiRuntimeDiscoveries(
	base: PiRuntimeDiscovery | undefined,
	override: PiRuntimeDiscovery | undefined,
): PiRuntimeDiscovery | undefined {
	if (!base) return override;
	if (!override) return base;
	return {
		tools: sortedUnique([...base.tools, ...override.tools]),
		toolExtensionNames: mergeToolExtensionNames(base.toolExtensionNames, override.toolExtensionNames),
		extensions: sortedUnique([...base.extensions, ...override.extensions]),
		extensionAliases: mergeExtensionAliases(base.extensionAliases, override.extensionAliases),
		skills: sortedUnique([...base.skills, ...override.skills]),
	};
}

function writeToolExtensionCache(agentDir: string, discovery: PiRuntimeDiscovery): void {
	const existing = discoverCachedPiRuntimeResources(agentDir);
	const merged = mergePiRuntimeDiscoveries(existing, discovery) ?? discovery;
	const now = new Date().toISOString();
	const tools: NonNullable<ToolExtensionCacheFile["tools"]> = {};
	for (const [toolName, extensions] of Object.entries(merged.toolExtensionNames)) {
		if (BUILTIN_TOOLS.includes(toolName) || extensions.length === 0) continue;
		tools[toolName] = { extensions: sortedUnique(extensions), updatedAt: now };
	}
	try {
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			cacheFilePath(agentDir),
			`${JSON.stringify(
				{
					version: TOOL_EXTENSION_CACHE_VERSION,
					updatedAt: now,
					tools,
					extensions: sortedUnique(merged.extensions),
					extensionAliases: mergeExtensionAliases(merged.extensionAliases),
				},
				null,
				2,
			)}\n`,
		);
	} catch {
		// Cache writes are best-effort; runtime discovery should still succeed.
	}
}

async function importPiCodingAgent(): Promise<PiCodingAgentApi> {
	const piPath = execFileSync("which", ["pi"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	})
		.trim()
		.split(/\r?\n/)[0];
	if (!piPath) throw new Error("Pi executable not found");

	const realPiPath = fs.realpathSync(piPath);
	const packageRoot = path.dirname(path.dirname(realPiPath));
	const indexPath = path.join(packageRoot, "dist", "index.js");
	if (!fs.existsSync(indexPath)) throw new Error(`Pi package entry point not found: ${indexPath}`);
	return (await import(pathToFileURL(indexPath).href)) as PiCodingAgentApi;
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
	const cached = discoverCachedPiRuntimeResources(agentDir);
	let pi: PiCodingAgentApi;
	try {
		pi = (await importPiCodingAgent()) as PiCodingAgentApi;
	} catch {
		return cached.tools.length > 0 ? cached : undefined;
	}
	if (!pi.DefaultResourceLoader) return cached.tools.length > 0 ? cached : undefined;

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

	const runtimeDiscovery: PiRuntimeDiscovery = {
		tools: [...toolSet].sort(),
		toolExtensionNames,
		extensions: [...extensionSet].sort(),
		extensionAliases,
		skills: [...skillSet].sort(),
	};
	const mergedDiscovery = mergePiRuntimeDiscoveries(cached, runtimeDiscovery) ?? runtimeDiscovery;
	writeToolExtensionCache(agentDir, mergedDiscovery);
	return mergedDiscovery;
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

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function normalizeConfiguredPath(input: string, baseDir: string): string {
	const trimmed = input.trim();
	if (trimmed.startsWith("~")) return path.join(process.env.HOME || "", trimmed.slice(1));
	return path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed);
}

function configuredSourceDisplayName(source: string, baseDir: string): string | undefined {
	const trimmed = source.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("npm:") || trimmed.startsWith("git:") || /^https?:\/\//.test(trimmed)) {
		return displayNameFromPackageSource(trimmed);
	}
	const resolved = normalizeConfiguredPath(trimmed, baseDir);
	try {
		const packageName = readPackageName(fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved));
		if (packageName) return packageName;
	} catch {
		// Fall through to path-derived display name for missing/stale local package entries.
	}
	return path.basename(resolved, path.extname(resolved));
}

function readManifestExtensionEntries(packageRoot: string): string[] {
	const packageJsonPath = path.join(packageRoot, "package.json");
	const packageJson = readJsonObject(packageJsonPath) as { pi?: { extensions?: unknown } } | undefined;
	const entries = packageJson?.pi?.extensions;
	if (!Array.isArray(entries)) return [];
	return entries.map(String).filter((entry) => entry.trim() && !/^[!+-]/.test(entry.trim()));
}

function collectKnownPackageExtensionEntries(source: string, baseDir: string): string[] {
	const resolved = normalizeConfiguredPath(source, baseDir);
	try {
		const stats = fs.statSync(resolved);
		if (stats.isFile()) return [resolved];
		if (!stats.isDirectory()) return [];

		const manifestEntries = readManifestExtensionEntries(resolved).map((entry) => path.resolve(resolved, entry));
		if (manifestEntries.length > 0) return manifestEntries;

		const indexTs = path.join(resolved, "index.ts");
		const indexJs = path.join(resolved, "index.js");
		return [indexTs, indexJs].filter((entry) => fs.existsSync(entry));
	} catch {
		return [];
	}
}

function packageExtensionPatternDisablesPath(extensionPath: string, packageRoot: string, rawPattern: string): boolean {
	const pattern = rawPattern.trim();
	if (!pattern.startsWith("-")) return false;
	const value = pattern.slice(1).replace(/\\/g, "/");
	const relativePath = path.relative(packageRoot, extensionPath).replace(/\\/g, "/");
	const basename = path.basename(extensionPath);
	return value === relativePath || value === basename || value === extensionPath.replace(/\\/g, "/");
}

function packageExtensionFiltersDisableAll(source: string, baseDir: string, filters: string[]): boolean {
	if (filters.length === 0) return true;
	if (filters.some((filter) => !/^[!-]/.test(filter.trim()))) return false;

	const knownEntries = collectKnownPackageExtensionEntries(source, baseDir);
	if (knownEntries.length === 0) return filters.every((filter) => /^[!-]/.test(filter.trim()));

	const packageRoot = normalizeConfiguredPath(source, baseDir);
	return knownEntries.every((entry) =>
		filters.some((filter) => packageExtensionPatternDisablesPath(entry, packageRoot, filter)),
	);
}

function addConfiguredExtension(
	result: ConfiguredExtensionDiscovery,
	name: string | undefined,
	aliases: Array<string | undefined>,
	disabled: boolean,
): void {
	if (!name) return;
	addUniqueName(result.extensions, name);
	if (disabled) addUniqueName(result.disabledExtensions, name);
	const merged = result.extensionAliases[name] ?? [];
	for (const alias of [name, ...aliases]) addUniqueName(merged, alias);
	result.extensionAliases[name] = merged;
}

function collectConfiguredExtensionsFromSettings(
	settings: Record<string, unknown> | undefined,
	baseDir: string,
	result: ConfiguredExtensionDiscovery,
): void {
	const packages = settings?.packages;
	if (Array.isArray(packages)) {
		for (const entry of packages) {
			const source =
				typeof entry === "string"
					? entry
					: entry && typeof entry === "object"
						? String((entry as { source?: unknown }).source ?? "")
						: "";
			if (!source) continue;
			const filters =
				entry && typeof entry === "object" && Array.isArray((entry as { extensions?: unknown }).extensions)
					? (entry as { extensions: unknown[] }).extensions.map(String)
					: undefined;
			const name = configuredSourceDisplayName(source, baseDir);
			addConfiguredExtension(
				result,
				name,
				[source, path.basename(source)],
				filters ? packageExtensionFiltersDisableAll(source, baseDir, filters) : false,
			);
		}
	}

	const extensions = settings?.extensions;
	if (Array.isArray(extensions)) {
		for (const raw of extensions) {
			const value = String(raw).trim();
			if (!value || /^[!+-]/.test(value)) continue;
			const resolved = normalizeConfiguredPath(value, baseDir);
			addConfiguredExtension(result, path.basename(resolved, path.extname(resolved)), [value, resolved], false);
		}
	}
}

/**
 * Discover extension option names from both auto-discovered extension files and
 * configured package entries. Disabled package entries are included in
 * `extensions` and listed in `disabledExtensions` so stale settings do not hide
 * from the TUI.
 */
export function discoverConfiguredExtensions(agentDir: string, cwd = process.cwd()): ConfiguredExtensionDiscovery {
	const result: ConfiguredExtensionDiscovery = {
		extensions: discoverExtensions(agentDir),
		disabledExtensions: [],
		extensionAliases: {},
	};
	for (const name of result.extensions) {
		result.extensionAliases[name] = [name];
	}

	collectConfiguredExtensionsFromSettings(readJsonObject(path.join(agentDir, "settings.json")), agentDir, result);
	collectConfiguredExtensionsFromSettings(
		readJsonObject(path.join(cwd, ".pi", "settings.json")),
		path.join(cwd, ".pi"),
		result,
	);

	result.extensions.sort();
	result.disabledExtensions.sort();
	return result;
}

// ---------------------------------------------------------------------------
// Models Discovery
// ---------------------------------------------------------------------------

/** Discover models exclusively from the installed `pi` executable. */
export interface DiscoveredModelsResult {
	models: ModelOption[];
	defaultModelDisplayName: string;
	status: "ready" | "degraded";
	error?: string;
}

export async function discoverModels(agentDir: string, piCommand = "pi"): Promise<DiscoveredModelsResult> {
	try {
		return discoverModelsFromPiCli(agentDir, piCommand);
	} catch (err) {
		return {
			models: [],
			defaultModelDisplayName: "",
			status: "degraded",
			error: `pi --list-models failed: ${formatError(err)}`,
		};
	}
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
