/**
 * Unit tests for prompt rendering helpers.
 */
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/subagent/agents.js";
import type { PromptParts, RenderContext } from "../src/subagent/prompt-composition.js";
import {
	renderComposedAgentSystemPrompt,
	renderPromptTemplate,
	SUBAGENT_REPORTING_NOTICE,
} from "../src/subagent/prompt-composition.js";

// ---------------------------------------------------------------------------
// renderPromptTemplate
// ---------------------------------------------------------------------------

describe("renderPromptTemplate", () => {
	const baseAgent: AgentConfig = {
		name: "TestAgent",
		description: "A test agent",
		systemPrompt:
			"You are {{agent_name}}.\n\nAvailable tools:\n{{tools}}\n\nGuidelines:\n{{guidelines}}\n\nCWD: {{cwd}}\nDate: {{date}}",
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
				skills: [{ name: "tdd" }, { name: "diagnose" }],
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

	it("injects the subagent reporting notice only when requested", () => {
		const ctx = {
			...baseContext,
			agent: { ...baseAgent, systemPrompt: "Agent {{agent_name}}" },
		};
		const rootPrompt = renderComposedAgentSystemPrompt(ctx, []);
		const childPrompt = renderComposedAgentSystemPrompt(ctx, [], {
			includeSubagentReportingNotice: true,
		});

		expect(rootPrompt).not.toContain(SUBAGENT_REPORTING_NOTICE);
		expect(childPrompt).toBe(`Agent TestAgent\n\n${SUBAGENT_REPORTING_NOTICE}`);
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
		const promptParts = [
			{
				name: "shared",
				description: "shared prompt part",
				systemPrompt: "Shared sees {{agent_description}} and {{skills}}",
				source: "builtin" as const,
				filePath: "/tmp/shared.md",
			},
		];

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
// renderSubagentSystemPrompt — prompt_parts filtering (tri-state)
// ---------------------------------------------------------------------------

describe("renderSubagentSystemPrompt prompt_parts filtering", () => {
	const baseAgent: AgentConfig = {
		name: "TestAgent",
		description: "A test agent",
		systemPrompt: "Agent {{agent_name}}",
		source: "user",
		filePath: "/tmp/test.md",
	};

	const baseParts: PromptParts = {
		cwd: "/tmp",
	};

	const promptParts = [
		{
			name: "010-tools",
			description: "Tool info",
			systemPrompt: "Tools context for {{agent_name}}",
			source: "user" as const,
			filePath: "/tmp/010-tools.md",
		},
		{
			name: "020-runtime-context",
			description: "Runtime context",
			systemPrompt: "Runtime context for {{agent_name}} in {{cwd}}",
			source: "user" as const,
			filePath: "/tmp/020-runtime-context.md",
		},
		{
			name: "030-guidelines",
			description: "Guidelines",
			systemPrompt: "Guidelines for {{agent_name}}",
			source: "user" as const,
			filePath: "/tmp/030-guidelines.md",
		},
	];

	it("includes all prompt parts when agent.prompt_parts is undefined", () => {
		const agent = { ...baseAgent, prompt_parts: undefined };
		const ctx: RenderContext = { agent, parts: baseParts };
		const result = renderComposedAgentSystemPrompt(ctx, promptParts);
		expect(result).toContain("Tools context for TestAgent");
		expect(result).toContain("Runtime context for TestAgent in /tmp");
		expect(result).toContain("Guidelines for TestAgent");
	});

	it("includes no prompt parts when agent.prompt_parts is empty array", () => {
		const agent = { ...baseAgent, prompt_parts: [] };
		const ctx: RenderContext = { agent, parts: baseParts };
		const result = renderComposedAgentSystemPrompt(ctx, promptParts);
		expect(result).toContain("Agent TestAgent");
		expect(result).not.toContain("Tools context");
		expect(result).not.toContain("Runtime context");
		expect(result).not.toContain("Guidelines");
	});

	it("includes only matching prompt parts when agent.prompt_parts is a non-empty list", () => {
		const agent = { ...baseAgent, prompt_parts: ["010-tools", "020-runtime-context"] };
		const ctx: RenderContext = { agent, parts: baseParts };
		const result = renderComposedAgentSystemPrompt(ctx, promptParts);
		expect(result).toContain("Tools context for TestAgent");
		expect(result).toContain("Runtime context for TestAgent in /tmp");
		expect(result).not.toContain("Guidelines");
	});

	it("includes only a single matching part when prompt_parts filters to one", () => {
		const agent = { ...baseAgent, prompt_parts: ["030-guidelines"] };
		const ctx: RenderContext = { agent, parts: baseParts };
		const result = renderComposedAgentSystemPrompt(ctx, promptParts);
		expect(result).not.toContain("Tools context");
		expect(result).not.toContain("Runtime context");
		expect(result).toContain("Guidelines for TestAgent");
	});

	it("includes no prompt parts when prompt_parts list has no matches", () => {
		const agent = { ...baseAgent, prompt_parts: ["non-existent"] };
		const ctx: RenderContext = { agent, parts: baseParts };
		const result = renderComposedAgentSystemPrompt(ctx, promptParts);
		expect(result).toContain("Agent TestAgent");
		expect(result).not.toContain("Tools context");
		expect(result).not.toContain("Runtime context");
		expect(result).not.toContain("Guidelines");
	});
});

// ---------------------------------------------------------------------------
// getFinalTextFromMessages
// ---------------------------------------------------------------------------
