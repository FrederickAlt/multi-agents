import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ResolvedResource, SessionManager } from "@earendil-works/pi-coding-agent";

import { type AgentConfig, discoverAgents, resolveAgentMode } from "../subagent/agents.js";
import { writeExtensionCatalog } from "../subagent/extension-catalog.js";
import { type ExtensionSelection, resolveExtensionsForAgent } from "../subagent/extension-filter.js";
import { createTrustAwareSettings, resolveConfiguredExtensionCandidates } from "../subagent/extension-resolution.js";
import {
	MULTI_AGENTS_BOOTSTRAP_RESUME_ENV,
	MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV,
	MULTI_AGENTS_LAUNCHER_ENV,
	MULTI_AGENTS_LAUNCHER_ENV_VALUE,
	MULTI_AGENTS_PROJECT_TRUST_CWD_ENV,
	MULTI_AGENTS_PROJECT_TRUST_ENV,
	MULTI_AGENTS_RESTART_REQUEST_FILE_ENV,
} from "../subagent/launcher-contract.js";
import { getSelectedRootAgentFromSessionEntries, resolveRootAgent } from "../subagent/root-agent.js";
import { seedAgentConfig } from "../subagent/seeding.js";

const MULTI_AGENTS_EXTENSION_ENTRY_TS = fileURLToPath(new URL("../subagent/index.ts", import.meta.url));
const MULTI_AGENTS_EXTENSION_ENTRY_JS = fileURLToPath(new URL("../subagent/index.js", import.meta.url));

export const PI_AGENTS_PI_BIN_ENV = "PI_AGENTS_PI_BIN";

export const MULTI_AGENTS_EXTENSION_ENTRY = existsSync(MULTI_AGENTS_EXTENSION_ENTRY_JS)
	? MULTI_AGENTS_EXTENSION_ENTRY_JS
	: MULTI_AGENTS_EXTENSION_ENTRY_TS;

interface BuildLaunchResult {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	sessionPathUsed?: string;
	restartFile?: string;
}

interface ParsedLauncherArgState {
	sessionArg?: string;
	sessionArgFlag: boolean;
	forkArg?: string;
	forkArgFlag: boolean;
	continueSession: boolean;
	resumeSession: boolean;
	noSession: boolean;
	sessionIdArg?: string;
	sessionIdArgFlag: boolean;
	sessionDir?: string;
	sessionDirArg?: string;
	explicitAgent?: string;
	defaultRootAgent?: string;
	projectTrustOverride?: boolean;
	args: string[];
}

export interface LauncherOptions {
	extensionPath?: string;
	cwd?: string;
	piCommand?: string;
	restartRequestFile?: string;
	// Optional test seams: allow dependency injection for extension resolution.
	discoverAgentsForLauncher?: () => { agents: AgentConfig[] };
	resolveExtensionCandidates?: (options: {
		cwd: string;
		agentDir: string;
		projectTrustOverride?: boolean;
	}) => Promise<ResolvedResource[]>;
}

interface RestartRequest {
	version?: unknown;
	type?: unknown;
	requestedRootAgent?: unknown;
	sessionPath?: unknown;
	sessionId?: unknown;
	projectTrusted?: unknown;
}

type ParsedRestartRequest =
	| { type: "agent"; requestedRootAgent: string }
	| { type: "resume-session"; sessionPath: string }
	| { type: "trust"; sessionPath?: string; sessionId: string; projectTrusted: boolean };

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const PI_AGENT_BINARY_NAME = "pi";
const PI_AGENTS_COMMAND_BASE_NAMES = new Set(["pi-agents"]);

function normalizeCommandBase(command: string): string {
	return basename(command)
		.toLowerCase()
		.replace(/\.(?:[cm]?js|m?js|cmd|bat|exe)$/i, "");
}

function resolvePiCommandValue(piCommand?: string): string {
	const configured = piCommand?.trim() || process.env[PI_AGENTS_PI_BIN_ENV]?.trim() || PI_AGENT_BINARY_NAME;
	if (!configured) {
		return PI_AGENT_BINARY_NAME;
	}
	const baseName = normalizeCommandBase(configured);
	if (PI_AGENTS_COMMAND_BASE_NAMES.has(baseName)) {
		return PI_AGENT_BINARY_NAME;
	}
	const launcherArg = process.argv[1] ?? "";
	if (normalizeCommandBase(launcherArg) === baseName && baseName) {
		return PI_AGENT_BINARY_NAME;
	}
	return configured;
}

function getLauncherCommand(options: { piCommand?: string }): string {
	return resolvePiCommandValue(options.piCommand);
}
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

