import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, type ResolvedResource, SettingsManager } from "@mariozechner/pi-coding-agent";

import { type AgentConfig, discoverAgents } from "../subagent/agents.js";
import { type ExtensionSelection, resolveExtensionsForAgent } from "../subagent/extension-filter.js";
import { MULTI_AGENTS_LAUNCHER_ENV, MULTI_AGENTS_LAUNCHER_ENV_VALUE } from "../subagent/launcher-contract.js";
import { getSelectedRootAgentFromSessionEntries, resolveRootAgent } from "../subagent/root-agent.js";

export const MULTI_AGENTS_EXTENSION_ENTRY = fileURLToPath(new URL("../subagent/index.ts", import.meta.url));

interface BuildLaunchResult {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	sessionPathUsed?: string;
	skipLaunch?: boolean;
}

interface SessionIndexEntry {
	id: string;
	path: string;
	cwd: string;
	modified: number;
}

interface ParsedLauncherArgState {
	sessionArg?: string;
	sessionArgFlag: boolean;
	forkArg?: string;
	forkArgFlag: boolean;
	continueSession: boolean;
	resumeSession: boolean;
	noSession: boolean;
	sessionDir?: string;
	sessionDirArg?: string;
	explicitAgent?: string;
	defaultRootAgent?: string;
	args: string[];
}

export type ResumePicker = (sessions: SessionIndexEntry[]) => string | null | undefined;

export interface LauncherOptions {
	extensionPath?: string;
	cwd?: string;
	piCommand?: string;
	resumePicker?: ResumePicker;
	// Optional test seams: allow dependency injection for extension resolution.
	discoverAgentsForLauncher?: () => { agents: AgentConfig[] };
	resolveExtensionCandidates?: (options: { cwd: string; agentDir: string }) => Promise<ResolvedResource[]>;
}

type SessionLike = {
	type?: unknown;
	id?: unknown;
	cwd?: unknown;
	customType?: unknown;
	data?: unknown;
};

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const ENV_SESSION_DIR = "PI_CODING_AGENT_SESSION_DIR";

function expandTildePath(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return homedir() + value.slice(1);
	return value;
}

function normalizePath(value: string, cwd = process.cwd()): string {
	return resolve(cwd, value);
}

function hasExplicitExtensionArg(args: string[], extensionPath: string, cwd = process.cwd()): boolean {
	const target = normalizePath(extensionPath, cwd);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--extension" || arg === "-e") {
			const value = args[i + 1];
			if (value && normalizePath(value, cwd) === target) return true;
			i++;
			continue;
		}
		if (arg.startsWith("--extension=")) {
			const value = arg.slice("--extension=".length);
			if (value && normalizePath(value, cwd) === target) return true;
		}
	}
	return false;
}

function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return resolve(homedir(), ".pi", "agent");
}

async function resolveExtensionCandidates(cwd: string, agentDir: string): Promise<ResolvedResource[]> {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolved = await packageManager.resolve(async () => "skip");
	return resolved.extensions;
}

function resolveLauncherRootAgent(params: {
	parsed: ParsedLauncherArgState;
	selectedSessionRootAgent?: string;
	agents: AgentConfig[];
}): AgentConfig {
	const selectedAgent = params.selectedSessionRootAgent ?? params.parsed.explicitAgent;
	return resolveRootAgent({
		agents: params.agents,
		selectedAgent,
		defaultRootAgent: params.parsed.defaultRootAgent,
	}).agent;
}

function resolveLauncherExtensions(rootAgent: AgentConfig, candidates: ResolvedResource[]): ExtensionSelection {
	return resolveExtensionsForAgent(rootAgent, candidates);
}

function safeSessionDirFromCwd(cwd: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return resolve(getAgentDir(), "sessions", safePath);
}

function resolveSessionDir(value: string | undefined, cwd: string): string {
	if (value) {
		return resolve(cwd, expandTildePath(value));
	}
	return safeSessionDirFromCwd(cwd);
}

