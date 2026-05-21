/**
 * Configuration Seeding
 *
 * Copies bundled Agent definition and Prompt part files into
 * ~/.pi/agent/ when the target directories don't exist yet.
 *
 * Seeding runs once (idempotent): if the directory already exists,
 * no files are added or overwritten. Hidden files (starting with ".")
 * are skipped.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

const thisDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Copy .md files from a bundled source directory to the user config target
 * directory. Creates the target directory (and parent) if it doesn't exist.
 *
 * - Skips hidden files (name starts with ".")
 * - Skips non-.md files
 * - Logs a warning on individual copy failure but does not throw
 */
function seedDirectory(bundledDir: string, targetDir: string): void {
	// Idempotent: if the target already exists, do nothing.
	if (fs.existsSync(targetDir)) return;

	if (!fs.existsSync(bundledDir)) return;

	fs.mkdirSync(targetDir, { recursive: true });

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(bundledDir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".md")) continue;
		if (path.basename(entry.name).startsWith(".")) continue;

		const src = path.join(bundledDir, entry.name);
		try {
			fs.copyFileSync(src, path.join(targetDir, entry.name));
		} catch (err) {
			console.warn(
				`[pi-subagent] Failed to seed "${entry.name}": ${(err as Error).message}`,
			);
		}
	}
}

/**
 * Seed bundled Agent definitions and Prompt parts into ~/.pi/agent/.
 *
 * Idempotent — safe to call multiple times. Seeding only happens when
 * the target subdirectory (agents/ or prompt-parts/) does not already exist.
 */
export function seedAgentConfig(): void {
	const agentDir = getAgentDir();

	seedDirectory(
		path.resolve(thisDir, "agents"),
		path.join(agentDir, "agents"),
	);

	seedDirectory(
		path.resolve(thisDir, "prompt-parts"),
		path.join(agentDir, "prompt-parts"),
	);
}