async function resolveExtensionCandidates(
	cwd: string,
	agentDir: string,
	projectTrustOverride?: boolean,
): Promise<ResolvedResource[]> {
	const { settingsManager } = createTrustAwareSettings({ cwd, agentDir, projectTrustOverride });
	return resolveConfiguredExtensionCandidates({ cwd, agentDir, projectTrustOverride, settingsManager });
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

function parseRestartRequestPayload(raw: string): ParsedRestartRequest | undefined {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;
		const request = parsed as RestartRequest;

		if (request.type === "resume-session") {
			if (typeof request.sessionPath !== "string") return undefined;
			const sessionPath = request.sessionPath.trim();
			return sessionPath ? { type: "resume-session", sessionPath } : undefined;
		}
		if (request.type === "trust") {
			if (typeof request.sessionId !== "string" || typeof request.projectTrusted !== "boolean") {
				return undefined;
			}
			const sessionId = request.sessionId.trim();
			if (!sessionId) return undefined;
			const sessionPath = typeof request.sessionPath === "string" ? request.sessionPath.trim() : "";
			return {
				type: "trust",
				...(sessionPath ? { sessionPath } : {}),
				sessionId,
				projectTrusted: request.projectTrusted,
			};
		}

		if (typeof request.requestedRootAgent !== "string") return undefined;
		const requestedRootAgent = request.requestedRootAgent.trim();
		if (!requestedRootAgent) return undefined;
		return { type: "agent", requestedRootAgent };
	} catch {
		return undefined;
	}
}

function readRestartRequestFile(path: string): ParsedRestartRequest | undefined {
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

function rewriteArgsForRestart(baseArgs: string[], restartRequest: ParsedRestartRequest): string[] {
	const persistedTrustSessionPath =
		restartRequest.type === "trust" && restartRequest.sessionPath && existsSync(restartRequest.sessionPath)
			? restartRequest.sessionPath
			: undefined;
	const shouldPreserveSessionDir =
		restartRequest.type === "agent" || (restartRequest.type === "trust" && persistedTrustSessionPath === undefined);
	const filtered: string[] = [];
	for (let i = 0; i < baseArgs.length; i++) {
		const arg = baseArgs[i];
		if (
			restartRequest.type === "trust" &&
			(arg === "--approve" || arg === "-a" || arg === "--no-approve" || arg === "-na")
		) {
			continue;
		}
		if (
			arg === "--session" ||
			arg === "-s" ||
			arg === "--session-id" ||
			arg === "--fork" ||
			arg === "--continue" ||
			arg === "-c" ||
			arg === "--resume" ||
			arg === "-r"
		) {
			if (
				(arg === "--session" || arg === "-s" || arg === "--session-id" || arg === "--fork") &&
				baseArgs[i + 1] !== undefined
			) {
				i += 1;
			}
			continue;
		}
		if (arg === "--session-dir") {
			const next = baseArgs[i + 1];
			if (shouldPreserveSessionDir) {
				filtered.push(arg);
				if (next !== undefined) {
					filtered.push(next);
				}
			}
			if (next !== undefined) {
				i += 1;
			}
			continue;
		}
		if (arg.startsWith("--session-dir=")) {
			if (shouldPreserveSessionDir) {
				filtered.push(arg);
			}
			continue;
		}
		if (arg === "--no-session") {
			if (restartRequest.type === "trust" && persistedTrustSessionPath === undefined) {
				filtered.push(arg);
			}
			continue;
		}
		if (arg.startsWith("--session=") || arg.startsWith("--session-id=") || arg.startsWith("--fork=")) {
			continue;
		}
		filtered.push(arg);
	}

	// A trust restart resumes the session created before the interactive trust
	// decision. That session_start handler exits before it can persist the Root
	// persona, so preserve an explicit --agent selection across this restart.
	if (restartRequest.type === "trust") {
		const trustSessionArgs = persistedTrustSessionPath
			? ensureArg(filtered, "--session", persistedTrustSessionPath)
			: ensureArg(filtered, "--session-id", restartRequest.sessionId);
		return [...trustSessionArgs, restartRequest.projectTrusted ? "--approve" : "--no-approve"];
	}

	const withoutAgent = stripExplicitAgentArgs(filtered);
	if (restartRequest.type === "resume-session") {
		return ensureArg(withoutAgent, "--session", restartRequest.sessionPath);
	}
	return ensureArg(withoutAgent, "--agent", restartRequest.requestedRootAgent);
}

async function resolveSessionArg(
	arg: string,
	cwd: string,
	localSessionDir: string,
): Promise<{ type: "path" | "local" | "global" | "not_found"; path?: string; cwd?: string; arg?: string }> {
	if (parseSessionArgArg(arg)) {
		return { type: "path", path: resolve(cwd, expandTildePath(arg)) };
	}

	const localSessions = await SessionManager.list(cwd, localSessionDir);
	const localMatch =
		localSessions.find((session) => session.id === arg) ??
		localSessions.find((session) => session.id.startsWith(arg));
	if (localMatch) {
		return {
			type: "local",
			path: localMatch.path,
			cwd: localMatch.cwd,
			arg,
		};
	}

	const globalSessions = await SessionManager.listAll();
	const globalMatch =
		globalSessions.find((session) => session.id === arg) ??
		globalSessions.find((session) => session.id.startsWith(arg));
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

async function resolveExactLocalSessionId(
	sessionId: string,
	cwd: string,
	localSessionDir: string,
): Promise<string | undefined> {
	const localSessions = await SessionManager.list(cwd, localSessionDir);
	return localSessions.find((session) => session.id === sessionId)?.path;
}

function isResumeBootstrapMode(parsed: ParsedLauncherArgState): boolean {
	return parsed.resumeSession;
}

function stripUserProvidedExtensions(args: string[]): string[] {
	const filtered: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--extension" || arg === "-e") {
			i += 1;
			continue;
		}
		if (arg.startsWith("--extension=")) {
			continue;
		}
		filtered.push(arg);
	}
	return filtered;
}

