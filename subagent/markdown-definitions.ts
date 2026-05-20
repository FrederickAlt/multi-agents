/**
 * Generic markdown definition discovery and loading.
 *
 * This module owns the generic logic for discovering markdown definition
 * files from the user-level agent directory (~/.pi/agent/<subdir>).
 * Bundled and project-level directories are not scanned at runtime.
 * Definitions follow YAML-frontmatter conventions with filename-stem naming.
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
	frontmatter: Record<string, unknown>;
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
	/** Subdirectory name (relative to the user config dir) for user definitions. */
	userSubdir: string;
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
 *
 * @deprecated Project-level agent discovery is no longer used. Use
 *   discoverMarkdownDefinitions for user-level (~/.pi/agent/) discovery.
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

		let frontmatter: Record<string, unknown>;
		let body: string;
		try {
			const parsed = parseFrontmatter<Record<string, unknown>>(content);
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
 * Discover markdown definitions from ~/.pi/agent/<userSubdir>.
 *
 * Only the user-level agent directory is scanned; bundled and project-level
 * directories are no longer used at runtime.
 */
export function discoverMarkdownDefinitions(
	options: MarkdownDiscoveryOptions,
): { definitions: RawMarkdownDefinition[]; diagnostics: MarkdownDiagnostic[]; projectDir: null } {
	const diagnostics: MarkdownDiagnostic[] = [];

	const userDir = path.join(getAgentDir(), options.userSubdir);
	const definitions = loadDefinitionsFromDir(userDir, "user", diagnostics);

	return {
		definitions,
		diagnostics,
		projectDir: null,
	};
}
