import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { fileURLToPath } from "node:url";

/**
 * Configuration seeding: copies bundled agent and prompt-part .md files
 * to ~/.pi/agent/ on first run / extension install.
 *
 * Seeding only runs when the target directory is absent.
 * No files are overwritten if the directory already exists.
 */

/** Path to the bundled agents directory relative to this module. */
function getBundledAgentsDir(): string {
	// __dirname equivalent in ESM
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	// Navigate from src/tui/ to project root, then subagent/agents/
	return path.resolve(moduleDir, "..", "..", "..", "subagent", "agents");
}

/** Path to the bundled prompt-parts directory relative to this module. */
function getBundledPromptPartsDir(): string {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(moduleDir, "..", "..", "..", "subagent", "prompt-parts");
}

/**
 * Copy all .md files from source directory to target directory.
 * Does nothing if target directory already exists.
 * Returns the number of files copied.
 */
function seedDirectory(sourceDir: string, targetDir: string): number {
	if (!fs.existsSync(sourceDir)) return 0;
	if (fs.existsSync(targetDir)) return 0;

	fs.mkdirSync(targetDir, { recursive: true });

	let count = 0;
	const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const src = path.join(sourceDir, entry.name);
		const dst = path.join(targetDir, entry.name);

		try {
			fs.copyFileSync(src, dst);
			count++;
		} catch {
			// Skip files that can't be copied
		}
	}

	return count;
}

/**
 * Run the full seeding process.
 *
 * Seeds agents and prompt-parts from bundled directories into
 * ~/.pi/agent/ if the target directories don't already exist.
 */
export function seedConfig(): { agents: number; promptParts: number } {
	const agentDir = getAgentDir();

	const agentsSeeded = seedDirectory(
		getBundledAgentsDir(),
		path.join(agentDir, "agents"),
	);

	const partsSeeded = seedDirectory(
		getBundledPromptPartsDir(),
		path.join(agentDir, "prompt-parts"),
	);

	return { agents: agentsSeeded, promptParts: partsSeeded };
}
