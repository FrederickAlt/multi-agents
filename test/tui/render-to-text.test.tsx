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

	it.todo("keeps unfocused option-column item windows stable when focus moves to a far-away column item");
});
