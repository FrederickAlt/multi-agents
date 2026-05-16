/**
 * Generic markdown definition discovery and loading.
 *
 * This module owns the generic logic for discovering markdown definition
 * files from bundled, user, and project directories. It mirrors the
 * structure of agents.ts but is generalised for any kind of definition
 * that follows the same conventions (YAML frontmatter, filename-stem
 * naming, bundled → user → project precedence).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where a definition originated. */
export type MarkdownDefinitionSource = "builtin" | "user" | "project";

/**
 * A raw markdown definition loaded from a .md file.
 *
 * `name` is derived from the filename stem (the basename without .md).
 * `description` is read from the YAML frontmatter.
 * `body` is the markdown content after the frontmatter block.
 * `frontmatter` stores all parsed frontmatter key/value pairs as-is.
 */
export interface RawMarkdownDefinition {
	name: string;
	description: string;
	body: string;
	source: MarkdownDefinitionSource;
	filePath: string;
	frontmatter: Record<string, string | number>;
}

/**
 * Describes why a definition file was skipped or produced a warning.
 * Consumers can inspect these to provide feedback (e.g. surface in UI or logs).
 */
export interface MarkdownDiagnostic {
	filePath: string;
	level: "error" | "warn";
	reason: string;
}

/** Options for discoverMarkdownDefinitions. */
export interface MarkdownDiscoveryOptions {
	/** Working directory used as anchor for walking up to find a project dir. */
	cwd: string;
	/**
	 * Which non-bundled sources to include.
	 * - "user":   bundled + user
	 * - "project": bundled + project
	 * - "both":   bundled + user + project
	 */
	scope: "user" | "project" | "both";
	/** Path to the directory containing bundled definitions. */
	bundledDir: string;
	/** Subdirectory name (relative to the user config dir) for user definitions. */
	userSubdir: string;
	/** Subdirectory name used inside .pi/<projectSubdir> for project definitions. */
	projectSubdir: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return true if `p` exists and is a directory.
 */
function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Walk up from `cwd` looking for a `.pi/<kind>/` directory.
 * Returns the full path to the `.pi/<kind>` directory if found,
 * or `null` if none exists in any ancestor.
 */
export function findNearestProjectDir(cwd: string, kind: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", kind);
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Read all valid .md definition files from `dir` and return an array of
 * parsed definitions.
 *
 * Behaviour:
 * - Hidden files (name starts with `.` after stem extraction) are skipped
 *   and a "warn" diagnostic is emitted.
 * - Non-.md files are silently skipped (no diagnostic).
 * - Non-files and symlinks are silently skipped (no diagnostic).
 * - Files that cannot be read produce an "error" diagnostic.
 * - Files with malformed YAML frontmatter produce an "error" diagnostic.
 * - Files whose frontmatter lacks a `description` field produce an "error"
 *   diagnostic.
 * - The definition `name` is derived from the filename stem (basename
 *   without `.md`).
 *
 * If `dir` does not exist or cannot be read, an empty array is returned
 * silently (no diagnostics).
 */
export function loadDefinitionsFromDir(
	dir: string,
	source: MarkdownDefinitionSource,
	diagnostics: MarkdownDiagnostic[],
): RawMarkdownDefinition[] {
	const definitions: RawMarkdownDefinition[] = [];

	if (!fs.existsSync(dir)) {
		return definitions;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return definitions;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);

		// Name is derived from the filename stem, not from a frontmatter field.
		const name = path.basename(entry.name, ".md");
		if (name.startsWith(".")) {
			diagnostics.push({
				filePath,
				level: "warn",
				reason: `Hidden file "${entry.name}" is skipped; definition names must not start with a dot.`,
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

		definitions.push({
			name,
			description: String(frontmatter.description),
			body,
			source,
			filePath,
			frontmatter,
		});
	}

	return definitions;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Discover markdown definitions by scanning bundled, user, and project
 * directories according to the provided options.
 *
 * Precedence: bundled is the base layer, user definitions override bundled,
 * and project definitions override both.
 *
 * The `scope` option controls which non-bundled sources are included:
 * - "user": bundled + user (user overrides bundled)
 * - "project": bundled + project (project overrides bundled)
 * - "both": bundled + user + project (user overrides bundled, project overrides both)
 *
 * Returns the merged definitions, collected diagnostics, and the resolved
 * project directory (if any).
 */
export function discoverMarkdownDefinitions(
	options: MarkdownDiscoveryOptions,
): { definitions: RawMarkdownDefinition[]; diagnostics: MarkdownDiagnostic[]; projectDir: string | null } {
	const diagnostics: MarkdownDiagnostic[] = [];

	const userDir = path.join(getAgentDir(), options.userSubdir);
	const projectDir = findNearestProjectDir(options.cwd, options.projectSubdir);

	// Load definitions from each applicable source.
	const bundledDefinitions = loadDefinitionsFromDir(options.bundledDir, "builtin", diagnostics);
	const userDefinitions =
		options.scope === "project"
			? []
			: loadDefinitionsFromDir(userDir, "user", diagnostics);
	const projectDefinitions =
		options.scope === "user" || !projectDir
			? []
			: loadDefinitionsFromDir(projectDir, "project", diagnostics);

	// Merge with precedence: bundled → user → project.
	const defMap = new Map<string, RawMarkdownDefinition>();

	for (const def of bundledDefinitions) defMap.set(def.name, def);
	if (options.scope === "both" || options.scope === "user") {
		for (const def of userDefinitions) defMap.set(def.name, def);
	}
	if (options.scope === "both" || options.scope === "project") {
		for (const def of projectDefinitions) defMap.set(def.name, def);
	}

	return {
		definitions: Array.from(defMap.values()),
		diagnostics,
		projectDir,
	};
}
