import { describe, expect, it } from "vitest";
import { getSupportedReasoningEfforts } from "../../src/subagent/reasoning-effort.js";
import {
	getModeSelection,
	getOptionColumnDisabledItems,
	getOptionColumnItems,
	getOptionColumnSelectedValues,
	normalizeOptionCheckboxSaveValues,
} from "../../src/tui/state/option-columns.js";
import type { AgentConfigState } from "../../src/tui/state/types.js";

describe("reasoning effort compatibility", () => {
	it("derives model-specific levels from Pi metadata", () => {
		expect(
			getSupportedReasoningEfforts({
				reasoning: true,
				thinkingLevelMap: { off: "none", xhigh: "xhigh" },
			}),
		).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
	});

	it("normalizes legacy maximum effort for fast and smart mode selection", () => {
		const agent: AgentConfigState = {
			name: "legacy-agent",
			description: "legacy",
			filePath: "/tmp/legacy-agent.md",
			frontmatter: {
				description: "legacy",
				model: "fast-model",
				reasoning_effort: "maximum",
				smart_model: "smart-model",
				smart_reasoning_effort: "maximum",
			},
			body: "",
			error: null,
			staleItems: {},
		};
		const options = {
			tools: [],
			extensions: [],
			models: [],
			defaultModel: "",
			modelDiscovery: { status: "ready" as const, error: null },
			reasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
			depths: [],
			canSpawn: [],
			skills: [],
			promptParts: [],
		};

		expect(getModeSelection(agent, options, "fast").reasoningEffort).toBe("max");
		expect(getModeSelection(agent, options, "smart").reasoningEffort).toBe("max");
	});

	it("shows Pi's effective fallback when max is unsupported by the selected model", () => {
		const agent: AgentConfigState = {
			name: "gpt-agent",
			description: "gpt",
			filePath: "/tmp/gpt-agent.md",
			frontmatter: { model: "gpt-5.4-mini", reasoning_effort: "max" },
			body: "",
			error: null,
			staleItems: {},
		};
		const options = {
			tools: [],
			extensions: [],
			models: [
				{
					provider: "openai",
					modelId: "gpt-5.4-mini",
					displayName: "gpt-5.4-mini",
					canonicalRef: "gpt-5.4-mini",
					supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"] as const,
				},
			],
			defaultModel: "gpt-5.4-mini",
			modelDiscovery: { status: "ready" as const, error: null },
			reasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
			depths: [],
			canSpawn: [],
			skills: [],
			promptParts: [],
		};

		expect(getModeSelection(agent, options).reasoningEffort).toBe("xhigh");
	});
});

describe("normalizeOptionCheckboxSaveValues", () => {
	it("normalizes extension values to a wrapper-compatible alias", () => {
		const normalized = normalizeOptionCheckboxSaveValues(
			{
				extensions: ["summarize", "legacy"],
				extensionAliases: {
					summarize: ["/tmp/extensions/summarize/dist/index.ts", "summarize", "pi-tool-summarize-replacement"],
					legacy: ["legacy"],
				},
				tools: [],
				toolExtensionNames: {},
				models: [],
				defaultModel: "",
				modelDiscovery: { status: "ready" as const, error: null },
				reasoningEfforts: ["low", "medium", "high", "maximum"],
				depths: [0, 1, 2, 3, 4],
				canSpawn: [],
				skills: [],
				promptParts: [],
			},
			"extensions",
			["pi-tool-summarize-replacement"],
		);

		expect(normalized).toEqual(["summarize"]);
	});

	it("chooses non-generic extension aliases over dist/index-like aliases", () => {
		const normalized = normalizeOptionCheckboxSaveValues(
			{
				extensions: ["summarize"],
				extensionAliases: {
					summarize: [
						"/tmp/extensions/summarize/dist/index.ts",
						"dist",
						"index.ts",
						"pi-tool-summarize-replacement",
						"summarize",
					],
				},
				tools: [],
				toolExtensionNames: {},
				models: [],
				defaultModel: "",
				modelDiscovery: { status: "ready" as const, error: null },
				reasoningEfforts: ["low", "medium", "high", "maximum"],
				depths: [0, 1, 2, 3, 4],
				canSpawn: [],
				skills: [],
				promptParts: [],
			},
			"extensions",
			["pi-tool-summarize-replacement"],
		);

		expect(normalized).toEqual(["summarize"]);
	});

	it("deduplicates extension aliases mapped to the same storage alias", () => {
		const normalized = normalizeOptionCheckboxSaveValues(
			{
				extensions: ["summarize"],
				extensionAliases: {
					summarize: [
						"/tmp/extensions/summarize/dist/index.ts",
						"dist",
						"pi-tool-summarize-replacement",
						"summarize",
					],
				},
				tools: [],
				toolExtensionNames: {},
				models: [],
				defaultModel: "",
				modelDiscovery: { status: "ready" as const, error: null },
				reasoningEfforts: ["low", "medium", "high", "maximum"],
				depths: [0],
				canSpawn: [],
				skills: [],
				promptParts: [],
			},
			"extensions",
			["pi-tool-summarize-replacement", "summarize", "pi-tool-summarize-replacement"],
		);

		expect(normalized).toEqual(["summarize"]);
	});

	it("does not change non-extension fields", () => {
		const normalized = normalizeOptionCheckboxSaveValues(
			{
				extensions: ["ext"],
				tools: ["read", "edit"],
				toolExtensionNames: {},
				models: [],
				defaultModel: "",
				modelDiscovery: { status: "ready" as const, error: null },
				reasoningEfforts: ["low", "medium", "high", "maximum"],
				depths: [0],
				canSpawn: [],
				skills: [],
				promptParts: [],
			},
			"tools",
			["edit"],
		);

		expect(normalized).toEqual(["edit"]);
	});
});

