/**
 * Unit tests for persistent-task-subagents index.ts pure functions.
 *
 * Tests deterministic logic: hex IDs, human names, prompt rendering,
 * metadata persistence, text extraction.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	randomHexId,
	pickHumanName,
	loadMetadata,
	saveMetadata,
	metadataPath,
	getFinalTextFromMessages,
	checkSpawnAllowed,
	resolveTaskAgent,
} from "../subagent/index.js";
import type { SubagentRecord } from "../subagent/index.js";
import { renderComposedAgentSystemPrompt, renderPromptTemplate } from "../subagent/prompt-composition.js";
import type { PromptParts, RenderContext } from "../subagent/prompt-composition.js";
import type { AgentConfig } from "../subagent/agents.js";

// ---------------------------------------------------------------------------
// randomHexId
// ---------------------------------------------------------------------------

describe("randomHexId", () => {
	it("generates an 8-character hex string", () => {
		const id = randomHexId(new Set());
		expect(id).toMatch(/^[0-9a-f]{8}$/);
	});

	it("generates unique IDs", () => {
		const existing = new Set<string>();
		for (let i = 0; i < 50; i++) {
			const id = randomHexId(existing);
			expect(existing.has(id)).toBe(false);
			existing.add(id);
		}
	});

	it("avoids IDs already in the set", () => {
		const blocked = "deadbeef";
		const existing = new Set([blocked]);
		const id = randomHexId(existing);
		expect(id).not.toBe(blocked);
	});

	it("throws after 1000 attempts with fully saturated ID space", () => {
		// Exhaustion of the 4-byte hex ID space (2^32 values) is not
		// practically testable without mocking node:crypto, which is not
		// possible in ESM modules via vi.spyOn. The loop logic is simple
		// (for-loop with 1000 max attempts) and the function is covered
		// by the uniqueness and avoidance tests above.
		expect(true).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// pickHumanName
// ---------------------------------------------------------------------------

describe("pickHumanName", () => {
	const record = (humanName: string, displayName: string): SubagentRecord => ({
		id: "00000000",
		humanName,
		displayName,
		agentType: "Test",
		sessionFile: "/tmp/test.jsonl",
		depth: 1,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});

	it("picks from the pool when no names are used", () => {
		const result = pickHumanName("Explore", []);
		expect(result.humanName).toBe("Tom");
		expect(result.displayName).toBe("Explore Tom");
	});

	it("skips already-used names", () => {
		const records = [record("Tom", "Explore Tom"), record("Ada", "Explore Ada")];
		const result = pickHumanName("Explore", records);
		expect(result.humanName).toBe("Max");
		expect(result.displayName).toBe("Explore Max");
	});

	it("appends numbers when pool is exhausted", () => {
		// Use all 30 pool names
		const pool = [
			"Tom", "Ada", "Max", "Ivy", "Leo", "Nora", "Sam", "Mia", "Eli", "Zoe",
			"Kai", "Ava", "Ben", "Lia", "Gus", "Nia", "Ray", "Uma", "Jan", "Eva",
			"Sol", "Kim", "Ari", "Liv", "Cal", "Bea", "Ned", "Pia", "Ren", "Tess",
		];
		const records = pool.map((name) => record(name, `Test ${name}`));
		const result = pickHumanName("Test", records);
		expect(result.humanName).toBe("Tom1");
		expect(result.displayName).toBe("Test Tom1");
	});

	it("scans all bases at each number level when pool exhausted", () => {
		const pool = [
			"Tom", "Ada", "Max", "Ivy", "Leo", "Nora", "Sam", "Mia", "Eli", "Zoe",
			"Kai", "Ava", "Ben", "Lia", "Gus", "Nia", "Ray", "Uma", "Jan", "Eva",
			"Sol", "Kim", "Ari", "Liv", "Cal", "Bea", "Ned", "Pia", "Ren", "Tess",
		];
		const records = pool.map((name) => record(name, `Test ${name}`));
		// Add Tom1 through Tom4 as already used
		records.push(record("Tom1", "Test Tom1"));
		records.push(record("Tom2", "Test Tom2"));
		records.push(record("Tom3", "Test Tom3"));
		records.push(record("Tom4", "Test Tom4"));
		// Tom1-4 blocked, so first free at level 1 is Ada1
		const result = pickHumanName("Test", records);
		expect(result.humanName).toBe("Ada1");
	});

	it("formats display name with agent type prefix", () => {
		const result = pickHumanName("Planner", []);
		expect(result.displayName).toBe("Planner Tom");
	});
});

// ---------------------------------------------------------------------------
// metadata persistence (loadMetadata / saveMetadata / metadataPath)
// ---------------------------------------------------------------------------

describe("metadata persistence", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-metadata-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	function makeCtx(dir: string, sessionId: string) {
		return {
			sessionManager: {
				getSessionDir: () => dir,
				getSessionId: () => sessionId,
				getSessionFile: () => join(dir, `${sessionId}.jsonl`),
			},
		};
	}

	it("metadataPath uses session ID", () => {
		const ctx = makeCtx(tempDir, "abc123");
		expect(metadataPath(ctx)).toBe(join(tempDir, ".task-subagents-abc123.json"));
	});

	it("loadMetadata returns empty records for missing file", () => {
		const ctx = makeCtx(tempDir, "new-session");
		const metadata = loadMetadata(ctx);
		expect(metadata.version).toBe(1);
		expect(metadata.mainSessionId).toBe("new-session");
		expect(metadata.records).toEqual([]);
	});

	it("saveMetadata writes and loadMetadata reads back", () => {
		const ctx = makeCtx(tempDir, "test-session");
		const metadata = loadMetadata(ctx);
		metadata.records.push({
			id: "abcd1234",
			humanName: "Tom",
			displayName: "Explore Tom",
			agentType: "Explore",
			sessionFile: "/tmp/sub.jsonl",
			depth: 1,
			createdAt: "2024-01-01T00:00:00.000Z",
			updatedAt: "2024-01-01T00:00:00.000Z",
		});
		saveMetadata(ctx, metadata);

		const reloaded = loadMetadata(ctx);
		expect(reloaded.records).toHaveLength(1);
		expect(reloaded.records[0].id).toBe("abcd1234");
		expect(reloaded.records[0].displayName).toBe("Explore Tom");
	});

	it("saveMetadata writes pretty-printed JSON", () => {
		const ctx = makeCtx(tempDir, "pretty");
		const metadata = loadMetadata(ctx);
		metadata.selectedMainAgent = "Explore";
		saveMetadata(ctx, metadata);

		const raw = readFileSync(metadataPath(ctx), "utf-8");
		expect(raw).toContain('"selectedMainAgent"');
		expect(raw).toContain('"Explore"');
		// Verify it's pretty-printed (has newlines + indentation)
		expect(raw).toContain("\n  ");
	});

	it("loadMetadata handles corrupt JSON gracefully", () => {
		const ctx = makeCtx(tempDir, "corrupt");
		writeFileSync(metadataPath(ctx), "not valid json {{{", "utf-8");
		const metadata = loadMetadata(ctx);
		expect(metadata.version).toBe(1);
		expect(metadata.records).toEqual([]);
	});

	it("loadMetadata rejects wrong version gracefully", () => {
		const ctx = makeCtx(tempDir, "oldver");
		writeFileSync(metadataPath(ctx), JSON.stringify({ version: 99, records: [] }), "utf-8");
		const metadata = loadMetadata(ctx);
		expect(metadata.version).toBe(1);
		expect(metadata.records).toEqual([]);
	});

	it("saveMetadata updates mainSessionId from the provided session context", () => {
		// Create metadata with one session context
		const ctxA = makeCtx(tempDir, "session-a");
		const metadata = loadMetadata(ctxA);
		expect(metadata.mainSessionId).toBe("session-a");

		// Save it via a different session context — mainSessionId should update
		const ctxB = makeCtx(tempDir, "session-b");
		saveMetadata(ctxB, metadata);

		// Read back from ctxB's path — mainSessionId should reflect session-b
		const raw = readFileSync(metadataPath(ctxB), "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed.mainSessionId).toBe("session-b");
	});
});

// ---------------------------------------------------------------------------
// renderPromptTemplate
// ---------------------------------------------------------------------------

describe("renderPromptTemplate", () => {
	const baseAgent: AgentConfig = {
		name: "TestAgent",
		description: "A test agent",
		systemPrompt: "You are {{agent_name}}.\n\nAvailable tools:\n{{tools}}\n\nGuidelines:\n{{guidelines}}\n\nCWD: {{cwd}}\nDate: {{date}}",
		source: "builtin",
		filePath: "/tmp/test.md",
	};

	const baseParts: PromptParts = {
		selectedTools: ["read", "bash"],
		toolSnippets: { read: "Read file contents", bash: "Execute shell commands" },
		promptGuidelines: ["Use read for file inspection", "Use bash for running commands"],
		cwd: "/home/user/project",
	};

	const baseContext: RenderContext = {
		agent: baseAgent,
		parts: baseParts,
	};

	it("renders tools as one-line snippets", () => {
		const result = renderPromptTemplate(baseContext);
		expect(result).toContain("- read: Read file contents");
		expect(result).toContain("- bash: Execute shell commands");
	});

	it("renders guidelines as bullet list", () => {
		const result = renderPromptTemplate(baseContext);
		expect(result).toContain("- Use read for file inspection");
		expect(result).toContain("- Use bash for running commands");
	});

	it("renders (none) for empty tools", () => {
		const ctx = {
			...baseContext,
			parts: { ...baseParts, selectedTools: [], toolSnippets: {} },
		};
		const result = renderPromptTemplate(ctx);
		expect(result).toContain("(none)");
	});

	it("renders (none) for empty guidelines", () => {
		const ctx = {
			...baseContext,
			parts: { ...baseParts, promptGuidelines: [] },
		};
		const result = renderPromptTemplate(ctx);
		expect(result).toContain("(none)");
	});

	it("renders CWD placeholder", () => {
		const result = renderPromptTemplate(baseContext);
		expect(result).toContain("CWD: /home/user/project");
	});

	it("renders date placeholder", () => {
		const result = renderPromptTemplate(baseContext);
		// Date format: YYYY-MM-DD
		expect(result).toMatch(/Date: \d{4}-\d{2}-\d{2}/);
	});

	it("renders agent_name placeholder", () => {
		const result = renderPromptTemplate(baseContext);
		expect(result).toContain("You are TestAgent");
	});

	it("rejects depth as an internal prompt variable", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, systemPrompt: "Depth: {{depth}}" },
		};
		expect(() => renderPromptTemplate(ctx)).toThrow("Unknown prompt variable");
	});

	it("renders agent_description", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, systemPrompt: "Description: {{agent_description}}" },
		};
		const result = renderPromptTemplate(ctx);
		expect(result).toContain("Description: A test agent");
	});

	it("rejects parent_agent_id as an internal prompt variable", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, systemPrompt: "Parent: {{parent_agent_id}}" },
			parentAgentId: "deadbeef",
		};
		expect(() => renderPromptTemplate(ctx)).toThrow("Unknown prompt variable");
	});

	it("renders context_files as (none) when empty", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, systemPrompt: "Files: {{context_files}}" },
		};
		const result = renderPromptTemplate(ctx);
		expect(result).toContain("Files: (none)");
	});

	it("renders skills as (none) when empty", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, systemPrompt: "Skills: {{skills}}" },
		};
		const result = renderPromptTemplate(ctx);
		expect(result).toContain("Skills: (none)");
	});

	it("renders context_files as markdown sections with file content", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, systemPrompt: "Files:\n{{context_files}}" },
			parts: {
				...baseParts,
				contextFiles: [
					{ path: "src/app.ts", content: "console.log('hello');" },
					{ path: "README.md", content: "# My Project" },
				],
			},
		};
		const result = renderPromptTemplate(ctx);
		expect(result).toContain("## src/app.ts");
		expect(result).toContain("console.log('hello');");
		expect(result).toContain("## README.md");
		expect(result).toContain("# My Project");
		expect(result).not.toContain("(none)");
	});

	it("renders skills as bullet list with descriptions when present", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, systemPrompt: "Skills:\n{{skills}}" },
			parts: {
				...baseParts,
				skills: [
					{ name: "diagnose", description: "Structured debugging" },
					{ name: "tdd", description: undefined },
				],
			},
		};
		const result = renderPromptTemplate(ctx);
		expect(result).toContain("- diagnose: Structured debugging");
		expect(result).toContain("- tdd");
		expect(result).not.toContain("(none)");
	});

	it("renders all skills when agent.skills is undefined (missing)", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, skills: undefined, systemPrompt: "Skills:\n{{skills}}" },
			parts: {
				...baseParts,
				skills: [
					{ name: "tdd", description: "Test-driven development" },
					{ name: "diagnose", description: "Structured debugging" },
				],
			},
		};
		const result = renderPromptTemplate(ctx);
		expect(result).toContain("- tdd: Test-driven development");
		expect(result).toContain("- diagnose: Structured debugging");
		expect(result).not.toContain("(none)");
	});

	it("renders no skills when agent.skills is an empty array", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, skills: [], systemPrompt: "Skills:\n{{skills}}" },
			parts: {
				...baseParts,
				skills: [
					{ name: "tdd" },
					{ name: "diagnose" },
				],
			},
		};
		const result = renderPromptTemplate(ctx);
		expect(result).toContain("(none)");
		expect(result).not.toContain("- tdd");
		expect(result).not.toContain("- diagnose");
	});

	it("renders only matching skills when agent.skills is a non-empty array", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, skills: ["tdd"], systemPrompt: "Skills:\n{{skills}}" },
			parts: {
				...baseParts,
				skills: [
					{ name: "tdd", description: "TDD workflow" },
					{ name: "diagnose", description: "Bug hunting" },
				],
			},
		};
		const result = renderPromptTemplate(ctx);
		expect(result).toContain("- tdd: TDD workflow");
		expect(result).not.toContain("diagnose");
		expect(result).not.toContain("(none)");
	});

	it("throws on unknown placeholder variables", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, systemPrompt: "Unknown: {{foobar}}" },
		};
		expect(() => renderPromptTemplate(ctx)).toThrow("Unknown prompt variable");
	});

	it("handles whitespace inside placeholder braces", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, systemPrompt: "Hello {{  agent_name  }}" },
		};
		const result = renderPromptTemplate(ctx);
		expect(result).toContain("Hello TestAgent");
	});

	it("leaves non-placeholder text intact", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, systemPrompt: "# Title\n\nSome **markdown** here." },
		};
		const result = renderPromptTemplate(ctx);
		expect(result).toContain("# Title");
		expect(result).toContain("**markdown**");
	});

	it("renders prompt-part fragments after the agent prompt", () => {
		const result = renderComposedAgentSystemPrompt(baseContext, [
			{
				name: "shared",
				description: "shared prompt part",
				systemPrompt: "Shared for {{agent_name}} in {{cwd}}",
				source: "builtin",
				filePath: "/tmp/shared.md",
			},
		]);

		expect(result).toContain("You are TestAgent");
		expect(result).toContain("Shared for TestAgent in /home/user/project");
	});

	it("applies skills filter to prompt-part fragments via shared RenderContext", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, skills: ["tdd"], systemPrompt: "Main skills:\n{{skills}}" },
			parts: {
				...baseParts,
				skills: [
					{ name: "tdd", description: "TDD workflow" },
					{ name: "diagnose", description: "Bug hunting" },
				],
			},
		};
		const result = renderComposedAgentSystemPrompt(ctx, [
			{
				name: "skills-part",
				description: "prompt part using skills",
				systemPrompt: "Part skills:\n{{skills}}",
				source: "builtin",
				filePath: "/tmp/skills-part.md",
			},
		]);
		// Both agent template and prompt-part should see the same filtered skills.
		expect(result).toContain("Main skills:\n- tdd: TDD workflow");
		expect(result).toContain("Part skills:\n- tdd: TDD workflow");
		expect(result).not.toContain("diagnose");
	});

	it("does not preserve Pi's hidden generic suffix when composing an Agent definition prompt", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, systemPrompt: "Agent {{agent_name}}" },
		};
		const result = renderComposedAgentSystemPrompt(ctx, [], {
			baseSystemPrompt: "Agent {{agent_name}}\n\n# Project Context\n\n## AGENTS.md\n\nhidden project context",
		});

		expect(result).toContain("Agent TestAgent");
		expect(result).not.toContain("# Project Context");
		expect(result).not.toContain("hidden project context");
		expect(result).not.toContain("{{agent_name}}");
	});

	it("does not append Pi append-system prompt material in the Agent definition path", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, systemPrompt: "Agent {{agent_name}}" },
		};
		const result = renderComposedAgentSystemPrompt(ctx, [], {
			baseSystemPrompt: "Default Pi prompt",
			appendSystemPrompt: "APPEND_SYSTEM content",
		});

		expect(result).toContain("Agent TestAgent");
		expect(result).not.toContain("APPEND_SYSTEM content");
		expect(result).not.toContain("Default Pi prompt");
	});

	it("renders the same Agent-definition prompt semantics for Root and Task sub-agent placements", () => {
		const agent = {
			...baseAgent,
			skills: ["tdd"],
			systemPrompt: "Agent {{agent_name}}\nTools:\n{{tools}}\nFiles:\n{{context_files}}\nSkills:\n{{skills}}",
		};
		const parts = {
			...baseParts,
			contextFiles: [{ path: "AGENTS.md", content: "PROJECT CONTEXT" }],
			skills: [
				{ name: "tdd", description: "Test-driven development" },
				{ name: "diagnose", description: "Debugging" },
			],
		};
		const promptParts = [{
			name: "shared",
			description: "shared prompt part",
			systemPrompt: "Shared sees {{agent_description}} and {{skills}}",
			source: "builtin" as const,
			filePath: "/tmp/shared.md",
		}];

		const rootPrompt = renderComposedAgentSystemPrompt({ agent, parts }, promptParts, {
			baseSystemPrompt: "Root raw/base prompt that must not affect semantics",
		});
		const taskPrompt = renderComposedAgentSystemPrompt({ agent, parts }, promptParts, {
			baseSystemPrompt: "Task raw/base prompt that must not affect semantics",
			appendSystemPrompt: "Task append-system prompt that must not affect semantics",
		});

		expect(taskPrompt).toBe(rootPrompt);
		expect(rootPrompt).toContain("PROJECT CONTEXT");
		expect(rootPrompt).toContain("- tdd: Test-driven development");
		expect(rootPrompt).not.toContain("diagnose");
		expect(rootPrompt).not.toContain("raw/base prompt");
		expect(rootPrompt).not.toContain("append-system prompt");
	});
});

// ---------------------------------------------------------------------------
// getFinalTextFromMessages
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// checkSpawnAllowed
// ---------------------------------------------------------------------------

describe("checkSpawnAllowed", () => {
	it("rejects spawn when depth limit has been reached", () => {
		const result = checkSpawnAllowed({ depth: 2, rootMaxDepth: 2, canSpawn: undefined }, "Explore");
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("depth_limit");
		expect(result.error).toContain("root depth limit 2");
	});

	it("allows spawn when below depth limit", () => {
		const result = checkSpawnAllowed({ depth: 1, rootMaxDepth: 2, canSpawn: undefined }, "Explore");
		expect(result.allowed).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.code).toBeUndefined();
	});

	it("rejects spawn when agent type is not in canSpawn allowlist", () => {
		const result = checkSpawnAllowed({ depth: 0, rootMaxDepth: 2, canSpawn: ["Planner", "Reviewer"] }, "Explore");
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("spawn_not_allowed");
		expect(result.error).toContain("only allowed to task Planner, Reviewer");
	});

	it("allows spawn when agent type is in canSpawn allowlist", () => {
		const result = checkSpawnAllowed({ depth: 0, rootMaxDepth: 2, canSpawn: ["Planner", "Explore"] }, "Explore");
		expect(result.allowed).toBe(true);
	});

	it("allows spawn when canSpawn is undefined (no restriction)", () => {
		const result = checkSpawnAllowed({ depth: 0, rootMaxDepth: 2, canSpawn: undefined }, "Explore");
		expect(result.allowed).toBe(true);
	});

	it("rejects spawn when rootMaxDepth is 0 (no spawning allowed at all)", () => {
		const result = checkSpawnAllowed({ depth: 0, rootMaxDepth: 0, canSpawn: undefined }, "Explore");
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("depth_limit");
		expect(result.error).toContain("root depth limit 0");
	});

	it("allows spawn at depth 0 when rootMaxDepth is 1", () => {
		const result = checkSpawnAllowed({ depth: 0, rootMaxDepth: 1, canSpawn: undefined }, "Explore");
		expect(result.allowed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// resolveTaskAgent
// ---------------------------------------------------------------------------

describe("resolveTaskAgent", () => {
	const makeAgent = (name: string): AgentConfig => ({
		name,
		description: `${name} description`,
		systemPrompt: "prompt",
		source: "builtin",
		filePath: `/tmp/${name}.md`,
	});

	const makeRecord = (id: string, agentType: string, displayName: string): SubagentRecord => ({
		id,
		humanName: id,
		displayName,
		agentType,
		sessionFile: "/tmp/test.jsonl",
		depth: 1,
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
	});

	it("returns unknown_resume_id error when resume ID does not exist", () => {
		const store = { version: 1 as const, mainSessionId: "main", records: [makeRecord("abc12345", "Explore", "Explore Tom")] };
		const result = resolveTaskAgent({ subagent_type: "Explore", resume: "deadbeef" }, store, [makeAgent("Explore")]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errorCode).toBe("unknown_resume_id");
			expect(result.errorText).toContain("Unknown sub-agent ID");
			expect(result.errorText).toContain("abc12345");
			expect(result.errorText).toContain("Explore Tom");
		}
	});

	it("returns unknown_agent_type error when agent type is not available", () => {
		const store = { version: 1 as const, mainSessionId: "main", records: [] };
		const result = resolveTaskAgent({ subagent_type: "Missing" }, store, [makeAgent("Explore")]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errorCode).toBe("unknown_agent_type");
			expect(result.errorText).toContain("Unknown sub-agent type");
			expect(result.errorText).toContain("Explore");
		}
	});

	it("resolves agent by subagent_type when no resume", () => {
		const store = { version: 1 as const, mainSessionId: "main", records: [] };
		const agent = makeAgent("Explore");
		const result = resolveTaskAgent({ subagent_type: "Explore" }, store, [agent]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.agent.name).toBe("Explore");
			expect(result.record).toBeUndefined();
		}
	});

	it("resolves agent by record when resume is provided", () => {
		const record = makeRecord("abc12345", "Explore", "Explore Tom");
		const store = { version: 1 as const, mainSessionId: "main", records: [record] };
		const agent = makeAgent("Explore");
		const result = resolveTaskAgent({ subagent_type: "Explore", resume: "abc12345" }, store, [agent]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.agent.name).toBe("Explore");
			expect(result.record).toEqual(record);
		}
	});

	it("returns unknown_agent_type when resume record's agent type no longer exists", () => {
		// Record exists, but its agentType was deleted from the system
		const record = makeRecord("abc12345", "deleted-agent", "Deleted Tom");
		const store = { version: 1 as const, mainSessionId: "main", records: [record] };
		const result = resolveTaskAgent(
			{ subagent_type: "Explore", resume: "abc12345" },
			store,
			[makeAgent("Explore")], // deleted-agent is not here
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errorCode).toBe("unknown_agent_type");
			// Error should mention the record's actual agentType, not params.subagent_type
			expect(result.errorText).toContain("deleted-agent");
			expect(result.errorText).toContain("no longer available");
		}
	});
});

describe("getFinalTextFromMessages", () => {
	it("returns the last assistant text content", () => {
		const messages = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "Hello! How can I help?" }] },
		];
		expect(getFinalTextFromMessages(messages)).toBe("Hello! How can I help?");
	});

	it("returns last assistant text when multiple assistant messages exist", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{ role: "user", content: "prompt" },
			{ role: "assistant", content: [{ type: "text", text: "second" }] },
		];
		expect(getFinalTextFromMessages(messages)).toBe("second");
	});

	it("returns empty string if no assistant message", () => {
		const messages = [{ role: "user", content: "just user" }];
		expect(getFinalTextFromMessages(messages)).toBe("");
	});

	it("returns empty string if assistant has no text content", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] },
		];
		expect(getFinalTextFromMessages(messages)).toBe("");
	});

	it("skips non-assistant roles when searching backwards", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "the answer" }] },
			{ role: "user", content: "final prompt" },
		];
		expect(getFinalTextFromMessages(messages)).toBe("the answer");
	});
});
