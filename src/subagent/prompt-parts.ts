/**
 * Prompt-part discovery and loading.
 *
 * Prompt parts are markdown definition files that get appended to a
 * sub-agent's system prompt at render time. They use the same
 * YAML-frontmatter convention as agent definitions and share the
 * generic markdown-definitions loader.
 *
 * Discovery path: ~/.pi/agent/prompt-parts/*.md
 */

import type { MarkdownDiagnostic } from "./markdown-definitions.js";
import { discoverMarkdownDefinitions } from "./markdown-definitions.js";

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
	projectDir: null;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover prompt-part definitions from ~/.pi/agent/prompt-parts/.
 *
 * Delegates to the generic markdown-definitions loader, then maps raw
 * definitions to PromptPartConfig. Only the user-level directory is scanned;
 * bundled and project-level directories are no longer used at runtime.
 */
export function discoverPromptParts(): PromptPartDiscoveryResult {
	const result = discoverMarkdownDefinitions({
		userSubdir: "prompt-parts",
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
		projectDir: null,
	};
}
