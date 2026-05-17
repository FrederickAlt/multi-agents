import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import taskExtension from "../subagent/index.js";

function makeSessionManager(dir: string, sessionId: string) {
	return {
		getSessionDir: () => dir,
		getSessionId: () => sessionId,
		getSessionFile: () => join(dir, `${sessionId}.jsonl`),
	};
}

function createFakePi() {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const commands = new Map<string, any>();
	const flags = new Map<string, string | boolean | undefined>();
	const allTools: any[] = [{ name: "read", description: "Read file contents", parameters: {} }];
	let activeTools = ["read"];
	const pi = {
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: any) {
			allTools.push(tool);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		registerFlag(name: string, options: { default?: string | boolean }) {
			flags.set(name, options.default);
		},
		getFlag: (name: string) => flags.get(name),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		getAllTools: () => [...allTools],
	} as any;
	return { pi, handlers, commands };
}

describe("integrated dump-prompt command", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dump-prompt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		delete (globalThis as any).__multi_agents_selected_main_agent;
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("dumps the selected Root agent prompt without a provider turn", async () => {
		const { pi, commands } = createFakePi();
		taskExtension(pi);
		let notification = "";
		const ctx = {
			cwd: tempDir,
			sessionManager: makeSessionManager(tempDir, "selected-dump-session"),
			ui: { notify: (message: string) => { notification = message; } },
			newSession: async () => ({ cancelled: true }),
		};

		await commands.get("agent").handler("explorer", ctx);
		await commands.get("dump-prompt").handler("", ctx);

		expect(notification).toContain("CURRENT MULTI-AGENTS SYSTEM PROMPT");
		expect(notification).toContain("You are a scout.");
		expect(notification).not.toContain("You are an expert coding assistant operating inside pi");
	});

	it("clears the last provider prompt on session_start", async () => {
		const { pi, handlers, commands } = createFakePi();
		taskExtension(pi);
		let notification = "";
		const ctx = {
			cwd: tempDir,
			sessionManager: makeSessionManager(tempDir, "clear-provider-dump-session"),
			getSystemPrompt: () => "Stale Default Provider Prompt",
			ui: { notify: (message: string) => { notification = message; } },
			newSession: async () => ({ cancelled: true }),
		};

		await commands.get("agent").handler("explorer", ctx);
		for (const handler of handlers.get("before_provider_request") ?? []) {
			await handler({}, ctx);
		}
		for (const handler of handlers.get("session_start") ?? []) {
			await handler({ type: "session_start", reason: "startup" }, ctx);
		}
		await commands.get("dump-prompt").handler("", ctx);

		expect(notification).toContain("You are a scout.");
		expect(notification).not.toContain("Stale Default Provider Prompt");
	});
});
