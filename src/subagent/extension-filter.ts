import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./agents.js";
import { matchesProtectedMultiAgentExtension } from "./protected-extension.js";

interface ExtensionCandidate {
	path?: string;
	resolvedPath?: string;
	sourceInfo?: {
		source?: string;
		baseDir?: string;
	};
	metadata?: {
		source?: string;
		baseDir?: string;
	};
}

export interface ExtensionSelection {
	paths: string[];
	warnings: string[];
}

export interface ExtensionFilterOptions {
	/**
	 * Optional callback for selector diagnostics (no-match/ambiguous outcomes).
	 * Useful for surfaces that can forward warnings to task/session logging.
	 */
	onWarnings?: (warnings: string[]) => void;
}

function canonicalExistingPath(p: string): string {
	if (!p || p.startsWith("<")) return p;
	const resolved = path.resolve(p);
	try {
		return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
	} catch {
		return resolved;
	}
}

function sameExtensionPath(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	if (a.startsWith("<") || b.startsWith("<")) return false;
	return canonicalExistingPath(a) === canonicalExistingPath(b);
}

function normalizeComparisonPath(value: string): string {
	const normalized = value.replace(/\\/g, "/").trim();
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalizePath(value: string): string {
	if (!value) return "";
	try {
		const absolute = path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
		return process.platform === "win32" ? absolute.toLowerCase() : absolute;
	} catch {
		return process.platform === "win32" ? value.toLowerCase() : value;
	}
}

function addCandidateAlias(aliases: Set<string>, candidateValue: string | undefined): void {
	if (!candidateValue) return;
	aliases.add(normalizeComparisonPath(candidateValue));
}

function addCandidateAliasPath(aliases: Set<string>, candidatePath: string | undefined): void {
	if (!candidatePath) return;
	aliases.add(canonicalizePath(candidatePath));
}

export function extensionAliasSet(candidate: ExtensionCandidate): Set<string> {
	const aliases = new Set<string>();
	addCandidateAlias(aliases, candidate.path);
	addCandidateAlias(aliases, candidate.resolvedPath);
	addCandidateAlias(aliases, candidate.sourceInfo?.source);
	addCandidateAlias(aliases, candidate.metadata?.source);
	aliases.add(path.basename(candidate.path ?? ""));
	aliases.add(path.basename(candidate.resolvedPath ?? ""));
	if (candidate.path) {
		const pathDir = path.dirname(candidate.path);
		if (pathDir && pathDir !== ".") {
			aliases.add(path.basename(pathDir));
		}
	}
	if (candidate.resolvedPath) {
		const resolvedPathDir = path.dirname(candidate.resolvedPath);
		if (resolvedPathDir && resolvedPathDir !== ".") {
			aliases.add(path.basename(resolvedPathDir));
		}
	}
	addCandidateAliasPath(aliases, candidate.path);
	addCandidateAliasPath(aliases, candidate.resolvedPath);
	if (candidate.metadata?.baseDir) {
		addCandidateAlias(aliases, candidate.metadata.baseDir);
		addCandidateAlias(aliases, path.basename(candidate.metadata.baseDir));
		const relativePath = path.relative(candidate.metadata.baseDir, candidate.path ?? "");
		if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
			const cleaned = relativePath.replace(/\\/g, "/");
			if (cleaned) {
				addCandidateAlias(aliases, cleaned);
				addCandidateAlias(aliases, `${path.basename(candidate.metadata.baseDir)}/${cleaned}`);
			}
		}
	}
	if (candidate.sourceInfo?.baseDir) {
		addCandidateAlias(aliases, candidate.sourceInfo.baseDir);
		addCandidateAlias(aliases, path.basename(candidate.sourceInfo.baseDir));
		const relativePath = path.relative(candidate.sourceInfo.baseDir, candidate.path ?? "");
		if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
			const cleaned = relativePath.replace(/\\/g, "/");
			if (cleaned) {
				addCandidateAlias(aliases, cleaned);
				addCandidateAlias(aliases, `${path.basename(candidate.sourceInfo.baseDir)}/${cleaned}`);
			}
		}
	}

	aliases.delete("");
	return aliases;
}

export function candidateMatchesSelector(candidate: ExtensionCandidate, selector: string): boolean {
	const normalizedSelector = normalizeComparisonPath(selector);
	if (!normalizedSelector) return false;
	return [...extensionAliasSet(candidate)].some((alias) => alias.includes(normalizedSelector));
}

function isProtectedMultiAgentExtension(candidate: ExtensionCandidate): boolean {
	return [...extensionAliasSet(candidate)].some(matchesProtectedMultiAgentExtension);
}

export function resolveExtensionsForAgent(agent: AgentConfig, candidates: ExtensionCandidate[]): ExtensionSelection {
	if (agent.extensions === undefined) {
		return {
			paths: candidates.map((candidate) => String(candidate.path || candidate.resolvedPath || "")).filter(Boolean),
			warnings: [],
		};
	}

	if (agent.extensions.length === 0) {
		return { paths: [], warnings: [] };
	}

	const warnings: string[] = [];
	const seen = new Set<string>();
	const paths: string[] = [];

	for (const selector of agent.extensions) {
		const normalizedSelector = selector?.trim();
		if (!normalizedSelector) continue;
		const matches = candidates.filter((candidate) => candidateMatchesSelector(candidate, normalizedSelector));
		if (matches.length === 0) {
			warnings.push(`No extension candidates matched selector "${normalizedSelector}".`);
			continue;
		}
		if (matches.length > 1) {
			warnings.push(`Selector "${normalizedSelector}" matched ${matches.length} extensions; loading all matches.`);
		}
		for (const match of matches) {
			const extensionPath = String(match.path || match.resolvedPath || "");
			if (extensionPath && !seen.has(extensionPath)) {
				seen.add(extensionPath);
				paths.push(extensionPath);
			}
		}
	}

	return { paths, warnings };
}

export function filterExtensionsForAgent(
	agent: AgentConfig,
	selfPath: string,
	options: ExtensionFilterOptions = {},
): (base: any) => any {
	const canonicalSelfPath = canonicalExistingPath(selfPath);
	return (base: any) => {
		const allowed = resolveExtensionsForAgent(agent, base.extensions ?? []);
		if (allowed.warnings.length > 0) {
			options.onWarnings?.([...allowed.warnings]);
		}
		const allowedPaths = new Set(allowed.paths);
		const filtered = base.extensions.filter((extension: any) => {
			const extensionPath = String(extension.path ?? "");
			const resolvedPath = String(extension.resolvedPath ?? "");
			const candidate: ExtensionCandidate = {
				path: extensionPath,
				resolvedPath,
				sourceInfo: extension.sourceInfo,
				metadata: extension.metadata,
			};
			// Keep this sub-agent's inline runtime extension. It installs the
			// before_agent_start hook that renders agent templates and prompt parts;
			// filtering it out makes children fall back to Pi's default prompt.
			if (extensionPath.startsWith("<inline:") || resolvedPath.startsWith("<inline:")) return true;
			// Keep the multi-agents extension itself loaded even when an agent's
			// extensions list is explicit. Otherwise a config can unload the extension
			// that enforces this policy and provides Task/wait_for_agent.
			if (
				sameExtensionPath(extensionPath, canonicalSelfPath) ||
				sameExtensionPath(resolvedPath, canonicalSelfPath) ||
				isProtectedMultiAgentExtension(candidate)
			) {
				return true;
			}
			return allowedPaths.has(extensionPath) || (resolvedPath && allowedPaths.has(resolvedPath));
		});
		return { ...base, extensions: filtered };
	};
}
