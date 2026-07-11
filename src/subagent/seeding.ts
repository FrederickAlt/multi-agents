/**
 * Configuration Seeding
 *
 * Copies bundled Agent definition and Prompt part files into
 * ~/.pi/agent/ when bundled files are missing from the target directories.
 *
 * Seeding is idempotent: existing files are never overwritten. Hidden files
 * (starting with ".") are skipped.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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
	if (!fs.existsSync(bundledDir)) return;

	try {
		fs.mkdirSync(targetDir, { recursive: true });
	} catch {
		return;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(bundledDir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".md")) continue;
		if (entry.name.startsWith(".")) continue;

		const src = path.join(bundledDir, entry.name);
		const target = path.join(targetDir, entry.name);
		if (fs.existsSync(target)) continue;
		try {
			fs.copyFileSync(src, target, fs.constants.COPYFILE_EXCL);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
			console.warn(`[pi-subagent] Failed to seed "${entry.name}": ${(err as Error).message}`);
		}
	}
}

/**
 * Seed bundled Agent definitions and Prompt parts into ~/.pi/agent/.
 *
 * Idempotent — safe to call multiple times. Missing bundled files are added,
 * while existing files in agents/ and prompt-parts/ are left untouched.
 */
export function seedAgentConfig(): void {
	const agentDir = getAgentDir();

	seedDirectory(path.resolve(thisDir, "agents"), path.join(agentDir, "agents"));

	seedDirectory(path.resolve(thisDir, "prompt-parts"), path.join(agentDir, "prompt-parts"));
}
