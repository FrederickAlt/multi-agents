import { describe, expect, it } from "vitest";
import {
	getOptionColumnItems,
	getOptionColumnSelectedValues,
	normalizeOptionCheckboxSaveValues,
} from "../../src/tui/state/option-columns.js";
import type { AgentConfigState } from "../../src/tui/state/types.js";

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
});
