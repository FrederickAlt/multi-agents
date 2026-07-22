import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import * as mockedChildProcess from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	buildLauncherArgs,
	launchPi,
	MULTI_AGENTS_EXTENSION_ENTRY,
	PI_AGENTS_PI_BIN_ENV,
} from "../src/launcher/pi-agents.js";
import {
	MULTI_AGENTS_BOOTSTRAP_RESUME_ENV,
	MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV,
	MULTI_AGENTS_LAUNCHER_ENV,
	MULTI_AGENTS_LAUNCHER_ENV_VALUE,
	MULTI_AGENTS_PROJECT_TRUST_CWD_ENV,
	MULTI_AGENTS_PROJECT_TRUST_ENV,
	MULTI_AGENTS_RESTART_REQUEST_FILE_ENV,
} from "../src/subagent/launcher-contract.js";

function createSessionFile(
	sessionDir: string,
	id: string,
	customEntries: Array<Record<string, unknown>> = [],
	cwd = dirname(sessionDir),
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

function writeRuntimeAgentDefinition(agentDir: string, name: string, fields: string[]): void {
	const agentsDir = join(agentDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, `${name}.md`),
		`---\ndescription: runtime test agent\n${fields.join("\n")}\n---\n\nRuntime test agent.\n`,
		"utf-8",
	);
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

	it("seeds bundled agents before discovering a fresh agent directory", async () => {
		rmSync(launcherAgentDir, { recursive: true, force: true });
		launcherAgentDir = mkdtempSync(join(tmpdir(), "pi-agents-agentdir-"));
		process.env.PI_CODING_AGENT_DIR = launcherAgentDir;

		const result = await buildLauncherArgs(["--provider", "openai"], {
			resolveExtensionCandidates: async () => [],
		});

		expect(result.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV]).toBe("default");
		expect(existsSync(join(launcherAgentDir, "agents", "default.md"))).toBe(true);
	});

	it("uses PI_AGENTS_PI_BIN to override the resolved Pi binary", async () => {
		const previous = process.env[PI_AGENTS_PI_BIN_ENV];
		process.env[PI_AGENTS_PI_BIN_ENV] = "/usr/bin/pi-custom";
		try {
			const result = await buildLauncherArgs(["--provider", "openai"]);
			expect(result.command).toBe("/usr/bin/pi-custom");
		} finally {
			if (previous === undefined) {
				delete process.env[PI_AGENTS_PI_BIN_ENV];
			} else {
				process.env[PI_AGENTS_PI_BIN_ENV] = previous;
			}
		}
	});

	it("falls back to pi when PI_AGENTS_PI_BIN points at a wrapper launcher", async () => {
		const previous = process.env[PI_AGENTS_PI_BIN_ENV];
		process.env[PI_AGENTS_PI_BIN_ENV] = "pi-agents";
		try {
			const result = await buildLauncherArgs(["--provider", "openai"]);
			expect(result.command).toBe("pi");
		} finally {
			if (previous === undefined) {
				delete process.env[PI_AGENTS_PI_BIN_ENV];
			} else {
				process.env[PI_AGENTS_PI_BIN_ENV] = previous;
			}
		}
	});

	it("lets an explicit piCommand option override the PI_AGENTS_PI_BIN env var", async () => {
		const previous = process.env[PI_AGENTS_PI_BIN_ENV];
		process.env[PI_AGENTS_PI_BIN_ENV] = "/usr/bin/pi-env";
		try {
			const result = await buildLauncherArgs(["--provider", "openai"], {
				piCommand: "/usr/bin/pi-explicit",
			});
			expect(result.command).toBe("/usr/bin/pi-explicit");
		} finally {
			if (previous === undefined) {
				delete process.env[PI_AGENTS_PI_BIN_ENV];
			} else {
				process.env[PI_AGENTS_PI_BIN_ENV] = previous;
			}
		}
	});

	it("passes a launcher restart-request file path in child env", async () => {
		const result = await buildLauncherArgs(["--provider", "openai"], {
			restartRequestFile: "/tmp/pi-agents-restart.json",
		});
		expect(result.restartFile).toBe("/tmp/pi-agents-restart.json");
		expect(result.env[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV]).toBe("/tmp/pi-agents-restart.json");
	});

	it("forwards Pi project-trust overrides to extension resolution", async () => {
		const resolveExtensionCandidates = vi.fn(async () => []);

		await buildLauncherArgs(["--approve"], { resolveExtensionCandidates });

		expect(resolveExtensionCandidates).toHaveBeenCalledWith({
			cwd: process.cwd(),
			agentDir: launcherAgentDir,
			projectTrustOverride: true,
		});
	});

	it("passes the launcher-resolved project trust and cwd to the extension", async () => {
		const result = await buildLauncherArgs(["--approve"], { cwd: process.cwd() });

		expect(result.env[MULTI_AGENTS_PROJECT_TRUST_ENV]).toBe("1");
		expect(result.env[MULTI_AGENTS_PROJECT_TRUST_CWD_ENV]).toBe(process.cwd());
	});

	it("passes launcher-resolved root agent via env when no session path is used", async () => {
		const noSessionResult = await buildLauncherArgs(["--provider", "openai"]);
		expect(noSessionResult.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV]).toBe("default");

		await withTempSessionsDir(async (root, sessionDir) => {
			const selectedRootEntry = {
				type: "custom",
				customType: "selected-root-agent",
				id: "entry-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				data: { selectedRootAgent: "planner" },
			};
			const sessionPath = createSessionFile(sessionDir, "abc123", [selectedRootEntry], root);
			const sessionResult = await buildLauncherArgs(["--session", "abc", "--session-dir", sessionDir], {
				cwd: root,
			});
			expect(sessionResult.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV]).toBeUndefined();
			expect(sessionResult.args[sessionResult.args.indexOf("--session") + 1]).toBe(sessionPath);
		});
	});

	it("applies Root agent tools, model, and thinking config to Pi arguments", async () => {
		writeRuntimeAgentDefinition(launcherAgentDir, "default", [
			"tools:",
			"  - read",
			"  - Task",
			"model: openai-codex/gpt-5.5",
			"reasoning_effort: maximum",
		]);

		const result = await buildLauncherArgs(
			["--provider", "stale-provider", "--model", "stale-model", "--thinking", "low", "--no-tools"],
			{ resolveExtensionCandidates: async () => [] },
		);

		expect(result.args).not.toContain("stale-provider");
		expect(result.args).not.toContain("stale-model");
		expect(result.args).not.toContain("--no-tools");
		expect(result.args[result.args.indexOf("--tools") + 1]).toBe("read,Task");
		expect(result.args[result.args.indexOf("--model") + 1]).toBe("openai-codex/gpt-5.5");
		expect(result.args[result.args.indexOf("--thinking") + 1]).toBe("max");
	});

	it("uses Root smart model and thinking config when present", async () => {
		writeRuntimeAgentDefinition(launcherAgentDir, "default", [
			"model: fast-model",
			"reasoning_effort: low",
			"smart_model: smart-model",
			"smart_reasoning_effort: high",
		]);

		const result = await buildLauncherArgs([], { resolveExtensionCandidates: async () => [] });

		expect(result.args[result.args.indexOf("--model") + 1]).toBe("smart-model");
		expect(result.args[result.args.indexOf("--thinking") + 1]).toBe("high");
	});

	it("maps an explicit empty Root tool list to --no-tools", async () => {
		writeRuntimeAgentDefinition(launcherAgentDir, "default", ["tools: []"]);

		const result = await buildLauncherArgs(["--tools", "read,bash"], {
			resolveExtensionCandidates: async () => [],
		});

		expect(result.args).not.toContain("--tools");
		expect(result.args).not.toContain("read,bash");
		expect(result.args).toContain("--no-tools");
	});

	it("preserves user tool arguments when the Root agent inherits Pi defaults", async () => {
		const result = await buildLauncherArgs(["--tools", "read,bash"], {
			resolveExtensionCandidates: async () => [],
		});

		expect(result.args[result.args.indexOf("--tools") + 1]).toBe("read,bash");
	});

	it("does not leak stale launcher root env when launching with --session", async () => {
		const previous = process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV];
		process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV] = "stale-root";
		try {
			await withTempSessionsDir(async (root, sessionDir) => {
				const sessionPath = createSessionFile(sessionDir, "abc123", [], root);
				const sessionResult = await buildLauncherArgs(["--session", "abc", "--session-dir", sessionDir], {
					cwd: root,
				});
				expect(sessionResult.sessionPathUsed).toBe(sessionPath);
				expect(sessionResult.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV]).toBeUndefined();
			});
		} finally {
			if (previous === undefined) {
				delete process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV];
			} else {
				process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV] = previous;
			}
		}
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

	it("does not relaunch a Pi resource that settings marked disabled", async () => {
		const disabledExtension = join(launcherAgentDir, "extensions", "disabled.ts");
		writeExtensionFile(disabledExtension);
		writeAgentDefinition(launcherAgentDir, "default", ["disabled"]);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = await buildLauncherArgs([], {
				resolveExtensionCandidates: async () => [
					{
						path: disabledExtension,
						enabled: false,
						metadata: { source: "local", scope: "user", origin: "top-level" },
					},
				],
			});

			expect(collectExtensionValues(result.args)).not.toContain(disabledExtension);
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No extension candidates matched selector"));
		} finally {
			warnSpy.mockRestore();
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
			const sessionPath = createSessionFile(sessionDir, "abc123", [selectedRootEntry], root);

			const result = await buildLauncherArgs(["--session", "abc", "--session-dir", sessionDir], { cwd: root });
			const sessionArgIdx = result.args.indexOf("--session");
			expect(sessionArgIdx).toBeGreaterThan(-1);
			expect(result.args[sessionArgIdx + 1]).toBe(sessionPath);
			expect(result.args).toContain("--agent");
			expect(result.args[result.args.indexOf("--agent") + 1]).toBe("planner");
			expect(result.sessionPathUsed).toBe(sessionPath);
		});
	});

	it("prefers an exact session id over a longer prefix match", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const exactSession = createSessionFile(sessionDir, "abc", [], root, new Date("2024-01-01T00:00:00.000Z"));
			createSessionFile(sessionDir, "abc123", [], root, new Date("2024-01-02T00:00:00.000Z"));

			const result = await buildLauncherArgs(["--session", "abc", "--session-dir", sessionDir], {
				cwd: root,
			});

			expect(result.sessionPathUsed).toBe(exactSession);
			expect(result.args[result.args.indexOf("--session") + 1]).toBe(exactSession);
		});
	});

	it("uses an existing exact native --session-id for Root context without adding --session", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const selectedRootEntry = {
				type: "custom",
				customType: "selected-root-agent",
				id: "entry-native-id",
				parentId: null,
				timestamp: new Date().toISOString(),
				data: { selectedRootAgent: "planner" },
			};
			const sessionPath = createSessionFile(sessionDir, "native-id", [selectedRootEntry], root);

			const result = await buildLauncherArgs(["--session-id=native-id", "--session-dir", sessionDir], {
				cwd: root,
			});

			expect(result.sessionPathUsed).toBe(sessionPath);
			expect(result.args).not.toContain("--session");
			expect(result.args[result.args.indexOf("--session-id") + 1]).toBe("native-id");
			expect(result.args[result.args.indexOf("--agent") + 1]).toBe("planner");
		});
	});

	it("leaves a missing native --session-id for Pi to create and allows ephemeral IDs", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const persistent = await buildLauncherArgs(["--session-id=new-id", "--session-dir", sessionDir], {
				cwd: root,
			});
			const ephemeral = await buildLauncherArgs(
				["--no-session", "--session-id", "ephemeral-id", "--session-dir", sessionDir],
				{ cwd: root },
			);

			expect(persistent.sessionPathUsed).toBeUndefined();
			expect(persistent.args[persistent.args.indexOf("--session-id") + 1]).toBe("new-id");
			expect(ephemeral.args).toContain("--no-session");
			expect(ephemeral.args[ephemeral.args.indexOf("--session-id") + 1]).toBe("ephemeral-id");
		});
	});

	it.each(["--session", "--continue", "--resume"])(
		"rejects native --session-id combined with %s",
		async (conflict) => {
			const args =
				conflict === "--session"
					? ["--session-id", "target", conflict, "source"]
					: ["--session-id", "target", conflict];
			await expect(buildLauncherArgs(args)).rejects.toThrow(
				`Error: --session-id cannot be combined with ${conflict}`,
			);
		},
	);

	it("resolves extensions against the selected session cwd", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const sessionCwd = mkdtempSync(join(tmpdir(), "pi-agents-session-cwd-"));
			const sessionPath = createSessionFile(sessionDir, "other-project", [], sessionCwd);
			const resolveExtensionCandidates = vi.fn(async () => []);

			try {
				await buildLauncherArgs(["--session", sessionPath, "--session-dir", sessionDir], {
					cwd: root,
					resolveExtensionCandidates,
				});

				expect(resolveExtensionCandidates).toHaveBeenCalledWith({
					cwd: sessionCwd,
					agentDir: launcherAgentDir,
				});
			} finally {
				rmSync(sessionCwd, { recursive: true, force: true });
			}
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
			const sessionPath = createSessionFile(sessionDir, "abc123", [selectedRootEntry], root);
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
				root,
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
				root,
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

	it("passes --resume to bootstrap launch and does not preselect a session", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			const rootConfigExtension = join(root, "extensions", "configured.ts");
			writeExtensionFile(rootConfigExtension);
			createSettingsFile(join(launcherAgentDir, "settings.json"), {
				extensions: [rootConfigExtension],
			});
			const userForcedExtension = join(root, "ext", "forced.ts");
			writeExtensionFile(userForcedExtension);

			const result = await buildLauncherArgs(
				["--resume", "--extension", userForcedExtension, "--session-dir", sessionDir],
				{
					cwd: root,
				},
			);
			const extensions = collectExtensionValues(result.args);
			expect(result.args).toContain("--resume");
			expect(result.args).not.toContain("--session");
			expect(result.sessionPathUsed).toBeUndefined();
			expect(extensions).toContain(MULTI_AGENTS_EXTENSION_ENTRY);
			expect(extensions).not.toContain(rootConfigExtension);
			expect(extensions).not.toContain(userForcedExtension);
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

	it("buildLauncherArgs resolves --resume bootstrap without a valid default root agent", async () => {
		const previous = process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV];
		process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV] = "stale-root";
		try {
			const discoverAgents = vi.fn(() => ({ agents: [] }));
			const result = await buildLauncherArgs(["--resume", "--defaultRootAgent", "missing-root"], {
				discoverAgentsForLauncher: discoverAgents,
			});
			expect(result.args).toContain("--resume");
			expect(result.env[MULTI_AGENTS_BOOTSTRAP_RESUME_ENV]).toBe("1");
			expect(result.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV]).toBeUndefined();
			expect(discoverAgents).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) {
				delete process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV];
			} else {
				process.env[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV] = previous;
			}
		}
	});

	it("starts a bootstrap pi for --resume without wrapper picker interception", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-"));
		const workDir = mkdtempSync(join(tmpdir(), "pi-agents-workdir-"));
		const userForcedExtension = join(workDir, "user-forced.ts");
		const configuredExtension = join(workDir, "configured.ts");
		writeExtensionFile(userForcedExtension);
		writeExtensionFile(configuredExtension);
		createSettingsFile(join(launcherAgentDir, "settings.json"), {
			extensions: [configuredExtension],
		});
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		createSessionFile(sessionDir, "recent", [], "/tmp/project");

		const spawnResult = {
			status: 0,
			signal: null,
			stdout: null,
			stderr: null,
			output: [],
			pid: 123,
		} as any;
		spawnSyncMock.mockImplementationOnce(() => spawnResult);
		try {
			const launchResult = await launchPi(
				["--resume", "--extension", userForcedExtension, "--session-dir", sessionDir],
				{
					cwd: root,
				},
			);
			expect(launchResult).toBe(0);
			expect(spawnSyncMock).toHaveBeenCalledTimes(1);
			const firstCallArgs = spawnSyncMock.mock.calls[0][1] as string[];
			const firstCallEnv = spawnSyncMock.mock.calls[0][2] as { env?: Record<string, string | undefined> };
			expect(firstCallArgs).toContain("--resume");
			expect(firstCallArgs).not.toContain("--session");
			expect(collectExtensionValues(firstCallArgs)).toEqual([MULTI_AGENTS_EXTENSION_ENTRY]);
			expect(firstCallEnv?.env?.[MULTI_AGENTS_BOOTSTRAP_RESUME_ENV]).toBe("1");
			expect(firstCallEnv?.env?.[MULTI_AGENTS_INITIAL_ROOT_AGENT_ENV]).toBeUndefined();
			expect(collectExtensionValues(firstCallArgs).includes(configuredExtension)).toBe(false);
			expect(collectExtensionValues(firstCallArgs).includes(userForcedExtension)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	it("rejects --no-session combined with --fork", async () => {
		await expect(buildLauncherArgs(["--no-session", "--fork", "source"])).rejects.toThrow(
			"Error: --fork cannot be combined with --no-session",
		);
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

	it("uses native --session-id as the target ID when forking", async () => {
		await withTempSessionsDir(async (root, sessionDir) => {
			createSessionFile(sessionDir, "source", [], root);

			const result = await buildLauncherArgs(
				["--fork", "source", "--session-id=target-id", "--session-dir", sessionDir],
				{ cwd: root },
			);
			const forkPath = result.args[result.args.indexOf("--session") + 1];
			const header = JSON.parse(readFileSync(forkPath, "utf-8").split("\n")[0]);

			expect(header.id).toBe("target-id");
			expect(result.args).not.toContain("--session-id");
		});
	});

	it("derives extension resolution cwd from the forked session", async () => {
		const getCwdSpy = vi.spyOn(SessionManager.prototype, "getCwd");
		try {
			await withTempSessionsDir(async (root, sessionDir) => {
				createSessionFile(sessionDir, "source", [], root);
				const resolveExtensionCandidates = vi.fn(async () => []);

				const result = await buildLauncherArgs(["--fork", "source", "--session-dir", sessionDir], {
					cwd: root,
					resolveExtensionCandidates,
				});
				const forkPath = result.sessionPathUsed;

				expect(forkPath).toBeDefined();
				expect(
					getCwdSpy.mock.contexts.some((manager) => (manager as SessionManager).getSessionFile() === forkPath),
				).toBe(true);
				expect(resolveExtensionCandidates).toHaveBeenCalledWith({
					cwd: root,
					agentDir: launcherAgentDir,
				});
			});
		} finally {
			getCwdSpy.mockRestore();
		}
	});

	it.each([true, false])("restarts a session with the selected project trust (%s)", async (projectTrusted) => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();
		await withTempSessionsDir(async (root, sessionDir) => {
			const restartFile = join(root, "trust-restart.json");
			const sessionPath = createSessionFile(sessionDir, "trust-target", [], root);
			const spawnResult = {
				status: 0,
				signal: null,
				stdout: null,
				stderr: null,
				output: [],
				pid: 123,
			} as any;

			spawnSyncMock.mockImplementationOnce((_: any, __: any, spawnOptions: any) => {
				writeFileSync(
					spawnOptions.env[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV],
					`${JSON.stringify({ version: 1, type: "trust", sessionPath, sessionId: "trust-target", projectTrusted })}\n`,
				);
				return spawnResult;
			});
			spawnSyncMock.mockImplementationOnce(() => spawnResult);

			await launchPi(
				[
					projectTrusted ? "--no-approve" : "--approve",
					"--agent",
					"planner",
					"--session-id",
					"stale",
					"--session-dir",
					sessionDir,
				],
				{ cwd: root, restartRequestFile: restartFile },
			);

			const secondArgs = spawnSyncMock.mock.calls[1][1] as string[];
			expect(secondArgs[secondArgs.indexOf("--session") + 1]).toBe(sessionPath);
			expect(secondArgs).toContain(projectTrusted ? "--approve" : "--no-approve");
			expect(secondArgs).not.toContain(projectTrusted ? "--no-approve" : "--approve");
			expect(secondArgs).not.toContain("--session-id");
			expect(secondArgs[secondArgs.indexOf("--agent") + 1]).toBe("planner");
		});
	});

	it.each([false, true])("preserves a fresh trust-restart session ID (no-session=%s)", async (noSession) => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();
		await withTempSessionsDir(async (root, sessionDir) => {
			const restartFile = join(root, "fresh-trust-restart.json");
			const spawnResult = {
				status: 0,
				signal: null,
				stdout: null,
				stderr: null,
				output: [],
				pid: 123,
			} as any;

			spawnSyncMock.mockImplementationOnce((_: any, __: any, spawnOptions: any) => {
				writeFileSync(
					spawnOptions.env[MULTI_AGENTS_RESTART_REQUEST_FILE_ENV],
					`${JSON.stringify({
						version: 1,
						type: "trust",
						...(noSession ? {} : { sessionPath: join(sessionDir, "prospective-session.jsonl") }),
						sessionId: "fresh-trust-id",
						projectTrusted: true,
					})}\n`,
				);
				return spawnResult;
			});
			spawnSyncMock.mockImplementationOnce(() => spawnResult);

			await launchPi(
				[...(noSession ? ["--no-session"] : []), "--session-id", "fresh-trust-id", "--session-dir", sessionDir],
				{ cwd: root, restartRequestFile: restartFile },
			);

			const secondArgs = spawnSyncMock.mock.calls[1][1] as string[];
			expect(secondArgs).not.toContain("--session");
			expect(secondArgs[secondArgs.indexOf("--session-id") + 1]).toBe("fresh-trust-id");
			expect(secondArgs[secondArgs.indexOf("--session-dir") + 1]).toBe(sessionDir);
			expect(secondArgs.includes("--no-session")).toBe(noSession);
			expect(secondArgs).toContain("--approve");
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
			const result = await launchPi(
				["--provider", "openai", "--session-id", "stale-agent-session", "--session-dir", workDir],
				{
					cwd: root,
					restartRequestFile: restartFile,
				},
			);

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
			expect(secondArgs).not.toContain("--session-id");
			expect(secondArgs).not.toContain("stale-agent-session");
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

	it("restarts into a selected session with a resume-session restart request", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-resume-restart-"));
		const restartFile = join(root, "resume-restart.json");
		const workDir = mkdtempSync(join(tmpdir(), "pi-agents-workdir-"));
		const defaultExtension = join(workDir, "extensions", "default.ts");
		const plannerExtension = join(workDir, "extensions", "planner.ts");
		const userForcedExtension = join(workDir, "extensions", "forced.ts");
		writeExtensionFile(defaultExtension);
		writeExtensionFile(plannerExtension);
		writeExtensionFile(userForcedExtension);
		createSettingsFile(join(launcherAgentDir, "settings.json"), {
			extensions: [defaultExtension, plannerExtension],
		});
		writeAgentDefinition(launcherAgentDir, "default", ["default.ts"]);
		writeAgentDefinition(launcherAgentDir, "planner", ["planner.ts"]);

		const sessionDir = join(workDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		type SessionEntry = { [key: string]: unknown };
		const selectedSessionPath = createSessionFile(
			sessionDir,
			"resume-target",
			[
				{
					type: "custom",
					customType: "selected-root-agent",
					id: "entry-target",
					parentId: null,
					timestamp: new Date().toISOString(),
					data: { selectedRootAgent: "planner" },
				} as SessionEntry,
			],
			"/tmp/project",
		);

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
				`${JSON.stringify({ version: 1, type: "resume-session", sessionPath: selectedSessionPath })}\n`,
				"utf-8",
			);
			return spawnResult;
		});
		spawnSyncMock.mockImplementationOnce(() => spawnResult);

		try {
			const result = await launchPi(
				["--session-id=stale-resume-session", "--extension", userForcedExtension, "--session-dir", workDir],
				{
					cwd: root,
					restartRequestFile: restartFile,
				},
			);

			expect(result).toBe(0);
			expect(spawnSyncMock).toHaveBeenCalledTimes(2);
			const firstCallArgs = spawnSyncMock.mock.calls[0][1] as string[];
			expect(collectExtensionValues(firstCallArgs)).toEqual(
				expect.arrayContaining([defaultExtension, userForcedExtension, MULTI_AGENTS_EXTENSION_ENTRY]),
			);
			const secondArgs = spawnSyncMock.mock.calls[1][1] as string[];
			const secondExtensions = collectExtensionValues(secondArgs);
			expect(secondExtensions).toContain(plannerExtension);
			expect(secondExtensions).toContain(userForcedExtension);
			expect(secondExtensions).not.toContain(defaultExtension);
			expect(secondArgs).toContain("--session");
			expect(secondArgs[secondArgs.indexOf("--session") + 1]).toBe(selectedSessionPath);
			expect(secondArgs).toContain("--agent");
			expect(secondArgs[secondArgs.indexOf("--agent") + 1]).toBe("planner");
			expect(secondArgs).not.toContain("--session-id=stale-resume-session");
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

	it("strips stale --session-dir when honoring a resume-session restart request", async () => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-resume-session-dir-restart-"));
		const restartFile = join(root, "resume-restart-session-dir.json");
		const workDir = mkdtempSync(join(tmpdir(), "pi-agents-workdir-"));
		const oldSessionDir = mkdtempSync(join(tmpdir(), "pi-agents-old-session-dir-"));
		const selectedSessionDir = mkdtempSync(join(tmpdir(), "pi-agents-selected-session-dir-"));
		const defaultExtension = join(workDir, "extensions", "default.ts");
		const plannerExtension = join(workDir, "extensions", "planner.ts");
		writeExtensionFile(defaultExtension);
		writeExtensionFile(plannerExtension);
		createSettingsFile(join(launcherAgentDir, "settings.json"), {
			extensions: [defaultExtension, plannerExtension],
		});
		writeAgentDefinition(launcherAgentDir, "default", ["default.ts"]);
		writeAgentDefinition(launcherAgentDir, "planner", ["planner.ts"]);

		type SessionEntry = { [key: string]: unknown };
		const selectedSessionPath = createSessionFile(
			selectedSessionDir,
			"resume-target",
			[
				{
					type: "custom",
					customType: "selected-root-agent",
					id: "entry-target",
					parentId: null,
					timestamp: new Date().toISOString(),
					data: { selectedRootAgent: "planner" },
				} as SessionEntry,
			],
			"/tmp/project",
		);

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
				`${JSON.stringify({ version: 1, type: "resume-session", sessionPath: selectedSessionPath })}\n`,
				"utf-8",
			);
			return spawnResult;
		});
		spawnSyncMock.mockImplementationOnce(() => spawnResult);

		try {
			const result = await launchPi(["--provider", "openai", "--session-dir", oldSessionDir], {
				cwd: root,
				restartRequestFile: restartFile,
			});

			expect(result).toBe(0);
			expect(spawnSyncMock).toHaveBeenCalledTimes(2);
			const secondCall = spawnSyncMock.mock.calls[1];
			const secondArgs = secondCall[1] as string[];
			expect(secondArgs.some((arg) => arg === "--session-dir" || arg.startsWith("--session-dir="))).toBe(false);
			expect(secondArgs).toContain("--session");
			expect(secondArgs[secondArgs.indexOf("--session") + 1]).toBe(selectedSessionPath);
			expect(secondArgs).toContain("--agent");
			expect(secondArgs[secondArgs.indexOf("--agent") + 1]).toBe("planner");
			expect(secondArgs).not.toContain(oldSessionDir);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			rmSync(oldSessionDir, { recursive: true, force: true });
			rmSync(selectedSessionDir, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ contextFlag: "--fork", args: ["--fork", "source"] },
		{ contextFlag: "--continue", args: ["--continue"] },
		{ contextFlag: "--resume", args: ["--resume"] },
		{ contextFlag: "--session", args: ["--session", "source"] },
	])("strips prior context flag $contextFlag when honoring a restart request", async ({ contextFlag, args }) => {
		const spawnSyncMock = vi.mocked(mockedChildProcess.spawnSync);
		spawnSyncMock.mockReset();

		await withTempSessionsDir(async (sessionRoot, sessionDir) => {
			const restartFile = join(sessionRoot, "root-restart.json");
			const _sourceSessionPath = createSessionFile(sessionDir, "source", [
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
			});

			expect(result).toBe(0);
			expect(spawnSyncMock).toHaveBeenCalledTimes(2);
			const secondCall = spawnSyncMock.mock.calls[1];
			const secondArgs = secondCall[1] as string[];
			expect(secondArgs).not.toContain(contextFlag);
		});
	});
});
