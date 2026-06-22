import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import * as mockedChildProcess from "node:child_process";
import { buildLauncherArgs, launchPi, MULTI_AGENTS_EXTENSION_ENTRY } from "../src/launcher/pi-agents.js";
import {
	MULTI_AGENTS_LAUNCHER_ENV,
	MULTI_AGENTS_LAUNCHER_ENV_VALUE,
	MULTI_AGENTS_RESTART_REQUEST_FILE_ENV,
} from "../src/subagent/launcher-contract.js";

function createSessionFile(
	sessionDir: string,
	id: string,
	customEntries: Array<Record<string, unknown>> = [],
	cwd = "/tmp/test-project",
	time: Date = new Date(),
	sessionHeaderOverrides: Record<string, unknown> = {},
) {
	const path = join(sessionDir, `${id}-${randomUUID()}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id,
		timestamp: time.toISOString(),
		cwd,
		...sessionHeaderOverrides,
	};
	const entries = [header, ...customEntries];
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	utimesSync(path, time, time);
	return path;
}

function writeAgentDefinition(agentDir: string, name: string, extensions: string[] = []) {
	const agentsDir = join(agentDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	const frontmatter: string[] = ["description: test agent"];
	if (extensions.length > 0) {
		frontmatter.push("extensions:");
		for (const entry of extensions) {
			frontmatter.push(`  - ${JSON.stringify(entry)}`);
		}
	}
	const body = `---\n${frontmatter.join("\n")}\n---\n\n## Root agent\n`;
	writeFileSync(join(agentsDir, `${name}.md`), body, "utf-8");
}

function writeAgentDir(names: string[]): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-agents-agentdir-"));
	for (const name of names) {
		writeAgentDefinition(agentDir, name);
	}
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return agentDir;
}

function createSettingsFile(path: string, data: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

function writeExtensionFile(path: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "export const extension = true;\n", "utf-8");
}

function collectExtensionValues(args: string[]): string[] {
	const extensions: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--extension") {
			const value = args[i + 1];
			if (value !== undefined) {
				extensions.push(value);
			}
			i += 1;
			continue;
		}
		if (arg.startsWith("--extension=")) {
			extensions.push(arg.slice("--extension=".length));
		}
	}
	return extensions;
}

