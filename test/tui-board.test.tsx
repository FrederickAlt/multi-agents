import React from "react";
import { describe, expect, it } from "vitest";
import { Board } from "../src/tui/components/Board.js";
import type { AgentConfigState, ConfigState, DiscoveredOptions } from "../src/tui/state/types.js";

const options: DiscoveredOptions = {
	tools: [],
	extensions: [],
	models: [],
	defaultModel: "",
	reasoningEfforts: [],
	depths: [],
	canSpawn: [],
	skills: [],
	promptParts: [],
};

function agent(name: string): AgentConfigState {
	return {
		name,
		description: `${name} description`,
		filePath: `/tmp/${name}.md`,
		frontmatter: {},
		body: "",
		error: null,
		staleItems: {},
	};
}

function state(overrides: Partial<ConfigState> = {}): ConfigState {
	return {
		agents: [agent("default"), agent("explorer"), agent("coder")],
		options,
		focus: { agentIndex: 0, fieldIndex: 0 },
		expandedAgentIndex: null,
		overlay: null,
		statuses: new Map(),
		scrollOffset: 0,
		globalError: null,
		...overrides,
	};
}

function renderedChildren(element: React.ReactElement): React.ReactNode[] {
	return React.Children.toArray(element.props.children);
}

describe("Board", () => {
	it("renders AgentRow components for all visible agents in vertical layout", () => {
		const result = Board({ state: state() }) as React.ReactElement;
		const children = renderedChildren(result);
		// The scroll indicators appear above/below the agent rows when scrolling.
		// With 0 scroll offset and all agents visible, no indicators.
		// AgentRow components have AgentRow as their type (function component).
		const agentNames = children
			.map((c: any) => c?.props?.agent?.name)
			.filter(Boolean);
		expect(agentNames).toEqual(["default", "explorer", "coder"]);
	});

	it("returns null when there are no agents", () => {
		expect(Board({ state: state({ agents: [] }) })).toBeNull();
	});
});
