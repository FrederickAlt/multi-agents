import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionCandidate } from "./extension-filter.js";
import { extensionAliasSet } from "./extension-filter.js";
import { matchesProtectedMultiAgentExtension } from "./protected-extension.js";

const CATALOG_FILE = "extension-catalog.json";
const CATALOG_VERSION = 1;

export interface ExtensionCatalogEntry {
	selector: string;
	identity: string;
	aliases: string[];
}

interface ExtensionCatalogFile {
	version?: number;
	projects?: Record<string, { cwd?: unknown; updatedAt?: unknown; extensions?: unknown }>;
}

function canonicalPath(value: string): string {
	const absolute = path.resolve(value);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

function projectKey(cwd: string): string {
	return createHash("sha256").update(canonicalPath(cwd)).digest("hex").slice(0, 24);
}

function readPackageName(start: string): string | undefined {
	let directory = path.extname(start) ? path.dirname(start) : start;
	while (directory) {
		try {
			const parsed = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
			if (typeof parsed?.name === "string" && parsed.name.trim()) return parsed.name.trim();
		} catch {
			// Continue toward the filesystem root.
		}
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
	return undefined;
}

function sourceName(source: string | undefined): string | undefined {
	if (!source) return undefined;
	const normalized = source.replace(/^npm:/, "").replace(/^git:/, "");
	if (normalized.startsWith("@")) return normalized.split("@").slice(0, 2).join("@");
	const version = normalized.lastIndexOf("@");
	return version > 0 ? normalized.slice(0, version) : normalized;
}

function preferredName(candidate: ExtensionCandidate, identity: string): string {
	const metadata = candidate.sourceInfo ?? candidate.metadata;
	if (metadata?.origin === "package") {
		return readPackageName(metadata.baseDir ?? identity) ?? sourceName(metadata.source) ?? path.basename(identity);
	}
	const fileName = path.basename(identity);
	return path.basename(fileName, path.extname(fileName));
}

function isProtected(candidate: ExtensionCandidate): boolean {
	return [...extensionAliasSet(candidate)].some(matchesProtectedMultiAgentExtension);
}

/** Build one selectable record per resolved extension identity. */
export function buildExtensionCatalog(candidates: ExtensionCandidate[]): ExtensionCatalogEntry[] {
	const byIdentity = new Map<string, { candidate: ExtensionCandidate; aliases: Set<string>; name: string }>();
	for (const candidate of candidates) {
		if (candidate.enabled === false || isProtected(candidate)) continue;
		const rawIdentity = candidate.resolvedPath || candidate.path;
		if (!rawIdentity || rawIdentity.startsWith("<")) continue;
		const identity = canonicalPath(rawIdentity);
		const existing = byIdentity.get(identity);
		if (existing) {
			for (const alias of extensionAliasSet(candidate)) existing.aliases.add(alias);
			continue;
		}
		byIdentity.set(identity, {
			candidate,
			aliases: extensionAliasSet(candidate),
			name: preferredName(candidate, identity),
		});
	}

	const nameCounts = new Map<string, number>();
	for (const value of byIdentity.values()) nameCounts.set(value.name, (nameCounts.get(value.name) ?? 0) + 1);
	return [...byIdentity.entries()]
		.map(([identity, value]) => {
			// A resolved path is already a supported selector and remains unambiguous
			// when two distinct extensions intentionally share a package name.
			const selector = nameCounts.get(value.name) === 1 ? value.name : identity;
			value.aliases.add(selector);
			value.aliases.add(identity);
			return { selector, identity, aliases: [...value.aliases].filter(Boolean).sort() };
		})
		.sort((a, b) => a.selector.localeCompare(b.selector));
}

export function writeExtensionCatalog(agentDir: string, cwd: string, candidates: ExtensionCandidate[]): void {
	const target = path.join(agentDir, CATALOG_FILE);
	const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	try {
		let parsed: ExtensionCatalogFile = {};
		try {
			parsed = JSON.parse(readFileSync(target, "utf8"));
		} catch {
			// Start a new catalogue.
		}
		const projects = parsed.version === CATALOG_VERSION && parsed.projects ? parsed.projects : {};
		projects[projectKey(cwd)] = {
			cwd: canonicalPath(cwd),
			updatedAt: new Date().toISOString(),
			extensions: buildExtensionCatalog(candidates),
		};
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(temporary, `${JSON.stringify({ version: CATALOG_VERSION, projects }, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(temporary, target);
	} catch {
		try {
			unlinkSync(temporary);
		} catch {
			// Best-effort cleanup.
		}
	}
}

export function readExtensionCatalog(agentDir: string, cwd: string): ExtensionCatalogEntry[] | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path.join(agentDir, CATALOG_FILE), "utf8")) as ExtensionCatalogFile;
		const extensions =
			parsed.version === CATALOG_VERSION ? parsed.projects?.[projectKey(cwd)]?.extensions : undefined;
		if (!Array.isArray(extensions)) return undefined;
		return extensions.filter(
			(entry): entry is ExtensionCatalogEntry =>
				Boolean(entry) &&
				typeof entry === "object" &&
				typeof entry.selector === "string" &&
				typeof entry.identity === "string" &&
				Array.isArray(entry.aliases),
		);
	} catch {
		return undefined;
	}
}
