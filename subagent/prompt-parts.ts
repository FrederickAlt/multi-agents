/**
 * Prompt-part discovery and loading.
 *
 * Prompt parts are markdown definition files that get appended to a
 * sub-agent's system prompt at render time. They use the same
 * YAML-frontmatter convention as agent definitions and share the
 * generic markdown-definitions loader.
 *
 * Discovery paths:
 * - bundled:   subagent/prompt-parts/*.md
 * - user:      ~/.pi/agent/prompt-parts/*.md
 * - project:   .pi/prompt-parts/*.md
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type MarkdownDiagnostic,
	discoverMarkdownDefinitions,
} from "./markdown-definitions.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptPartConfig {
	/** Name derived from the definition filename stem. */
	name: string;
	/** Short description from the YAML frontmatter. */
	description: string;
	/** The markdown body (system prompt fragment) — may contain {{variables}}. */
	systemPrompt: string;
	/** Where this part originated. */
	source: "builtin" | "user" | "project";
	/** Absolute path to the definition file on disk. */
	filePath: string;
}

export interface PromptPartDiscoveryResult {
	parts: PromptPartConfig[];
	diagnostics: readonly MarkdownDiagnostic[];
	projectDir: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to the bundled prompt-parts directory. */
const BUNDLED_PROMPT_PARTS_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"prompt-parts",
);

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover prompt-part definitions by scanning bundled, user, and project
 * directories.
 *
 * Delegates to the generic markdown-definitions loader, then maps raw
 * definitions to PromptPartConfig. Precedence follows the same rules as
 * agent definitions: bundled → user → project.
 *
 * @param cwd   Working directory used as the anchor for project discovery.
 * @param scope Which non-bundled sources to include.
 */
export function discoverPromptParts(
	cwd: string,
	scope: "user" | "project" | "both",
): PromptPartDiscoveryResult {
	const result = discoverMarkdownDefinitions({
		cwd,
		scope,
		bundledDir: BUNDLED_PROMPT_PARTS_DIR,
		userSubdir: "prompt-parts",
		projectSubdir: "prompt-parts",
	});

	return {
		parts: result.definitions.map((def) => ({
			name: def.name,
			description: def.description,
			systemPrompt: def.body,
			source: def.source,
			filePath: def.filePath,
		})),
		diagnostics: result.diagnostics,
		projectDir: result.projectDir,
	};
}
