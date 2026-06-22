import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
	DefaultPackageManager,
	type ResolvedResource,
	type SessionInfo,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";

import { type AgentConfig, discoverAgents } from "../subagent/agents.js";
import { type ExtensionSelection, resolveExtensionsForAgent } from "../subagent/extension-filter.js";
import {
	MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV,
	MULTI_AGENTS_LAUNCHER_ENV,
	MULTI_AGENTS_LAUNCHER_ENV_VALUE,
	MULTI_AGENTS_RESTART_REQUEST_FILE_ENV,
} from "../subagent/launcher-contract.js";
import { getSelectedRootAgentFromSessionEntries, resolveRootAgent } from "../subagent/root-agent.js";

export const MULTI_AGENTS_EXTENSION_ENTRY = fileURLToPath(new URL("../subagent/index.ts", import.meta.url));

interface BuildLaunchResult {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	sessionPathUsed?: string;
	restartFile?: string;
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
	restartRequestFile?: string;
	resumePicker?: ResumePicker;
	// Optional test seams: allow dependency injection for extension resolution.
	discoverAgentsForLauncher?: () => { agents: AgentConfig[] };
	resolveExtensionCandidates?: (options: { cwd: string; agentDir: string }) => Promise<ResolvedResource[]>;
}

function sessionInfoToCandidate(info: SessionInfo): SessionIndexEntry {
	return {
		id: info.id,
		path: info.path,
		cwd: info.cwd,
		modified: info.modified.getTime(),
	};
}

interface RestartRequest {
	version?: number;
	requestedRootAgent?: string;
}

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