function parseSessionArgArg(arg: string): boolean {
	return arg.includes("/") || arg.includes("\\") || arg.endsWith(".jsonl");
}

function parseSessionEntries(path: string): SessionLike[] {
	if (!existsSync(path)) {
		return [];
	}
	const raw = readFileSync(path, "utf-8");
	if (!raw.trim()) {
		return [];
	}
	const entries: SessionLike[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object") {
				entries.push(parsed as SessionLike);
			}
		} catch {}
	}
	return entries;
}

function readSessionInfo(path: string): SessionIndexEntry | null {
	const entries = parseSessionEntries(path);
	const header = entries.find((entry) => entry?.type === "session") as
		| ({ type: "session"; id?: unknown; cwd?: unknown } & Record<string, unknown>)
		| undefined;
	if (!header || typeof header.id !== "string") {
		return null;
	}
	let modified = 0;
	try {
		modified = statSync(path).mtime.getTime();
	} catch {
		modified = 0;
	}
	return {
		id: header.id,
		path,
		cwd: typeof header.cwd === "string" ? header.cwd : "",
		modified,
	};
}

function listSessionsFromDir(dir: string): SessionIndexEntry[] {
	if (!existsSync(dir)) return [];
	try {
		const candidates = readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => readSessionInfo(resolve(dir, name)))
			.filter((info): info is SessionIndexEntry => info !== null);
		return candidates.sort((a, b) => {
			if (a.modified !== b.modified) return b.modified - a.modified;
			return a.path.localeCompare(b.path);
		});
	} catch {
		return [];
	}
}

function listAllSessions(sessionRoot: string): SessionIndexEntry[] {
	if (!existsSync(sessionRoot)) return [];
	try {
		const dirs = readdirSync(sessionRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => resolve(sessionRoot, entry.name));
		const sessions = dirs.flatMap((dir) => listSessionsFromDir(dir));
		return sessions.sort((a, b) => {
			if (a.modified !== b.modified) return b.modified - a.modified;
			return a.path.localeCompare(b.path);
		});
	} catch {
		return [];
	}
}

function resolveSessionArg(
	arg: string,
	cwd: string,
	localSessionDir: string,
	globalSessionRoot: string,
): { type: "path" | "local" | "global" | "not_found"; path?: string; cwd?: string; arg?: string } {
	if (parseSessionArgArg(arg)) {
		return { type: "path", path: resolve(cwd, expandTildePath(arg)) };
	}

	const localMatch = listSessionsFromDir(localSessionDir).find((session) => session.id.startsWith(arg));
	if (localMatch) {
		return { type: "local", path: localMatch.path, cwd: localMatch.cwd, arg };
	}

	const globalMatch = listAllSessions(globalSessionRoot).find((session) => session.id.startsWith(arg));
	if (globalMatch) {
		return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd, arg };
	}

	return { type: "not_found", arg };
}

function listResumeSessionCandidates(localSessionDir: string, globalSessionRoot: string): SessionIndexEntry[] {
	const candidates = [...listSessionsFromDir(localSessionDir), ...listAllSessions(globalSessionRoot)];
	const seen = new Set<string>();
	const deduped: SessionIndexEntry[] = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.path)) continue;
		seen.add(candidate.path);
		deduped.push(candidate);
	}
	return deduped.sort((a, b) => {
		if (a.modified !== b.modified) return b.modified - a.modified;
		return a.path.localeCompare(b.path);
	});
}

function getMostRecentSession(sessionDir: string): SessionIndexEntry | undefined {
	return listSessionsFromDir(sessionDir)[0];
}

function pickSessionRootAgent(sessionPath: string): string | undefined {
	const entries = parseSessionEntries(sessionPath).filter(
		(entry): entry is { type: "custom"; customType?: string; data?: unknown } =>
			entry?.type === "custom" && typeof entry === "object",
	);
	return getSelectedRootAgentFromSessionEntries(entries);
}

