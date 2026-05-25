import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir } from "./pi-compat.js";

export interface AgentConfigCliOptions {
	debug: boolean;
	debugDir?: string;
	help: boolean;
}

export interface AgentConfigDebugInfo {
	/** Original agent config root that was copied for debugging. */
	sourceDir: string;
	/** Dummy agent config root used by the TUI while debug mode is enabled. */
	debugDir: string;
}

export function parseAgentConfigArgs(argv: string[]): AgentConfigCliOptions {
	const options: AgentConfigCliOptions = {
		debug: false,
		help: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--debug") {
			options.debug = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg === "--debug-dir") {
			const value = argv[++i];
			if (!value) {
				throw new Error("--debug-dir requires a path");
			}
			options.debugDir = value;
			options.debug = true;
			continue;
		}
		if (arg.startsWith("--debug-dir=")) {
			const value = arg.slice("--debug-dir=".length);
			if (!value) {
				throw new Error("--debug-dir requires a path");
			}
			options.debugDir = value;
			options.debug = true;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

export function formatAgentConfigUsage(): string {
	return [
		"Usage: pi-agent-config [--debug] [--debug-dir <path>]",
		"",
		"Options:",
		"  --debug             Copy the current agent config to a dummy path and edit that copy.",
		"  --debug-dir <path>  Use this dummy agent config root instead of a temporary path.",
		"  -h, --help          Show this help.",
	].join("\n");
}

export function prepareDebugAgentDir(options: { debugDir?: string } = {}): AgentConfigDebugInfo {
	const sourceDir = path.resolve(getAgentDir());
	const debugDir = path.resolve(
		options.debugDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-config-debug-")),
	);

	if (sourceDir === debugDir) {
		throw new Error("Debug agent directory must be different from the source agent directory.");
	}
	if (isPathInside(debugDir, sourceDir)) {
		throw new Error("Debug agent directory must not be inside the source agent directory.");
	}

	fs.mkdirSync(debugDir, { recursive: true });
	if (fs.existsSync(sourceDir)) {
		fs.cpSync(sourceDir, debugDir, {
			recursive: true,
			force: true,
			errorOnExist: false,
		});
		// Copy symlink targets as ordinary files/directories so writing the
		// debug tree cannot mutate a symlinked real prompt file.
		materializeSymlinks(debugDir);
	}

	// All TUI discovery and write-back uses getAgentDir(), so redirect it after
	// the copy is prepared. The original config remains untouched.
	process.env.PI_CODING_AGENT_DIR = debugDir;

	return { sourceDir, debugDir };
}

function isPathInside(candidate: string, parent: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function materializeSymlinks(root: string): void {
	const stat = fs.lstatSync(root);
	if (stat.isSymbolicLink()) {
		let target: string;
		try {
			target = fs.realpathSync(root);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				fs.unlinkSync(root);
				return;
			}
			throw err;
		}

		const targetStat = fs.statSync(target);
		fs.unlinkSync(root);
		if (targetStat.isDirectory()) {
			fs.cpSync(target, root, { recursive: true, force: true, errorOnExist: false });
			materializeSymlinks(root);
		} else {
			fs.copyFileSync(target, root);
		}
		return;
	}
	if (!stat.isDirectory()) return;

	for (const entry of fs.readdirSync(root)) {
		materializeSymlinks(path.join(root, entry));
	}
}
