import React from "react";
import { Box, Text } from "ink";
import { describe, expect, it } from "vitest";
import { Board } from "../../src/tui/components/Board.js";
import { renderToText } from "../../src/tui/dev/render-to-text.js";
import type { AgentConfigState, ConfigState, DiscoveredOptions } from "../../src/tui/state/types.js";

const options: DiscoveredOptions = {
	tools: ["read", "bash", "write", "edit", "grep", "find", "sed", "awk", "cat", "ls", "pwd"],
	extensions: [],
	models: [
		{ provider: "anthropic", modelId: "claude", displayName: "Claude", canonicalRef: "anthropic/claude" },
	],
	defaultModel: "Claude",
	modelDiscovery: {
		status: "ready",
		error: null,
	},
	reasoningEfforts: ["low", "medium", "high", "maximum"],
	depths: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
	canSpawn: [],
	skills: [],
	promptParts: [],
};

function agent(name: string): AgentConfigState {
	return {
		name,
		description: `${name} description`,
		filePath: `/tmp/${name}.md`,
		frontmatter: {
			tools: ["read"],
			model: "anthropic/claude",
			depth: 0,
		},
		body: "",
		error: null,
		staleItems: {},
	};
}

function state(overrides: Partial<ConfigState> = {}): ConfigState {
	return {
		agents: [agent("default")],
		options,
		focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 0 },
		expandedAgentIndex: 0,
		overlay: null,
		statuses: new Map(),
		scrollOffset: 0,
		optionColumnScrollOffset: 0,
		optionColumnFilter: "",
		globalError: null,
		...overrides,
	};
}

describe("renderToText", () => {
	it("captures Ink layout as plain text", async () => {
		const text = await renderToText(
			<Box borderStyle="single" paddingX={1}>
				<Text>Hello TUI</Text>
			</Box>,
			{ columns: 24, rows: 8 },
		);

		expect(text).toContain("Hello TUI");
		expect(text).toContain("┌");
		expect(text).not.toContain("\u001B[");
	});

	it("renders compact parse-error rows at board width", async () => {
		const brokenAgent = {
			...agent("broken"),
			error: "Invalid YAML: line: - 010-tools",
		};
		const text = await renderToText(
			<Board
				state={state({
					agents: [brokenAgent],
					expandedAgentIndex: null,
				})}
			/>,
			{ columns: 80, rows: 8 },
		);

		const nameLine = text.split("\n").find((line) => line.includes("broken"));
		expect(nameLine?.length).toBeGreaterThan(60);
		expect(text).toContain("Invalid YAML");
		expect(text).not.toContain("Edit the file manually");
	});

	it("captures expanded agent board columns for shell-visible diagnostics", async () => {
		const text = await renderToText(
			<Board
				state={state({
					focus: { agentIndex: 0, fieldIndex: 4, optionItemIndex: 10 },
					expandedAgentIndex: 0,
					optionColumnScrollOffset: 0,
				})}
			/>,
			{ columns: 120, rows: 30 },
		);

		expect(text).toContain("default — default description");
		expect(text).toContain("tools");
		expect(text).toContain("model");
		expect(text).toContain("←/→ columns");
	});

	it("keeps long option names from wrapping over option-column headers", async () => {
		const text = await renderToText(
			<Board
				state={state({
					focus: { agentIndex: 0, fieldIndex: 7, optionItemIndex: 2 },
					expandedAgentIndex: 0,
					optionColumnScrollOffset: 5,
					agents: [
						{
							...agent("default"),
							frontmatter: {
								...agent("default").frontmatter,
								prompt_parts: ["010-tools", "020-runtime-context"],
							},
						},
					],
					options: {
						...options,
						canSpawn: ["explorer", "reviewer", "planner"],
						skills: ["typescript", "testing"],
						promptParts: ["010-tools", "020-runtime-context", "030-project-guidelines"],
					},
				})}
			/>,
			{ columns: 120, rows: 30 },
		);

		expect(text).toContain("prompt_parts");
		expect(text).toContain("030-project");
		expect(text).not.toContain("idelines");
	});

	it("keeps unfocused option-column item windows stable when focus moves to a far-away column item", async () => {
		const text = await renderToText(
			<Board
				state={state({
					focus: { agentIndex: 0, fieldIndex: 4, optionItemIndex: 10 },
					expandedAgentIndex: 0,
					optionColumnScrollOffset: 0,
					options: {
						...options,
						models: [
							{ provider: "p", modelId: "m0", displayName: "model-0", canonicalRef: "m0" },
							{ provider: "p", modelId: "m1", displayName: "model-1", canonicalRef: "m1" },
							{ provider: "p", modelId: "m2", displayName: "model-2", canonicalRef: "m2" },
							{ provider: "p", modelId: "m3", displayName: "model-3", canonicalRef: "m3" },
							{ provider: "p", modelId: "m4", displayName: "model-4", canonicalRef: "m4" },
							{ provider: "p", modelId: "m5", displayName: "model-5", canonicalRef: "m5" },
							{ provider: "p", modelId: "m6", displayName: "model-6", canonicalRef: "m6" },
							{ provider: "p", modelId: "m7", displayName: "model-7", canonicalRef: "m7" },
							{ provider: "p", modelId: "m8", displayName: "model-8", canonicalRef: "m8" },
							{ provider: "p", modelId: "m9", displayName: "model-9", canonicalRef: "m9" },
							{ provider: "p", modelId: "m10", displayName: "model-10", canonicalRef: "m10" },
						],
					},
				})}
			/>,
			{ columns: 120, rows: 30 },
		);

		expect(text).toContain("model-10");
		expect(text).toContain("☑ read");
		expect(text).toContain("☐ write");
		expect(text).not.toContain("☐ cat");
	});
});