async function withTempSessionsDir(action: (dir: string, sessionDir: string) => void | Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-"));
	const sessionDir = join(root, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	try {
		await action(root, sessionDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

let launcherAgentDir: string;

beforeEach(() => {
	launcherAgentDir = writeAgentDir(["default", "planner", "reviewer"]);
});

afterEach(() => {
	rmSync(launcherAgentDir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("pi-agents launcher command generation", () => {
	it("injects Pi launch guard env var and disables extension discovery", async () => {
		const result = await buildLauncherArgs(["--provider", "openai"]);

		expect(result.command).toBe("pi");
		expect(result.env[MULTI_AGENTS_LAUNCHER_ENV]).toBe(MULTI_AGENTS_LAUNCHER_ENV_VALUE);
		expect(result.args[0]).toBe("--no-extensions");
		expect(result.args).toContain("--extension");
		expect(result.args).toContain(MULTI_AGENTS_EXTENSION_ENTRY);
	});

	it("passes a launcher restart-request file path in child env", async () => {
		const result = await buildLauncherArgs(["--provider", "openai"], {
			restartRequestFile: "/tmp/pi-agents-restart.json",
		});
		expect(result.restartFile).toBe("/tmp/pi-agents-restart.json");
		expect(result.env[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV]).toBe("/tmp/pi-agents-restart.json");
	});

	it("launches Pi with the injected launcher arguments and env contract", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReturnValue({
			status: 0,
			signal: null,
			stdout: null,
			stderr: null,
			output: [],
			pid: 123,
		} as any);

		const code = await launchPi(["--provider", "openai"]);

		expect(code).toBe(0);
		const [command, args, options = {} as any] = spawnSyncMock.mock.calls[0];
		expect(command).toBe("pi");
		expect(args).toEqual(expect.arrayContaining(["--no-extensions", "--provider", "openai", "--extension"]));
		expect(args).toContain(MULTI_AGENTS_EXTENSION_ENTRY);
		expect(options.env?.[MULTI_AGENTS_LAUNCHER_ENV]).toBe(MULTI_AGENTS_LAUNCHER_ENV_VALUE);
	});

	it("preserves explicit user extension arguments while still injecting this package extension", async () => {
		const result = await buildLauncherArgs(["--extension", "./custom-ext.ts"]);
		const userExtensionIndex = result.args.indexOf("./custom-ext.ts");

		expect(userExtensionIndex).toBeGreaterThan(-1);
		expect(result.args[userExtensionIndex - 1]).toBe("--extension");
		expect(result.args).toContain("--extension");
		expect(result.args).toContain(MULTI_AGENTS_EXTENSION_ENTRY);
		// ensure we have exactly two extension flags now (the user one and the launcher-managed one)
		expect(result.args.filter((arg) => arg === "--extension").length).toBe(2);
	});

	it("does not add --no-extensions when user already disabled discovery", async () => {
		const result = await buildLauncherArgs(["-ne", "--extension", "./custom-ext.ts"]);
		expect(result.args.filter((arg) => arg === "--no-extensions" || arg === "-ne").length).toBe(1);
	});

	it("deduplicates explicit extension when user already passes the launcher extension", async () => {
		const result = await buildLauncherArgs(["--extension", MULTI_AGENTS_EXTENSION_ENTRY]);

		expect(result.args.filter((arg) => arg === "--extension").length).toBe(1);
		const extensionArgIndex = result.args.indexOf("--extension");
		expect(extensionArgIndex).toBeGreaterThan(-1);
		expect(result.args[extensionArgIndex + 1]).toBe(MULTI_AGENTS_EXTENSION_ENTRY);
	});

	it("filters root extensions by selector and excludes disallowed candidates", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "pi-agents-workdir-"));
		const allowedExtension = join(workDir, "extensions", "allowed", "keep-me.ts");
		const disallowedExtension = join(workDir, "extensions", "skip", "ignore-me.ts");
		writeExtensionFile(allowedExtension);
		writeExtensionFile(disallowedExtension);
		createSettingsFile(join(launcherAgentDir, "settings.json"), {
			extensions: [allowedExtension, disallowedExtension],
		});
		writeAgentDefinition(launcherAgentDir, "default", ["keep-me"]);

		try {
			const result = await buildLauncherArgs(["--provider", "openai"], { cwd: workDir });
			const selected = collectExtensionValues(result.args);
			expect(selected).toContain(allowedExtension);
			expect(selected).not.toContain(disallowedExtension);
			expect(selected).toContain(MULTI_AGENTS_EXTENSION_ENTRY);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	it("warns and loads all matches for ambiguous selector", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "pi-agents-workdir-"));
		const sharedA = join(workDir, "extensions", "shared", "a.ts");
		const sharedB = join(workDir, "extensions", "shared", "b.ts");
		writeExtensionFile(sharedA);
		writeExtensionFile(sharedB);
		createSettingsFile(join(launcherAgentDir, "settings.json"), {
			extensions: [sharedA, sharedB],
		});
		writeAgentDefinition(launcherAgentDir, "default", ["extensions/shared"]);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = await buildLauncherArgs(["--provider", "openai"], { cwd: workDir });
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("matched 2 extensions"));
			const selected = collectExtensionValues(result.args);
			expect(selected).toContain(sharedA);
			expect(selected).toContain(sharedB);
			expect(selected).toContain(MULTI_AGENTS_EXTENSION_ENTRY);
		} finally {
			warnSpy.mockRestore();
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	it("matches selectors that include relative path fragments", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "pi-agents-workdir-"));
		const target = join(workDir, "extensions", "path", "layered", "target.ts");
		writeExtensionFile(target);
		createSettingsFile(join(launcherAgentDir, "settings.json"), {
			extensions: [target],
		});
		writeAgentDefinition(launcherAgentDir, "default", ["path/layered/target.ts"]);
		try {
			const result = await buildLauncherArgs(["--provider", "openai"], { cwd: workDir });
			const selected = collectExtensionValues(result.args);
			expect(selected).toContain(target);
			expect(selected).toContain(MULTI_AGENTS_EXTENSION_ENTRY);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	it("warns when selector has no matches and does not inject filtered extension", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "pi-agents-workdir-"));
		const onlyCandidate = join(workDir, "extensions", "present", "candidate.ts");
		writeExtensionFile(onlyCandidate);
		createSettingsFile(join(launcherAgentDir, "settings.json"), {
			extensions: [onlyCandidate],
		});
		writeAgentDefinition(launcherAgentDir, "default", ["missing"]);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = await buildLauncherArgs(["--provider", "openai"], { cwd: workDir });
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No extension candidates matched selector"));
			const selected = collectExtensionValues(result.args);
			expect(selected).not.toContain(onlyCandidate);
			expect(selected).toContain(MULTI_AGENTS_EXTENSION_ENTRY);
		} finally {
			warnSpy.mockRestore();
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	it("injects protected root extension when root has no allowed extensions", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "pi-agents-workdir-"));
		const candidate = join(workDir, "extensions", "disabled", "candidate.ts");
		writeExtensionFile(candidate);
		createSettingsFile(join(launcherAgentDir, "settings.json"), {
			extensions: [candidate],
		});
		writeAgentDefinition(launcherAgentDir, "default", ["disallowed"]);
		try {
			const result = await buildLauncherArgs(["--provider", "openai"], { cwd: workDir });
			const selected = collectExtensionValues(result.args);
			expect(selected).not.toContain(candidate);
			expect(selected).toContain(MULTI_AGENTS_EXTENSION_ENTRY);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	it("does not include configured pdf-preview candidate for default Root unless explicitly allowed", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "pi-agents-workdir-"));
		const pdfPreviewExtension = join(workDir, "extensions", "pdf-preview", "viewer.ts");
		writeExtensionFile(pdfPreviewExtension);
		createSettingsFile(join(launcherAgentDir, "settings.json"), {
			extensions: [pdfPreviewExtension],
		});
		writeFileSync(
			join(launcherAgentDir, "agents", "default.md"),
			`---\ndescription: test agent\nextensions: []\n---\n\n## Default Root\n`,
			"utf-8",
		);
		try {
			const result = await buildLauncherArgs(["--provider", "openai"], { cwd: workDir });
			const selected = collectExtensionValues(result.args);
			expect(selected).not.toContain(pdfPreviewExtension);
			expect(selected).toContain(MULTI_AGENTS_EXTENSION_ENTRY);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	it("allows configured pdf-preview when default Root extension selector matches it", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "pi-agents-workdir-"));
		const pdfPreviewExtension = join(workDir, "extensions", "pdf-preview", "viewer.ts");
		writeExtensionFile(pdfPreviewExtension);
		createSettingsFile(join(launcherAgentDir, "settings.json"), {
			extensions: [pdfPreviewExtension],
		});
		writeFileSync(
			join(launcherAgentDir, "agents", "default.md"),
			`---\ndescription: test agent\nextensions:\n  - pdf-preview\n---\n\n## Default Root\n`,
			"utf-8",
		);
		try {
			const result = await buildLauncherArgs(["--provider", "openai"], { cwd: workDir });
			const selected = collectExtensionValues(result.args);
			expect(selected).toContain(pdfPreviewExtension);
			expect(selected).toContain(MULTI_AGENTS_EXTENSION_ENTRY);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	it("force-loads configured pdf-preview with explicit --extension", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "pi-agents-workdir-"));
		const pdfPreviewExtension = join(workDir, "extensions", "pdf-preview", "viewer.ts");
		writeExtensionFile(pdfPreviewExtension);
		createSettingsFile(join(launcherAgentDir, "settings.json"), {
			extensions: [pdfPreviewExtension],
		});
		writeFileSync(
			join(launcherAgentDir, "agents", "default.md"),
			`---\ndescription: test agent\nextensions: []\n---\n\n## Default Root\n`,
			"utf-8",
		);
		try {
			const result = await buildLauncherArgs(["--extension", pdfPreviewExtension], { cwd: workDir });
			const selected = collectExtensionValues(result.args);
			expect(selected).toContain(pdfPreviewExtension);
			expect(selected).toContain(MULTI_AGENTS_EXTENSION_ENTRY);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	it("preserves explicit user extension even when root filtering would remove it", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "pi-agents-workdir-"));
		const filteredCandidate = join(workDir, "extensions", "filtered", "candidate.ts");
		const forcedExtension = join(workDir, "extensions", "forced", "forced.ts");
		writeExtensionFile(filteredCandidate);
		writeExtensionFile(forcedExtension);
		createSettingsFile(join(launcherAgentDir, "settings.json"), {
			extensions: [filteredCandidate],
		});
		writeAgentDefinition(launcherAgentDir, "default", ["disallowed"]);
		try {
			const result = await buildLauncherArgs(["--extension", forcedExtension], { cwd: workDir });
			const selected = collectExtensionValues(result.args);
			expect(selected).toContain(forcedExtension);
			expect(selected).not.toContain(filteredCandidate);
			expect(selected).toContain(MULTI_AGENTS_EXTENSION_ENTRY);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	it("resolves --session id before launch and injects the session-root agent", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const selectedRootEntry = {
				type: "custom",
				customType: "selected-root-agent",
				id: "entry-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				data: { selectedRootAgent: "planner" },
			};
			const sessionPath = createSessionFile(sessionDir, "abc123", [selectedRootEntry], "/tmp/project");

			const result = await buildLauncherArgs(["--session", "abc", "--session-dir", sessionDir], { cwd: root });
			const sessionArgIdx = result.args.indexOf("--session");
			expect(sessionArgIdx).toBeGreaterThan(-1);
			expect(result.args[sessionArgIdx + 1]).toBe(sessionPath);
			expect(result.args).toContain("--agent");
			expect(result.args[result.args.indexOf("--agent") + 1]).toBe("planner");
			expect(result.sessionPathUsed).toBe(sessionPath);
		});
	});

	it("prefers session-root selection over explicit --agent for --session launch", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const selectedRootEntry = {
				type: "custom",
				customType: "selected-root-agent",
				id: "entry-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				data: { selectedRootAgent: "planner" },
			};
			const sessionPath = createSessionFile(sessionDir, "abc123", [selectedRootEntry], "/tmp/project");
			const plannerExtension = join(root, "extensions", "planner", "planner-root.ts");
			const reviewerExtension = join(root, "extensions", "reviewer", "reviewer-root.ts");
			writeExtensionFile(plannerExtension);
			writeExtensionFile(reviewerExtension);
			createSettingsFile(join(launcherAgentDir, "settings.json"), {
				extensions: [plannerExtension, reviewerExtension],
			});
			writeAgentDefinition(launcherAgentDir, "planner", ["planner-root.ts"]);
			writeAgentDefinition(launcherAgentDir, "reviewer", ["reviewer-root.ts"]);

			const result = await buildLauncherArgs(
				["--session", "abc", "--agent", "reviewer", "--session-dir", sessionDir],
				{ cwd: root },
			);
			const sessionArgIdx = result.args.indexOf("--session");
			expect(sessionArgIdx).toBeGreaterThan(-1);
			expect(result.args[sessionArgIdx + 1]).toBe(sessionPath);

			const agentArgValues: string[] = [];
			for (let i = 0; i < result.args.length; i++) {
				if (result.args[i] === "--agent") {
					agentArgValues.push(result.args[i + 1] ?? "");
					i += 1;
				}
			}
			expect(agentArgValues).toEqual(["planner"]);

			const selected = collectExtensionValues(result.args);
			expect(selected).toContain(plannerExtension);
			expect(selected).not.toContain(reviewerExtension);
			expect(selected).toContain(MULTI_AGENTS_EXTENSION_ENTRY);
			expect(result.sessionPathUsed).toBe(sessionPath);
		});
	});

	it("resolves --session path values to concrete paths", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const explicitPath = join(sessionDir, "explicit-session.jsonl");
			writeFileSync(
				explicitPath,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: "explicit",
					timestamp: new Date().toISOString(),
					cwd: "/tmp/project",
				})}\n`,
			);

			const result = await buildLauncherArgs(["--session", explicitPath, "--session-dir", sessionDir], {
				cwd: root,
			});
			const sessionArgIdx = result.args.indexOf("--session");
			expect(sessionArgIdx).toBeGreaterThan(-1);
			expect(result.args[sessionArgIdx + 1]).toBe(explicitPath);
		});
	});

	it("resolves --continue to the most recent session and falls back when none exist", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const older = new Date("2024-01-01T00:00:00.000Z");
			const newer = new Date("2024-01-02T00:00:00.000Z");
			createSessionFile(
				sessionDir,
				"old",
				[
					{
						type: "custom",
						customType: "selected-root-agent",
						id: "entry-old",
						parentId: null,
						timestamp: new Date().toISOString(),
						data: { selectedRootAgent: "planner" },
					},
				],
				"/tmp/project",
				older,
			);
			const newerSession = createSessionFile(
				sessionDir,
				"new",
				[
					{
						type: "custom",
						customType: "selected-root-agent",
						id: "entry-new",
						parentId: null,
						timestamp: new Date().toISOString(),
						data: { selectedRootAgent: "reviewer" },
					},
				],
				"/tmp/project",
				newer,
			);

			const result = await buildLauncherArgs(["--continue", "--session-dir", sessionDir], { cwd: root });
			const sessionIdx = result.args.indexOf("--session");
			expect(sessionIdx).toBeGreaterThan(-1);
			expect(result.args[sessionIdx + 1]).toBe(newerSession);
			expect(result.args[result.args.indexOf("--agent") + 1]).toBe("reviewer");

			const emptySessionDir = join(sessionDir, "empty");
			const emptyResult = await buildLauncherArgs(["--continue", "--session-dir", emptySessionDir], {
				cwd: root,
			});
			expect(emptyResult.args).not.toContain("--session");
			expect(emptyResult.args).not.toContain("--continue");
			expect(emptyResult.args).toContain("--session-dir");
			expect(emptyResult.args).toContain(emptySessionDir);
			expect(emptyResult.sessionPathUsed).toBeUndefined();
		});
	});

	it("resolves --resume via picker before launch using local plus all sessions", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const latest = createSessionFile(
				sessionDir,
				"latest",
				[],
				"/tmp/project",
				new Date("2024-02-02T00:00:00.000Z"),
			);
			const fallback = createSessionFile(
				sessionDir,
				"fallback",
				[],
				"/tmp/project",
				new Date("2024-01-01T00:00:00.000Z"),
			);
			const globalSessionDir = join(dirname(sessionDir), "other");
			mkdirSync(globalSessionDir, { recursive: true });
			const globalSession = createSessionFile(
				globalSessionDir,
				"global",
				[],
				"/tmp/other",
				new Date("2024-03-03T00:00:00.000Z"),
			);
			let observed: Array<{ path: string; id: string }> = [];
			const result = await buildLauncherArgs(["--resume", "--session-dir", sessionDir], {
				cwd: root,
				resumePicker: (sessions) => {
					observed = sessions.map((session) => ({ path: session.path, id: session.id }));
					return sessions.find((session) => session.path === globalSession)?.path;
				},
			});
			const sessionIdx = result.args.indexOf("--session");
			expect(sessionIdx).toBeGreaterThan(-1);
			expect(result.args[sessionIdx + 1]).toBe(globalSession);
			expect(result.args).not.toContain("--resume");
			expect(result.sessionPathUsed).toBe(globalSession);
			expect(result.sessionPathUsed).not.toBe(latest);
			expect(observed.map((entry) => entry.path)).toEqual(expect.arrayContaining([latest, fallback, globalSession]));
			expect(new Set(observed.map((entry) => entry.path)).size).toBe(observed.length);
		});
	});

	it("does not auto-select --resume without a picker", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			createSessionFile(sessionDir, "latest", [], "/tmp/project", new Date("2024-02-02T00:00:00.000Z"));
			const result = await buildLauncherArgs(["--resume", "--session-dir", sessionDir], { cwd: root });
			expect(result.sessionPathUsed).toBeUndefined();
			expect(result.skipLaunch).toBe(true);
			expect(result.args).not.toContain("--session");
			expect(result.args).toContain("--session-dir");
		});
	});

	it("throws for --resume + --continue conflict when building launch args", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const build = () =>
				buildLauncherArgs(["--resume", "--continue", "--session-dir", sessionDir], {
					cwd: root,
				});
			await expect(build()).rejects.toThrow("Error: --resume cannot be combined with --continue");
		});
	});

	it("throws for --resume + --session (missing value) conflict when building launch args", async () => {
		const build = () => buildLauncherArgs(["--resume", "--session"]);
		await expect(build()).rejects.toThrow("Error: --resume cannot be combined with --session");
	});

	it("throws for --resume + --session= conflict when building launch args", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const build = () =>
				buildLauncherArgs(["--resume", "--session=", "--session-dir", sessionDir], {
					cwd: root,
				});
			await expect(build()).rejects.toThrow("Error: --resume cannot be combined with --session");
		});
	});

	it("throws for --resume + --session empty string conflict when building launch args", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const build = () =>
				buildLauncherArgs(["--resume", "-s", "", "--session-dir", sessionDir], {
					cwd: root,
				});
			await expect(build()).rejects.toThrow("Error: --resume cannot be combined with --session");
		});
	});

	it("throws for --resume + -s conflict when building launch args", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const build = () =>
				buildLauncherArgs(["--resume", "-s", "abc", "--session-dir", sessionDir], {
					cwd: root,
				});
			await expect(build()).rejects.toThrow("Error: --resume cannot be combined with --session");
		});
	});

	it("throws for --resume + --session conflict when building launch args", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const build = () =>
				buildLauncherArgs(["--resume", "--session", "abc", "--session-dir", sessionDir], {
					cwd: root,
				});
			await expect(build()).rejects.toThrow("Error: --resume cannot be combined with --session");
		});
	});

	it("throws for --resume + --fork (missing value) conflict when building launch args", async () => {
		const build = () => buildLauncherArgs(["--resume", "--fork"]);
		await expect(build()).rejects.toThrow("Error: --resume cannot be combined with --fork");
	});

	it("throws for --resume + --fork= conflict when building launch args", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const build = () => buildLauncherArgs(["--resume", "--fork=", "--session-dir", sessionDir], { cwd: root });
			await expect(build()).rejects.toThrow("Error: --resume cannot be combined with --fork");
		});
	});

	it("throws for --resume + --session= conflict when building launch args", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const build = () =>
				buildLauncherArgs(["--resume", "--session=abc", "--session-dir", sessionDir], {
					cwd: root,
				});
			await expect(build()).rejects.toThrow("Error: --resume cannot be combined with --session");
		});
	});

	it("throws for --resume + --fork conflict", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const build = () =>
				buildLauncherArgs(["--resume", "--fork", "abc", "--session-dir", sessionDir], {
					cwd: root,
				});
			await expect(build()).rejects.toThrow("Error: --resume cannot be combined with --fork");
		});
	});

	it("throws for --resume combined with --continue instead of auto-selecting", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-"));
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		createSessionFile(sessionDir, "recent", [], "/tmp/project");

		try {
			await expect(
				launchPi(["--resume", "--continue", "--session-dir", sessionDir], {
					cwd: root,
				}),
			).rejects.toThrow("Error: --resume cannot be combined with --continue");
			expect(spawnSyncMock).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("throws for --resume combined with --session in runtime instead of picker", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-"));
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		createSessionFile(sessionDir, "recent", [], "/tmp/project");

		try {
			await expect(
				launchPi(["--resume", "--session", "abc", "--session-dir", sessionDir], {
					cwd: root,
				}),
			).rejects.toThrow("Error: --resume cannot be combined with --session");
			expect(spawnSyncMock).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("throws for --resume combined with --session in runtime instead of picker", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-"));
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		createSessionFile(sessionDir, "recent", [], "/tmp/project");

		try {
			await expect(
				launchPi(["--resume", "--session", "", "--session-dir", sessionDir], {
					cwd: root,
				}),
			).rejects.toThrow("Error: --resume cannot be combined with --session");
			expect(spawnSyncMock).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("throws for --resume combined with --session= in runtime instead of picker", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-"));
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		createSessionFile(sessionDir, "recent", [], "/tmp/project");

		try {
			await expect(
				launchPi(["--resume", "--session=", "--session-dir", sessionDir], {
					cwd: root,
				}),
			).rejects.toThrow("Error: --resume cannot be combined with --session");
			expect(spawnSyncMock).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("throws for --resume combined with -s empty in runtime instead of picker", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-"));
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		createSessionFile(sessionDir, "recent", [], "/tmp/project");

		try {
			await expect(
				launchPi(["--resume", "-s", "", "--session-dir", sessionDir], {
					cwd: root,
				}),
			).rejects.toThrow("Error: --resume cannot be combined with --session");
			expect(spawnSyncMock).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("throws for --resume combined with --session (missing value) in runtime instead of picker", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		try {
			await expect(launchPi(["--resume", "--session"])).rejects.toThrow(
				"Error: --resume cannot be combined with --session",
			);
			expect(spawnSyncMock).not.toHaveBeenCalled();
		} finally {
			// no temp files to clean
		}
	});

	it("throws for --resume combined with --fork in runtime", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-"));
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });

		try {
			await expect(
				launchPi(["--resume", "--fork", "abc", "--session-dir", sessionDir], {
					cwd: root,
				}),
			).rejects.toThrow("Error: --resume cannot be combined with --fork");
			expect(spawnSyncMock).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("throws for --resume combined with --fork (missing value) in runtime", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		try {
			await expect(launchPi(["--resume", "--fork"])).rejects.toThrow(
				"Error: --resume cannot be combined with --fork",
			);
			expect(spawnSyncMock).not.toHaveBeenCalled();
		} finally {
			// no temp files to clean
		}
	});

	it("throws for --resume combined with --fork= in runtime", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-"));
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });

		try {
			await expect(
				launchPi(["--resume", "--fork=", "--session-dir", sessionDir], {
					cwd: root,
				}),
			).rejects.toThrow("Error: --resume cannot be combined with --fork");
			expect(spawnSyncMock).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not auto-select for --resume without injected picker in non-interactive CLI path", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();
		const originalStdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const originalStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

		const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-"));
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		createSessionFile(sessionDir, "recent", [], "/tmp/project");

		try {
			const launchResult = await launchPi(["--resume", "--session-dir", sessionDir], {
				cwd: root,
			});
			expect(launchResult).toBe(0);
			expect(spawnSyncMock).not.toHaveBeenCalled();
		} finally {
			if (originalStdinTty) {
				Object.defineProperty(process.stdin, "isTTY", originalStdinTty);
			} else {
				delete (process.stdin as { isTTY?: boolean }).isTTY;
			}
			if (originalStdoutTty) {
				Object.defineProperty(process.stdout, "isTTY", originalStdoutTty);
			} else {
				delete (process.stdout as { isTTY?: boolean }).isTTY;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not spawn Pi when --resume picker is cancelled", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-"));
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		try {
			const launchResult = await launchPi(["--resume", "--session-dir", sessionDir], {
				cwd: root,
				resumePicker: () => null,
			});
			expect(launchResult).toBe(0);
			expect(spawnSyncMock).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("forks source session before launch and launches from the forked path", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const sourcePath = createSessionFile(sessionDir, "source", [
				{
					type: "custom",
					customType: "selected-root-agent",
					id: "entry-source",
					parentId: null,
					timestamp: new Date().toISOString(),
					data: { selectedRootAgent: "planner" },
				},
			]);
			const result = await buildLauncherArgs(["--fork", "source", "--session-dir", sessionDir], { cwd: root });
			const sessionIdx = result.args.indexOf("--session");
			expect(sessionIdx).toBeGreaterThan(-1);
			expect(result.args[sessionIdx + 1]).not.toBe(sourcePath);
			const forkPath = result.args[sessionIdx + 1];
			const forkContents = readFileSync(forkPath, "utf-8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			expect(forkContents[0].type).toBe("session");
			expect(forkContents[0].parentSession).toBe(sourcePath);
			expect(result.args[result.args.indexOf("--agent") + 1]).toBe("planner");
		});
	});

	it("restarts into a standalone root-agent session when a restart request is written", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-restart-"));
		const restartFile = join(root, "root-restart.json");
		const workDir = mkdtempSync(join(tmpdir(), "pi-agents-workdir-"));
		const defaultExtension = join(workDir, "extensions", "default.ts");
		const plannerExtension = join(workDir, "extensions", "planner.ts");
		writeExtensionFile(defaultExtension);
		writeExtensionFile(plannerExtension);
		createSettingsFile(join(launcherAgentDir, "settings.json"), {
			extensions: [defaultExtension, plannerExtension],
		});
		writeAgentDefinition(launcherAgentDir, "default", ["default.ts"]);
		writeAgentDefinition(launcherAgentDir, "planner", ["planner.ts"]);

		const spawnResult = {
			status: 0,
			signal: null,
			stdout: null,
			stderr: null,
			output: [],
			pid: 123,
		} as any;

		spawnSyncMock.mockImplementationOnce((_: any, __: any, options: any) => {
			writeFileSync(
				options.env[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV],
				`${JSON.stringify({ version: 1, requestedRootAgent: "planner" })}\n`,
				"utf-8",
			);
			return spawnResult;
		});
		spawnSyncMock.mockImplementationOnce(() => spawnResult);

		try {
			const result = await launchPi(["--provider", "openai", "--session-dir", workDir], {
				cwd: root,
				restartRequestFile: restartFile,
			});

			expect(result).toBe(0);
			expect(spawnSyncMock).toHaveBeenCalledTimes(2);
			const firstCall = spawnSyncMock.mock.calls[0];
			const secondCall = spawnSyncMock.mock.calls[1];
			const firstArgs = firstCall[1] as string[];
			const secondArgs = secondCall[1] as string[];
			const firstExtensions = collectExtensionValues(firstArgs);
			const secondExtensions = collectExtensionValues(secondArgs);
			expect(firstExtensions).toContain(defaultExtension);
			expect(firstExtensions).not.toContain(plannerExtension);
			expect(secondExtensions).toContain(plannerExtension);
			expect(secondExtensions).not.toContain(defaultExtension);
			expect(secondArgs).toContain("--agent");
			expect(secondArgs[secondArgs.indexOf("--agent") + 1]).toBe("planner");
			expect(secondArgs).not.toContain("--session");
			if (firstCall[2] && typeof firstCall[2] === "object") {
				const env = (firstCall[2] as { env?: Record<string, string | undefined> }).env;
				expect(env?.[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV]).toBe(restartFile);
			}
			if (secondCall[2] && typeof secondCall[2] === "object") {
				const env = (secondCall[2] as { env?: Record<string, string | undefined> }).env;
				expect(env?.[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV]).toBe(restartFile);
			}
			expect(existsSync(restartFile)).toBe(false);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not honor restart request after non-zero child exit", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-restart-nonzero-"));
		const restartFile = join(root, "root-restart.json");
		const workDir = mkdtempSync(join(tmpdir(), "pi-agents-workdir-"));
		const defaultExtension = join(workDir, "extensions", "default.ts");
		const plannerExtension = join(workDir, "extensions", "planner.ts");
		writeExtensionFile(defaultExtension);
		writeExtensionFile(plannerExtension);
		createSettingsFile(join(launcherAgentDir, "settings.json"), {
			extensions: [defaultExtension, plannerExtension],
		});
		writeAgentDefinition(launcherAgentDir, "default", ["default.ts"]);
		writeAgentDefinition(launcherAgentDir, "planner", ["planner.ts"]);

		const spawnResult = {
			status: 5,
			signal: null,
			stdout: null,
			stderr: null,
			output: [],
			pid: 123,
		} as any;

		spawnSyncMock.mockImplementationOnce((_: any, __: any, options: any) => {
			writeFileSync(
				options.env[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV],
				`${JSON.stringify({ version: 1, requestedRootAgent: "planner" })}\n`,
				"utf-8",
			);
			return spawnResult;
		});

		try {
			const result = await launchPi(["--provider", "openai", "--session-dir", workDir], {
				cwd: root,
				restartRequestFile: restartFile,
			});

			expect(result).toBe(5);
			expect(spawnSyncMock).toHaveBeenCalledTimes(1);
			expect(existsSync(restartFile)).toBe(false);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not honor restart request after signal-terminated child exit", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-restart-signal-"));
		const restartFile = join(root, "root-restart.json");
		const workDir = mkdtempSync(join(tmpdir(), "pi-agents-workdir-"));
		const defaultExtension = join(workDir, "extensions", "default.ts");
		const plannerExtension = join(workDir, "extensions", "planner.ts");
		writeExtensionFile(defaultExtension);
		writeExtensionFile(plannerExtension);
		createSettingsFile(join(launcherAgentDir, "settings.json"), {
			extensions: [defaultExtension, plannerExtension],
		});
		writeAgentDefinition(launcherAgentDir, "default", ["default.ts"]);
		writeAgentDefinition(launcherAgentDir, "planner", ["planner.ts"]);

		writeFileSync(restartFile, `${JSON.stringify({ version: 1, requestedRootAgent: "default" })}\n`, "utf-8");
		const spawnResult = {
			status: null,
			signal: "SIGTERM",
			stdout: null,
			stderr: null,
			output: [],
			pid: 123,
		} as any;

		spawnSyncMock.mockImplementationOnce(() => spawnResult);

		try {
			const result = await launchPi(["--provider", "openai", "--session-dir", workDir], {
				cwd: root,
				restartRequestFile: restartFile,
			});

			expect(result).toBe(128);
			expect(spawnSyncMock).toHaveBeenCalledTimes(1);
			expect(existsSync(restartFile)).toBe(false);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ contextFlag: "--fork", args: ["--fork", "source"] },
		{ contextFlag: "--continue", args: ["--continue"] },
		{ contextFlag: "--resume", args: ["--resume"] },
	])("strips prior context flag $contextFlag when honoring a restart request", async ({ contextFlag, args }) => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		await withTempSessionsDir(async (sessionRoot, sessionDir) => {
			const restartFile = join(sessionRoot, "root-restart.json");
			const sourceSessionPath = createSessionFile(sessionDir, "source", [
				{
					type: "custom",
					customType: "selected-root-agent",
					id: "entry-source",
					parentId: null,
					timestamp: new Date().toISOString(),
					data: { selectedRootAgent: "default" },
				},
			]);
			const baseArgs = ["--provider", "openai", ...args, "--session-dir", sessionDir];
			const launchArgs =
				contextFlag === "--fork"
					? ["--fork", "source", "--provider", "openai", "--session-dir", sessionDir]
					: baseArgs;
			const spawnResult = {
				status: 0,
				signal: null,
				stdout: null,
				stderr: null,
				output: [],
				pid: 123,
			} as any;
			spawnSyncMock.mockImplementationOnce((_: any, __: any, options: any) => {
				writeFileSync(
					options.env[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV],
					`${JSON.stringify({ version: 1, requestedRootAgent: "planner" })}\n`,
					"utf-8",
				);
				return spawnResult;
			});
			spawnSyncMock.mockImplementationOnce(() => spawnResult);

			const result = await launchPi(launchArgs, {
				cwd: sessionRoot,
				restartRequestFile: restartFile,
				resumePicker: contextFlag === "--resume" ? () => sourceSessionPath : undefined,
			});

			expect(result).toBe(0);
			expect(spawnSyncMock).toHaveBeenCalledTimes(2);
			const secondCall = spawnSyncMock.mock.calls[1];
			const secondArgs = secondCall[1] as string[];
			expect(secondArgs).not.toContain(contextFlag);
		});
	});
});