/** Project a resolved Root Agent's runtime fields onto Pi's native CLI. */
function applyRootAgentRuntimeArgs(args: string[], agent: AgentConfig): string[] {
	const { model, reasoningEffort } = resolveAgentMode(agent, "smart");
	const valueFlags = new Set<string>();
	const booleanFlags = new Set<string>();
	if (agent.tools !== undefined) {
		for (const flag of ["--tools", "-t", "--exclude-tools", "-xt"]) valueFlags.add(flag);
		for (const flag of ["--no-tools", "-nt", "--no-builtin-tools", "-nbt"]) booleanFlags.add(flag);
	}
	if (model?.trim()) {
		valueFlags.add("--model");
		// A provider constraint from the parent CLI can make an otherwise valid
		// configured model resolve differently from the same Task sub-agent model.
		valueFlags.add("--provider");
	}
	if (reasoningEffort?.trim()) valueFlags.add("--thinking");

	const filtered: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (valueFlags.has(arg)) {
			if (args[i + 1] !== undefined) i += 1;
			continue;
		}
		if (booleanFlags.has(arg)) continue;
		if ([...valueFlags].some((flag) => arg.startsWith(`${flag}=`))) continue;
		filtered.push(arg);
	}

	if (agent.tools !== undefined) {
		if (agent.tools.length === 0) filtered.push("--no-tools");
		else filtered.push("--tools", agent.tools.join(","));
	}
	if (model?.trim()) filtered.push("--model", model.trim());
	if (reasoningEffort?.trim()) filtered.push("--thinking", reasoningEffort.trim());
	return filtered;
}

async function getMostRecentSessionPath(localSessionDir: string, cwd: string): Promise<string | undefined> {
	const manager = SessionManager.continueRecent(cwd, localSessionDir);
	const path = manager.getSessionFile();
	if (!path || !existsSync(path)) {
		return undefined;
	}
	return path;
}

function readSelectedSessionContext(
	sessionPath: string,
	sessionDir: string,
	fallbackCwd: string,
): { rootAgent?: string; cwd: string } {
	const manager = SessionManager.open(sessionPath, sessionDir);
	const entries = manager.getEntries().filter((entry) => entry.type === "custom") as Array<{
		type: string;
		customType?: string;
		data?: unknown;
	}>;
	return {
		rootAgent: getSelectedRootAgentFromSessionEntries(entries),
		cwd: manager.getCwd() || fallbackCwd,
	};
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

function stripSessionIdArgs(args: string[]): string[] {
	const filtered: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--session-id") {
			if (args[i + 1] !== undefined) i += 1;
			continue;
		}
		if (arg.startsWith("--session-id=")) continue;
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
		sessionIdArgFlag: false,
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
		if (arg === "--session-id") {
			state.sessionIdArgFlag = true;
			const value = userArgs[i + 1];
			if (value === undefined) {
				state.args.push(arg);
				continue;
			}
			state.sessionIdArg = value;
			state.args.push(arg, value);
			i += 1;
			continue;
		}
		if (arg.startsWith("--session-id=")) {
			state.sessionIdArgFlag = true;
			state.sessionIdArg = arg.slice("--session-id=".length);
			// Pi's native parser accepts the split form. Normalize the convenient
			// equals form here while retaining native validation and semantics.
			state.args.push("--session-id", state.sessionIdArg);
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
		if (arg === "--approve" || arg === "-a") {
			state.projectTrustOverride = true;
			state.args.push(arg);
			continue;
		}
		if (arg === "--no-approve" || arg === "-na") {
			state.projectTrustOverride = false;
			state.args.push(arg);
			continue;
		}

		state.args.push(arg);
	}

	return state;
}