describe("Task tool depth gating", () => {
	const options = {
		extensions: [],
		tools: ["Task", "read", "bash"],
		toolExtensionNames: {},
		models: [],
		defaultModel: "",
		modelDiscovery: { status: "ready" as const, error: null },
		reasoningEfforts: ["low", "medium", "high", "maximum"],
		depths: [0, 1],
		canSpawn: [],
		skills: [],
		promptParts: [],
	};

	it("deselects Task for explicit tools when depth is zero", () => {
		const agent: AgentConfigState = {
			name: "agent-a",
			description: "test",
			filePath: "/tmp/agent-a.md",
			frontmatter: {
				description: "test",
				depth: 0,
				tools: ["Task", "read"],
			},
			body: "",
			error: null,
			staleItems: {},
		};

		expect(getOptionColumnSelectedValues(agent, options, "tools", agent.name)).toEqual(["read"]);
		expect(getOptionColumnItems(agent, options, "tools", agent.name)).toEqual(["read", "Task", "bash"]);
	});

	it("deselects Task for implicit tools when depth is zero", () => {
		const agent: AgentConfigState = {
			name: "agent-a",
			description: "test",
			filePath: "/tmp/agent-a.md",
			frontmatter: {
				description: "test",
				depth: 0,
			},
			body: "",
			error: null,
			staleItems: {},
		};

		expect(getOptionColumnSelectedValues(agent, options, "tools", agent.name)).toEqual(["read", "bash"]);
		expect(getOptionColumnItems(agent, options, "tools", agent.name)).toEqual(["read", "bash", "Task"]);
	});
});

describe("extension UI selection alias mapping", () => {
	it("maps legacy stored selector to available UI option", () => {
		const options = {
			extensions: ["summarize"],
			extensionAliases: {
				summarize: [
					"/tmp/extensions/summarize/dist/index.ts",
					"dist",
					"index.ts",
					"pi-tool-summarize-replacement",
					"summarize",
				],
			},
			tools: [],
			toolExtensionNames: {},
			models: [],
			defaultModel: "",
			modelDiscovery: { status: "ready" as const, error: null },
			reasoningEfforts: ["low", "medium", "high", "maximum"],
			depths: [0],
			canSpawn: [],
			skills: [],
			promptParts: [],
		};

		const agent: AgentConfigState = {
			name: "agent-a",
			description: "test",
			filePath: "/tmp/agent-a.md",
			frontmatter: {
				description: "test",
				extensions: ["pi-tool-summarize-replacement"],
			},
			body: "",
			error: null,
			staleItems: {},
		};

		expect(getOptionColumnSelectedValues(agent, options, "extensions")).toEqual(["summarize"]);
		expect(getOptionColumnItems(agent, options, "extensions", agent.name)).toEqual(["summarize"]);
	});

	it("shows disabled configured extensions without implicitly selecting them", () => {
		const options = {
			extensions: ["mcp-deamon", "pdf-preview"],
			disabledExtensions: ["pdf-preview"],
			tools: [],
			toolExtensionNames: {},
			models: [],
			defaultModel: "",
			modelDiscovery: { status: "ready" as const, error: null },
			reasoningEfforts: ["low", "medium", "high", "maximum"],
			depths: [0],
			canSpawn: [],
			skills: [],
			promptParts: [],
		};
		const agent: AgentConfigState = {
			name: "agent-a",
			description: "test",
			filePath: "/tmp/agent-a.md",
			frontmatter: { description: "test" },
			body: "",
			error: null,
			staleItems: {},
		};

		expect(getOptionColumnItems(agent, options, "extensions", agent.name)).toEqual(["mcp-deamon", "pdf-preview"]);
		expect(getOptionColumnSelectedValues(agent, options, "extensions")).toEqual(["mcp-deamon"]);
		expect(getOptionColumnDisabledItems(agent, options, "extensions")).toContain("pdf-preview");
	});
});
