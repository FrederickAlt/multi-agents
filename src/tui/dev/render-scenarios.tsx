import React from "react";
import { Board } from "../components/Board.js";
import { MODEL_OPTION_DEGRADED_STATUS } from "../state/option-columns.js";
import type { AgentConfigState, ConfigState, DiscoveredOptions } from "../state/types.js";
import { renderToText } from "./render-to-text.js";

const options: DiscoveredOptions = {
	tools: ["read", "bash", "write", "edit", "grep", "find", "sed", "awk", "cat", "ls", "pwd"],
	extensions: ["multi-agents", "theme-pack"],
	models: [
		{ provider: "anthropic", modelId: "claude-haiku", displayName: "Claude Haiku", canonicalRef: "anthropic/claude-haiku" },
		{ provider: "anthropic", modelId: "claude-sonnet", displayName: "Claude Sonnet", canonicalRef: "anthropic/claude-sonnet" },
		{ provider: "openai", modelId: "gpt-5", displayName: "GPT-5", canonicalRef: "openai/gpt-5" },
	],
	defaultModel: "Claude Sonnet",
	modelDiscovery: {
		status: "ready",
		error: null,
	},
	reasoningEfforts: ["low", "medium", "high", "maximum"],
	depths: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
	canSpawn: ["coder", "explorer", "reviewer", "planner", "math-agent", "orchstrator"],
	skills: ["typescript", "react", "testing", "docs"],
	promptParts: ["010-tools", "020-runtime-context", "030-project-guidelines"],
};

function agent(name: string): AgentConfigState {
	return {
		name,
		description: `${name} description`,
		filePath: `/tmp/${name}.md`,
		frontmatter: {
			tools: ["read", "bash"],
			extensions: [],
			model: "anthropic/claude-sonnet",
			reasoning_effort: "high",
			depth: 0,
			can_spawn: ["coder"],
			skills: ["typescript"],
			prompt_parts: ["010-tools", "020-runtime-context"],
		},
		body: "",
		error: null,
		staleItems: {},
	};
}

function state(overrides: Partial<ConfigState> = {}): ConfigState {
	return {
		agents: [agent("default"), agent("explorer"), agent("coder")],
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

const scenarios: Array<{ name: string; state: ConfigState }> = [
	{
		name: "expanded row, first column focused",
		state: state({
			focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 0 },
			optionColumnScrollOffset: 0,
		}),
	},
	{
		name: "expanded row, far option item focused",
		state: state({
			focus: { agentIndex: 0, fieldIndex: 4, optionItemIndex: 10 },
			optionColumnScrollOffset: 0,
		}),
	},
	{
		name: "expanded row, horizontally scrolled columns",
		state: state({
			focus: { agentIndex: 0, fieldIndex: 7, optionItemIndex: 2 },
			optionColumnScrollOffset: 5,
		}),
	},
	{
		name: "expanded row, degraded model discovery status",
		state: state({
			focus: { agentIndex: 0, fieldIndex: 4, optionItemIndex: 0 },
			options: {
				...options,
				models: [],
				modelDiscovery: { status: "degraded", error: "offline" },
			},
			agents: [
				{
					...agent("default"),
					frontmatter: {
						...agent("default").frontmatter,
						model: MODEL_OPTION_DEGRADED_STATUS,
					},
				},
			],
		}),
	},
];

for (const scenario of scenarios) {
	console.log(`\n=== ${scenario.name} ===`);
	console.log(await renderToText(<Board state={scenario.state} />, { columns: 120, rows: 30 }));
}