function forkSession(sourcePath: string, cwd: string, sessionDir: string, sessionId?: string): string {
	const manager = SessionManager.forkFrom(
		sourcePath,
		cwd,
		sessionDir,
		sessionId === undefined ? undefined : { id: sessionId },
	);
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

function assertNoSessionIdConflicts(parsed: ParsedLauncherArgState): void {
	// A bare --session-id without a value is left to Pi's native diagnostics.
	if (parsed.sessionIdArg === undefined) return;

	const conflicts: string[] = [];
	if (parsed.sessionArgFlag) conflicts.push("--session");
	if (parsed.continueSession) conflicts.push("--continue");
	if (parsed.resumeSession) conflicts.push("--resume");
	if (conflicts.length > 0) {
		throw new Error(`Error: --session-id cannot be combined with ${conflicts.join(", ")}`);
	}
}

export async function buildLauncherArgs(userArgs: string[], options: LauncherOptions = {}): Promise<BuildLaunchResult> {
	const cwd = options.cwd ?? process.cwd();
	const piCommand = getLauncherCommand(options);
	const extensionPath = options.extensionPath ?? MULTI_AGENTS_EXTENSION_ENTRY;
	const resolver = {
		discoverAgents: options.discoverAgentsForLauncher ?? discoverAgents,
		resolveExtensionCandidates:
			options.resolveExtensionCandidates ??
			((resolverOptions) =>
				resolveExtensionCandidates(
					resolverOptions.cwd,
					resolverOptions.agentDir,
					resolverOptions.projectTrustOverride,
				)),
	};
	const restartRequestFile = options.restartRequestFile ?? createRestartRequestFilePath();

	const parsed = parseLauncherArgs(userArgs);
	const configuredSessionDir = parsed.sessionDir ?? process.env[ENV_SESSION_DIR];
	const localSessionDir = resolveSessionDir(configuredSessionDir, cwd);

	const isBootstrapResume = isResumeBootstrapMode(parsed);
	if (parsed.noSession && parsed.forkArgFlag) {
		throw new Error("Error: --fork cannot be combined with --no-session");
	}
	assertNoSessionIdConflicts(parsed);

	let selectedSessionPath: string | undefined;
	let selectedSessionUsesNativeId = false;
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
			if (
				parsed.sessionIdArg &&
				(await resolveExactLocalSessionId(parsed.sessionIdArg, cwd, localSessionDir)) !== undefined
			) {
				throw new Error(`Session already exists with id '${parsed.sessionIdArg}'`);
			}
			selectedSessionPath = forkSession(resolved.path, cwd, localSessionDir, parsed.sessionIdArg);
		} else if (parsed.sessionArg) {
			const resolved = await resolveSessionArg(parsed.sessionArg, cwd, localSessionDir);
			if (resolved.type === "not_found" || !resolved.path) {
				throw new Error(`No session found matching '${resolved.arg}'`);
			}
			selectedSessionPath = resolved.path;
		} else if (parsed.continueSession) {
			selectedSessionPath = await getMostRecentSessionPath(localSessionDir, cwd);
		} else if (parsed.sessionIdArg) {
			selectedSessionPath = await resolveExactLocalSessionId(parsed.sessionIdArg, cwd, localSessionDir);
			selectedSessionUsesNativeId = selectedSessionPath !== undefined;
		}
	}

	const selectedSessionContext = selectedSessionPath
		? readSelectedSessionContext(selectedSessionPath, localSessionDir, cwd)
		: undefined;
	const selectedSessionRootAgent = selectedSessionContext?.rootAgent;
	let args = parsed.forkArg ? stripSessionIdArgs(parsed.args) : [...parsed.args];
	if (parsed.resumeSession) {
		const hasResumeArg = args.includes("--resume") || args.includes("-r");
		if (!hasResumeArg) {
			args.unshift("--resume");
		}
	}
	if (isBootstrapResume) {
		args = stripUserProvidedExtensions(args);
	}
	if (selectedSessionPath && !selectedSessionUsesNativeId) {
		args = ensureArg(args, "--session", selectedSessionPath);
	}
	if (selectedSessionPath) {
		if (selectedSessionRootAgent) {
			args = stripExplicitAgentArgs(args);
			args = ensureArg(args, "--agent", selectedSessionRootAgent);
		}
	}
	if (parsed.sessionDirArg !== undefined && !hasArg(args, "--session-dir")) {
		args = ensureArg(args, "--session-dir", parsed.sessionDirArg);
	}

	const agentDir = getAgentDir();
	const hasNoExtensions = args.includes("--no-extensions") || args.includes("-ne");
	if (!hasNoExtensions) {
		args.unshift("--no-extensions");
	}

	let launchRootAgent: string | undefined;
	let launchProjectTrusted: boolean | undefined;
	let launchProjectTrustCwd: string | undefined;
	if (!isBootstrapResume) {
		seedAgentConfig();
		const rootAgent = resolveLauncherRootAgent({
			parsed,
			selectedSessionRootAgent,
			agents: resolver.discoverAgents().agents,
		});
		launchRootAgent = rootAgent.name;
		args = applyRootAgentRuntimeArgs(args, rootAgent);
		const extensionResolutionCwd = selectedSessionContext?.cwd ?? cwd;
		const trust = createTrustAwareSettings({
			cwd: extensionResolutionCwd,
			agentDir,
			...(parsed.projectTrustOverride === undefined ? {} : { projectTrustOverride: parsed.projectTrustOverride }),
		});
		launchProjectTrusted = trust.projectTrusted;
		launchProjectTrustCwd = resolve(extensionResolutionCwd);
		const extensionResolutionOptions = {
			cwd: extensionResolutionCwd,
			agentDir,
			...(parsed.projectTrustOverride === undefined ? {} : { projectTrustOverride: parsed.projectTrustOverride }),
		};
		const extensionCandidates = await resolver.resolveExtensionCandidates(extensionResolutionOptions);
		writeExtensionCatalog(agentDir, extensionResolutionCwd, extensionCandidates);
		const selection = resolveLauncherExtensions(rootAgent, extensionCandidates);
		for (const warning of selection.warnings) {
			console.warn(warning);
		}
		for (const selectedExtension of selection.paths) {
			if (!hasExplicitExtensionArg(args, selectedExtension, cwd)) {
				args.push("--extension", selectedExtension);
			}
		}
	}

	if (!hasExplicitExtensionArg(args, extensionPath, cwd)) {
		args.push("--extension", extensionPath);
	}

	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	delete childEnv[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV];
	delete childEnv[MULTI_AGENTS_BOOTSTRAP_RESUME_ENV];
	delete childEnv[MULTI_AGENTS_PROJECT_TRUST_ENV];
	delete childEnv[MULTI_AGENTS_PROJECT_TRUST_CWD_ENV];
	childEnv[MULTI_AGENTS_LAUNCHER_ENV] = MULTI_AGENTS_LAUNCHER_ENV_VALUE;
	childEnv[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV] = restartRequestFile;
	if (isBootstrapResume) {
		childEnv[MULTI_AGENTS_BOOTSTRAP_RESUME_ENV] = "1";
	} else if (launchRootAgent && !selectedSessionPath) {
		childEnv[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV] = launchRootAgent;
	}
	if (launchProjectTrusted !== undefined && launchProjectTrustCwd) {
		childEnv[MULTI_AGENTS_PROJECT_TRUST_ENV] = launchProjectTrusted ? "1" : "0";
		childEnv[MULTI_AGENTS_PROJECT_TRUST_CWD_ENV] = launchProjectTrustCwd;
	}

	return {
		command: piCommand,
		args,
		env: childEnv,
		restartFile: restartRequestFile,
		sessionPathUsed: selectedSessionPath,
	};
}

export async function launchPi(args: string[], options: LauncherOptions = {}): Promise<number> {
	const restartRequestFile = options.restartRequestFile ?? createRestartRequestFilePath();

	let launchArgs = args;
	clearRestartRequestFile(restartRequestFile);
	let resultStatus = 0;
	let restartCount = 0;
	while (true) {
		const config = await buildLauncherArgs(launchArgs, {
			...options,
			restartRequestFile,
		});

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

		const restartRequest = readRestartRequestFile(restartRequestFile);
		clearRestartRequestFile(restartRequestFile);
		if (!restartRequest) {
			return resultStatus;
		}

		restartCount += 1;
		if (restartCount > 10) {
			console.warn("pi-agents: exceeded maximum number of Root-agent restarts. Aborting.");
			return 1;
		}
		launchArgs = rewriteArgsForRestart(launchArgs, restartRequest);
	}
}
