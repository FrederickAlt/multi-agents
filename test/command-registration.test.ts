/**
 * Docs-as-contract integration tests for extension command registration.
 *
 * These tests compare the commands documented by the extension docs with the
 * commands the extension actually registers at load time.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel } from "@mariozechner/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import taskExtension from "../subagent/index.js";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const AGENTS_MD_PATH = join(PROJECT_ROOT, "AGENTS.md");
const SUBAGENT_README_PATH = join(PROJECT_ROOT, "subagent", "README.md");

function makeDir(p: string) {
	mkdirSync(p, { recursive: true });
}

function readText(path: string): string {
	return readFileSync(path, "utf-8");
}

function extractAgentsMdCommands(content: string): string[] {
	const start = content.indexOf("- **Commands**:");
	const end = content.indexOf("- **Events**:", start);
	const section = start === -1 ? "" : content.slice(start, end === -1 ? undefined : end);
	return uniqueCommands(section);
}

function extractSubagentReadmeCommands(content: string): string[] {
	const start = content.indexOf("## Commands");
	const rest = start === -1 ? "" : content.slice(start);
	const nextSection = rest.slice(1).search(/\n##\s/);
	const section = nextSection === -1 ? rest : rest.slice(0, nextSection + 1);
	return uniqueCommands(section);
}

function uniqueCommands(content: string): string[] {
	return [...new Set([...content.matchAll(/(?:`\/|^\s*\/)([a-z][a-z-]*)\b/gm)].map((match) => match[1]))].sort();
}

function documentedExtensionCommands(): string[] {
	const agentsMdCommands = extractAgentsMdCommands(readText(AGENTS_MD_PATH));
	const readmeCommands = extractSubagentReadmeCommands(readText(SUBAGENT_README_PATH));
	expect(agentsMdCommands, "AGENTS.md and subagent/README.md should document the same extension commands").toEqual(
		readmeCommands,
	);
	return agentsMdCommands;
}

async function captureRegisteredCommands(tempDir: string, agentDir: string): Promise<Map<string, any>> {
	const registeredCommands = new Map<string, any>();

	function wrapperExtension(pi: any) {
		const origRegisterCommand = pi.registerCommand.bind(pi);
		pi.registerCommand = (name: string, def: any) => {
			registeredCommands.set(name, def);
			return origRegisterCommand(name, def);
		};
		return taskExtension(pi);
	}

	const sessionManager = SessionManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir,
		extensionFactories: [wrapperExtension],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		sessionManager,
		resourceLoader,
	});
	try {
		return registeredCommands;
	} finally {
		session.dispose();
	}
}

describe("command registration docs contract", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		makeDir(agentDir);

		// Redirect in-memory session dirs to tempDir so metadata files never land
		// in the repository root.
		const origInMemory = SessionManager.inMemory.bind(SessionManager);
		vi.spyOn(SessionManager, "inMemory").mockImplementation((cwd?: string) => {
			const sm = origInMemory(cwd);
			vi.spyOn(sm, "getSessionDir").mockReturnValue(tempDir);
			return sm;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});

	it("registers exactly the extension commands documented in markdown", async () => {
		const documented = documentedExtensionCommands();
		const registered = await captureRegisteredCommands(tempDir, agentDir);

		expect([...registered.keys()].sort()).toEqual(documented);
	});

	it("documents async Task usage in subagent/README.md", () => {
		const content = readText(SUBAGENT_README_PATH);

		expect(content).toContain("wait_for_agent");
		expect(content).toContain("blocking:false");
		expect(content).toContain("## wait_for_agent");
	});

	it("registers /agent with command metadata and completions", async () => {
		const registered = await captureRegisteredCommands(tempDir, agentDir);
		const agentCmd = registered.get("agent");

		expect(agentCmd, "/agent command was not registered").toBeDefined();
		expect(agentCmd.description).toContain("agent persona");
		expect(typeof agentCmd.getArgumentCompletions).toBe("function");
	});
});