function hasArg(args: string[], flag: string): boolean {
	return args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`));
}

function formatResumeOptions(sessions: SessionIndexEntry[]): string[] {
	return sessions.map((session, index) => `${index + 1}. ${session.id} (${session.cwd || "<unknown>"})`);
}

async function promptResumeSelection(sessions: SessionIndexEntry[]): Promise<string | null> {
	if (sessions.length === 0) {
		return null;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return null;
	}

	console.log("Please select a session to resume:");
	formatResumeOptions(sessions).forEach((line) => {
		console.log(line);
	});

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		while (true) {
			const response = await rl.question("Select session number (empty to cancel): ");
			const trimmed = response.trim();
			if (!trimmed) {
				return null;
			}
			const index = Number.parseInt(trimmed, 10);
			if (Number.isInteger(index) && index >= 1 && index <= sessions.length) {
				return sessions[index - 1]?.path;
			}
			console.log("Invalid selection. Enter a number shown above or press Enter to cancel.");
		}
	} finally {
		rl.close();
	}
}

function stripExplicitAgentArgs(args: string[]): string[] {
	const filtered: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--agent") {
			i += 1;
			continue;
		}
		if (arg.startsWith("--agent=")) {
			continue;
		}
		filtered.push(arg);
	}
	return filtered;
}

function ensureArg(args: string[], flag: string, value: string): string[] {
	const next = args.indexOf(flag);
	if (next !== -1) {
		if (next + 1 < args.length) {
			return [...args.slice(0, next + 1), value, ...args.slice(next + 2)];
		}
		return [...args, value];
	}
	return [...args, flag, value];
}

function parseLauncherArgs(userArgs: string[]): ParsedLauncherArgState {
	const state: ParsedLauncherArgState = {
		continueSession: false,
		resumeSession: false,
		noSession: false,
		sessionArgFlag: false,
		forkArgFlag: false,
		args: [],
	};

	for (let i = 0; i < userArgs.length; i++) {
		const arg = userArgs[i];

		if (arg === "--session" || arg === "-s") {
			state.sessionArgFlag = true;
			const value = userArgs[i + 1];
			if (value === undefined) {
				state.args.push(arg);
				continue;
			}
			state.sessionArg = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--session=")) {
			state.sessionArgFlag = true;
			state.sessionArg = arg.slice("--session=".length);
			continue;
		}
		if (arg === "--fork") {
			state.forkArgFlag = true;
			const value = userArgs[i + 1];
			if (value === undefined) {
				state.args.push(arg);
				continue;
			}
			state.forkArg = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--fork=")) {
			state.forkArgFlag = true;
			state.forkArg = arg.slice("--fork=".length);
			continue;
		}
		if (arg === "--continue" || arg === "-c") {
			state.continueSession = true;
			continue;
		}
		if (arg === "--resume" || arg === "-r") {
			state.resumeSession = true;
			continue;
		}
		if (arg === "--no-session") {
			state.noSession = true;
			state.args.push(arg);
			continue;
		}
		if (arg === "--session-dir") {
			const value = userArgs[i + 1];
			if (value === undefined) {
				state.args.push(arg);
				continue;
			}
			state.sessionDir = value;
			state.sessionDirArg = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--session-dir=")) {
			const value = arg.slice("--session-dir=".length);
			state.sessionDir = value;
			state.sessionDirArg = value;
			continue;
		}
		if (arg === "--agent") {
			const value = userArgs[i + 1];
			state.explicitAgent = value;
			state.args.push(arg);
			if (value !== undefined) {
				state.args.push(value);
				i += 1;
			}
			continue;
		}
		if (arg.startsWith("--agent=")) {
			state.explicitAgent = arg.slice("--agent=".length);
			state.args.push(arg);
			continue;
		}
		if (arg === "--defaultRootAgent") {
			const value = userArgs[i + 1];
			state.defaultRootAgent = value;
			state.args.push(arg);
			if (value !== undefined) {
				i += 1;
				state.args.push(value);
			}
			continue;
		}
		if (arg.startsWith("--defaultRootAgent=")) {
			state.defaultRootAgent = arg.slice("--defaultRootAgent=".length);
			state.args.push(arg);
			continue;
		}

		state.args.push(arg);
	}

	return state;
}

function forkSession(sourcePath: string, cwd: string, sessionDir: string): string {
	const sourceEntries = parseSessionEntries(sourcePath);
	if (sourceEntries.length === 0) {
		throw new Error(`Cannot fork: source session file is empty or invalid: ${sourcePath}`);
	}
	const sourceHeader = sourceEntries.find(
		(entry): entry is { [key: string]: unknown; id?: unknown } =>
			entry.type === "session" && typeof entry.id === "string",
	);
	if (!sourceHeader || typeof sourceHeader.id !== "string") {
		throw new Error(`Cannot fork: source session has no header: ${sourcePath}`);
	}

	mkdirSync(sessionDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const newSessionId = randomUUID();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const destination = resolve(sessionDir, `${fileTimestamp}_${newSessionId}.jsonl`);

	const newHeader = {
		...sourceHeader,
		id: newSessionId,
		timestamp,
		cwd,
		parentSession: sourcePath,
	};

	const lines = [
		JSON.stringify(newHeader),
		...sourceEntries
			.filter((entry) => !(entry && typeof entry === "object" && entry.type === "session"))
			.map((entry) => JSON.stringify(entry)),
	];
	writeFileSync(destination, `${lines.join("\n")}\n`);
	return destination;
}

function assertNoResumeConflicts(parsed: ParsedLauncherArgState): void {
	if (!parsed.resumeSession) {
		return;
	}

	const conflicts: string[] = [];
	if (parsed.sessionArgFlag) {
		conflicts.push("--session");
	}
	if (parsed.continueSession) {
		conflicts.push("--continue");
	}
	if (parsed.forkArgFlag) {
		conflicts.push("--fork");
	}
	if (conflicts.length > 0) {
		throw new Error(`Error: --resume cannot be combined with ${conflicts.join(", ")}`);
	}
}

export async function buildLauncherArgs(userArgs: string[], options: LauncherOptions = {}): Promise<BuildLaunchResult> {
	const cwd = options.cwd ?? process.cwd();
	const piCommand = options.piCommand ?? "pi";
	const extensionPath = options.extensionPath ?? MULTI_AGENTS_EXTENSION_ENTRY;
	const resolver = {
		discoverAgents: options.discoverAgentsForLauncher ?? discoverAgents,
		resolveExtensionCandidates:
			options.resolveExtensionCandidates ??
			((resolverOptions) => resolveExtensionCandidates(resolverOptions.cwd, resolverOptions.agentDir)),
	};

	const parsed = parseLauncherArgs(userArgs);
	const configuredSessionDir = parsed.sessionDir ?? process.env[ENV_SESSION_DIR];
	const localSessionDir = resolveSessionDir(configuredSessionDir, cwd);
	const globalSessionRoot = dirname(localSessionDir);

	let selectedSessionPath: string | undefined;
	let skipLaunch = false;

	if (!parsed.noSession) {
		assertNoResumeConflicts(parsed);
		if (parsed.forkArg) {
			if (parsed.sessionArg || parsed.resumeSession || parsed.continueSession) {
				throw new Error("Error: --fork cannot be combined with --session, --resume, or --continue");
			}
			const resolved = resolveSessionArg(parsed.forkArg, cwd, localSessionDir, globalSessionRoot);
			if (resolved.type === "not_found" || !resolved.path) {
				throw new Error(`No session found matching '${resolved.arg}'`);
			}
			selectedSessionPath = forkSession(resolved.path, cwd, localSessionDir);
		} else if (parsed.sessionArg) {
			const resolved = resolveSessionArg(parsed.sessionArg, cwd, localSessionDir, globalSessionRoot);
			if (resolved.type === "not_found" || !resolved.path) {
				throw new Error(`No session found matching '${resolved.arg}'`);
			}
			selectedSessionPath = resolved.path;
		} else if (parsed.resumeSession) {
			const sessions = listResumeSessionCandidates(localSessionDir, globalSessionRoot);
			const selected = options.resumePicker ? options.resumePicker(sessions) : undefined;
			if (!selected) {
				skipLaunch = true;
			} else {
				selectedSessionPath = selected;
			}
		} else if (parsed.continueSession) {
			selectedSessionPath = getMostRecentSession(localSessionDir)?.path;
		}
	}

	const selectedSessionRootAgent = selectedSessionPath ? pickSessionRootAgent(selectedSessionPath) : undefined;
	let args = [...parsed.args];
	if (selectedSessionPath) {
		args = ensureArg(args, "--session", selectedSessionPath);
		if (selectedSessionRootAgent) {
			args = stripExplicitAgentArgs(args);
			args = ensureArg(args, "--agent", selectedSessionRootAgent);
		}
	}
	if (parsed.sessionDirArg !== undefined && !hasArg(args, "--session-dir")) {
		args = ensureArg(args, "--session-dir", parsed.sessionDirArg);
	}

	const agentDir = getAgentDir();
	const rootAgent = resolveLauncherRootAgent({
		parsed,
		selectedSessionRootAgent,
		agents: resolver.discoverAgents().agents,
	});
	const extensionCandidates = await resolver.resolveExtensionCandidates({ cwd, agentDir });
	const selection = resolveLauncherExtensions(rootAgent, extensionCandidates);
	for (const warning of selection.warnings) {
		console.warn(warning);
	}

	const hasNoExtensions = args.includes("--no-extensions") || args.includes("-ne");
	if (!hasNoExtensions) {
		args.unshift("--no-extensions");
	}

	for (const selectedExtension of selection.paths) {
		if (!hasExplicitExtensionArg(args, selectedExtension, cwd)) {
			args.push("--extension", selectedExtension);
		}
	}

	if (!hasExplicitExtensionArg(args, extensionPath, cwd)) {
		args.push("--extension", extensionPath);
	}

	return {
		command: piCommand,
		args,
		env: {
			...process.env,
			[MULTI_AGENTS_LAUNCHER_ENV]: MULTI_AGENTS_LAUNCHER_ENV_VALUE,
		},
		sessionPathUsed: selectedSessionPath,
		skipLaunch,
	};
}

export async function launchPi(args: string[], options: LauncherOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const parsed = parseLauncherArgs(args);
	let effectiveResumePicker: ResumePicker | undefined;
	if (
		parsed.resumeSession &&
		!parsed.noSession &&
		!parsed.sessionArgFlag &&
		!parsed.forkArgFlag &&
		!parsed.continueSession &&
		!options.resumePicker
	) {
		const configuredSessionDir = parsed.sessionDir ?? process.env[ENV_SESSION_DIR];
		const localSessionDir = resolveSessionDir(configuredSessionDir, cwd);
		const globalSessionRoot = dirname(localSessionDir);
		const sessions = listResumeSessionCandidates(localSessionDir, globalSessionRoot);
		const selected = await promptResumeSelection(sessions);
		effectiveResumePicker = () => selected;
	}

	const config = await buildLauncherArgs(args, {
		...options,
		resumePicker: options.resumePicker ?? effectiveResumePicker,
	});
	if (config.skipLaunch) {
		return 0;
	}
	const result = spawnSync(config.command, config.args, {
		env: config.env,
		stdio: "inherit",
	});
	if (result.error) {
		throw result.error;
	}
	if (result.signal) {
		return 128;
	}
	return result.status ?? 0;
}
