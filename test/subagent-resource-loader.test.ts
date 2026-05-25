import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeDir(p: string) {
	mkdirSync(p, { recursive: true });
}

function writeFile(p: string, content: string) {
	makeDir(join(p, ".."));
	writeFileSync(p, content, "utf-8");
}

function makeSessionManager(dir: string, sessionId: string) {
	return {
		getSessionDir: () => dir,
		getSessionId: () => sessionId,
		getSessionFile: () => join(dir, `${sessionId}.jsonl`),
	};
}

describe("Task sub-agent resource loading", () => {
	let tempDir: string;
	let projectDir: string;
	let sessionDir: string;
	let agentDiscoveryDir: string;
	let constructedLoaders: Array<{ options: any; reload: () => Promise<void> }>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-task-resource-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(tempDir, "project");
		sessionDir = join(tempDir, "sessions");
		agentDiscoveryDir = join(tempDir, "agent-discovery");
		makeDir(projectDir);
		makeDir(sessionDir);
		makeDir(join(agentDiscoveryDir, "agents"));
		process.env.PI_CODING_AGENT_DIR = agentDiscoveryDir;

		// Seed a default root agent so before_agent_start can resolve the root.
		writeFile(join(agentDiscoveryDir, "agents", "default.md"), `---\ndescription: Default Root Agent\ndepth: 1\n---\n\nDefault Root Agent\n`);
		constructedLoaders = [];
		vi.resetModules();
	});

	afterEach(() => {
		vi.doUnmock("@mariozechner/pi-coding-agent");
		vi.restoreAllMocks();
		vi.resetModules();
		delete process.env.PI_CODING_AGENT_DIR;
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("disables native context-file injection while keeping context available to {{context_files}}", async () => {
		writeFile(join(projectDir, "AGENTS.md"), "PROJECT CONTEXT MARKER");
		writeFile(join(agentDiscoveryDir, "agents", "contextreader.md"), `---
description: Context reader
depth: 1
---

Sub-agent prompt.

Explicit context:
{{context_files}}
`);

		const fakeSession = {
			messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
			prompt: vi.fn().mockResolvedValue(undefined),
			abort: vi.fn(),
			dispose: vi.fn(),
			subscribe: vi.fn(() => vi.fn()),
			getActiveToolNames: () => [],
		};
		const createAgentSessionMock = vi.fn().mockResolvedValue({ session: fakeSession });

		vi.doMock("@mariozechner/pi-coding-agent", async (importOriginal) => {
			const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
			class MockDefaultResourceLoader {
				options: any;
				constructor(options: any) {
					this.options = options;
					constructedLoaders.push(this as any);
				}
				async reload() {}
			}
			return {
				...actual,
				DefaultResourceLoader: MockDefaultResourceLoader,
				createAgentSession: createAgentSessionMock,
			};
		});

		const { default: taskExtension } = await import("../subagent/index.js");
		const tools: any[] = [];
		const flags = new Map<string, string | boolean | undefined>();
		const handlers = new Map<string, any>();
		const pi = {
			on: (event: string, handler: any) => handlers.set(event, handler),
			registerTool: (tool: any) => tools.push(tool),
			registerCommand: vi.fn(),
			registerFlag: (name: string, options: { default?: string | boolean }) => flags.set(name, options.default),
			getFlag: (name: string) => flags.get(name),
		} as any;
		taskExtension(pi);

		// Fire before_agent_start to trigger Task registration via the resolved policy
		const sm = makeSessionManager(sessionDir, "root-session");
		await handlers.get("before_agent_start")({
			systemPrompt: "base prompt",
			systemPromptOptions: { cwd: projectDir },
		}, { cwd: projectDir, sessionManager: sm });

		const taskTool = tools.find((tool) => tool.name === "Task");
		expect(taskTool).toBeDefined();

		await taskTool.execute(
			"call-1",
			{
				description: "Read context",
				prompt: "Return ok",
				subagent_type: "contextreader",
				cwd: projectDir,
			},
			undefined,
			undefined,
			{
				cwd: projectDir,
				sessionManager: makeSessionManager(sessionDir, "root-session"),
				modelRegistry: {},
			},
		);

		const subagentLoader = constructedLoaders.at(-1)!;
		expect(subagentLoader.options.noContextFiles).toBe(true);
		expect(subagentLoader.options.appendSystemPromptOverride(["APPEND_SYSTEM content"])).toEqual([]);

		const childHandlers = new Map<string, any>();
		subagentLoader.options.extensionFactories[0]({
			on: (event: string, handler: any) => childHandlers.set(event, handler),
			registerTool: vi.fn(),
		} as any);

		const rendered = await childHandlers.get("before_agent_start")({
			systemPrompt: "Native Pi prompt with hidden context that must be replaced",
			systemPromptOptions: {
				selectedTools: [],
				toolSnippets: {},
				promptGuidelines: [],
				contextFiles: [],
				skills: [],
				cwd: projectDir,
				appendSystemPrompt: "APPEND_SYSTEM content",
			},
		});

		expect(rendered.systemPrompt).toContain("Sub-agent prompt.");
		expect(rendered.systemPrompt).toContain("PROJECT CONTEXT MARKER");
		expect(rendered.systemPrompt).toContain("# Subagent reporting");
		expect(rendered.systemPrompt).toContain("only receive your final assistant message");
		expect(rendered.systemPrompt).not.toContain("Native Pi prompt");
		expect(rendered.systemPrompt).not.toContain("APPEND_SYSTEM content");
	});
});