function hasArg(args: string[], flag: string): boolean {
	return args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`));
}

function createRestartRequestFilePath(): string {
	return resolve(tmpdir(), `pi-agents-restart-${randomUUID()}.json`);
}

function clearRestartRequestFile(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		try {
			writeFileSync(path, "", "utf-8");
		} catch {
			// Ignore permission/race conditions; fallback behavior is restart-file miss.
		}
	}
}

function parseRestartRequestPayload(raw: string): string | undefined {
	try {
		const parsed = JSON.parse(raw) as RestartRequest;
		if (!parsed || typeof parsed !== "object") return undefined;
		const requested = parsed.requestedRootAgent;
		if (typeof requested !== "string") return undefined;
		const trimmed = requested.trim();
		return trimmed || undefined;
	} catch {
		return undefined;
	}
}

function readRestartRequestFile(path: string): string | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	let raw = "";
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const request = parseRestartRequestPayload(trimmed);
		if (request) {
			return request;
		}
	}
	return undefined;
}

function rewriteArgsForRestart(baseArgs: string[], requestedAgent: string): string[] {
	const filtered: string[] = [];
	for (let i = 0; i < baseArgs.length; i++) {
		const arg = baseArgs[i];
		if (
			arg === "--session" ||
			arg === "-s" ||
			arg === "--fork" ||
			arg === "--continue" ||
			arg === "-c" ||
			arg === "--resume" ||
			arg === "-r"
		) {
			if ((arg === "--session" || arg === "-s" || arg === "--fork") && baseArgs[i + 1] !== undefined) {
				i += 1;
			}
			continue;
		}
		if (arg.startsWith("--session=") || arg.startsWith("--fork=") || arg === "--no-session") {
			continue;
		}
		if (arg === "--agent") {
			i += 1;
			continue;
		}
		if (arg.startsWith("--agent=")) {
			continue;
		}
		if (arg === "--session-dir" || arg.startsWith("--session-dir=")) {
			filtered.push(arg);
			continue;
		}
		filtered.push(arg);
	}
	return ensureArg(stripExplicitAgentArgs(filtered), "--agent", requestedAgent);
}

async function resolveSessionArg(
	arg: string,
	cwd: string,
	localSessionDir: string,
): Promise<{ type: "path" | "local" | "global" | "not_found"; path?: string; cwd?: string; arg?: string }> {
	if (parseSessionArgArg(arg)) {
		return { type: "path", path: resolve(cwd, expandTildePath(arg)) };
	}

	const localMatch = (await SessionManager.list(cwd, localSessionDir)).find((session) => session.id.startsWith(arg));
	if (localMatch) {
		return {
			type: "local",
			path: localMatch.path,
			cwd: localMatch.cwd,
			arg,
		};
	}

	const globalMatch = (await SessionManager.listAll()).find((session) => session.id.startsWith(arg));
	if (globalMatch) {
		return {
			type: "global",
			path: globalMatch.path,
			cwd: globalMatch.cwd,
			arg,
		};
	}

	return { type: "not_found", arg };
}

async function listResumeSessionCandidates(cwd: string, localSessionDir: string): Promise<SessionIndexEntry[]> {
	const [localSessions, allSessions] = await Promise.all([
		SessionManager.list(cwd, localSessionDir),
		SessionManager.listAll(),
	]);
	const candidates = [...localSessions, ...allSessions].map(sessionInfoToCandidate);
	const deduped: SessionIndexEntry[] = [];
	const seen = new Set<string>();
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

async function getMostRecentSessionPath(localSessionDir: string, cwd: string): Promise<string | undefined> {
	const manager = SessionManager.continueRecent(cwd, localSessionDir);
	const path = manager.getSessionFile();
	if (!path || !existsSync(path)) {
		return undefined;
	}
	return path;
}

function pickSessionRootAgent(sessionPath: string, sessionDir: string): string | undefined {
	const manager = SessionManager.open(sessionPath, sessionDir);
	const entries = manager.getEntries().filter((entry) => entry.type === "custom") as Array<{
		type: string;
		customType?: string;
		data?: unknown;
	}>;
	return getSelectedRootAgentFromSessionEntries(entries);
}

function formatResumeOptions(sessions: SessionIndexEntry[]): string[] {
	return sessions.map((session, index) => `${index + 1}. ${session.id} (${session.cwd || "<unknown>"})`);
}

async function promptResumeSelection(sessions: SessionIndexEntry[]): Promise<string | null> {
	// NOTE: The design intent is to reuse Pi's SessionSelectorComponent for resume
	// selection. The wrapper does not currently depend on `pi-tui`, so we keep this
	// minimal prompt fallback for now.
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
	const manager = SessionManager.forkFrom(sourcePath, cwd, sessionDir);
	const forkedSession = manager.getSessionFile();
	if (!forkedSession) {
		throw new Error(`Failed to create forked session from '${sourcePath}'`);
	}
	return forkedSession;
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
	const restartRequestFile = options.restartRequestFile ?? createRestartRequestFilePath();

	const parsed = parseLauncherArgs(userArgs);
	const configuredSessionDir = parsed.sessionDir ?? process.env[ENV_SESSION_DIR];
	const localSessionDir = resolveSessionDir(configuredSessionDir, cwd);

	let selectedSessionPath: string | undefined;
	let skipLaunch = false;

	if (!parsed.noSession) {
		assertNoResumeConflicts(parsed);
		if (parsed.forkArg) {
			if (parsed.sessionArg || parsed.resumeSession || parsed.continueSession) {
				throw new Error("Error: --fork cannot be combined with --session, --resume, or --continue");
			}
			const resolved = await resolveSessionArg(parsed.forkArg, cwd, localSessionDir);
			if (resolved.type === "not_found" || !resolved.path) {
				throw new Error(`No session found matching '${resolved.arg}'`);
			}
			selectedSessionPath = forkSession(resolved.path, cwd, localSessionDir);
		} else if (parsed.sessionArg) {
			const resolved = await resolveSessionArg(parsed.sessionArg, cwd, localSessionDir);
			if (resolved.type === "not_found" || !resolved.path) {
				throw new Error(`No session found matching '${resolved.arg}'`);
			}
			selectedSessionPath = resolved.path;
		} else if (parsed.resumeSession) {
			const sessions = await listResumeSessionCandidates(cwd, localSessionDir);
			const selected = options.resumePicker ? options.resumePicker(sessions) : undefined;
			if (!selected) {
				skipLaunch = true;
			} else {
				selectedSessionPath = selected;
			}
		} else if (parsed.continueSession) {
			selectedSessionPath = await getMostRecentSessionPath(localSessionDir, cwd);
		}
	}

	const selectedSessionRootAgent = selectedSessionPath
		? pickSessionRootAgent(selectedSessionPath, localSessionDir)
		: undefined;
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

	const launchRootAgent = rootAgent.name;
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	delete childEnv[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV];
	childEnv[MULTI_AGENTS_LAUNCHER_ENV] = MULTI_AGENTS_LAUNCHER_ENV_VALUE;
	childEnv[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV] = restartRequestFile;
	if (!selectedSessionPath) {
		childEnv[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV] = launchRootAgent;
	}

	return {
		command: piCommand,
		args,
		env: childEnv,
		restartFile: restartRequestFile,
		sessionPathUsed: selectedSessionPath,
		skipLaunch,
	};
}

export async function launchPi(args: string[], options: LauncherOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const parsed = parseLauncherArgs(args);
	const restartRequestFile = options.restartRequestFile ?? createRestartRequestFilePath();
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
		const sessions = await listResumeSessionCandidates(cwd, localSessionDir);
		const selected = await promptResumeSelection(sessions);
		effectiveResumePicker = () => selected;
	}

	let launchArgs = args;
	clearRestartRequestFile(restartRequestFile);
	let resultStatus = 0;
	let restartCount = 0;
	while (true) {
		const config = await buildLauncherArgs(launchArgs, {
			...options,
			restartRequestFile,
			resumePicker: options.resumePicker ?? effectiveResumePicker,
		});
		effectiveResumePicker = undefined;
		if (config.skipLaunch) {
			return 0;
		}

		// Ensure that stale restart requests from previous runs do not get
		// accidentally consumed by this launch cycle.
		clearRestartRequestFile(restartRequestFile);
		const result = spawnSync(config.command, config.args, {
			env: config.env,
			stdio: "inherit",
		});
		if (result.error) {
			throw result.error;
		}
		if (result.signal) {
			clearRestartRequestFile(restartRequestFile);
			return 128;
		}
		resultStatus = result.status ?? 0;
		if (resultStatus !== 0) {
			clearRestartRequestFile(restartRequestFile);
			return resultStatus;
		}

		const requestedRootAgent = readRestartRequestFile(restartRequestFile);
		clearRestartRequestFile(restartRequestFile);
		if (!requestedRootAgent) {
			return resultStatus;
		}

		restartCount += 1;
		if (restartCount > 10) {
			console.warn("pi-agents: exceeded maximum number of Root-agent restarts. Aborting.");
			return 1;
		}
		launchArgs = rewriteArgsForRestart(args, requestedRootAgent);
	}
}
