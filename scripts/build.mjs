#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const localTsc = join(projectRoot, "node_modules", "typescript", "bin", "tsc");
const distDir = join(projectRoot, "dist");

rmSync(distDir, { recursive: true, force: true });

const useLocalTsc = existsSync(localTsc);
const tscCommand = useLocalTsc ? process.execPath : "npx";
const tscArgs = useLocalTsc ? [localTsc, "-p", "tsconfig.build.json"] : ["tsc", "-p", "tsconfig.build.json"];

const tscResult = spawnSync(tscCommand, tscArgs, {
	cwd: projectRoot,
	stdio: "inherit",
	shell: !useLocalTsc,
});

if (tscResult.status !== 0 || tscResult.error) {
	console.error("Failed to compile TypeScript sources for distribution.");
	process.exit(tscResult.status ?? 1);
}

for (const [from, to] of [
	[join(projectRoot, "src", "subagent", "agents"), join(distDir, "subagent", "agents")],
	[join(projectRoot, "src", "subagent", "prompt-parts"), join(distDir, "subagent", "prompt-parts")],
]) {
	if (!existsSync(from)) {
		continue;
	}
	mkdirSync(to, { recursive: true });
	cpSync(from, to, { recursive: true });
}

