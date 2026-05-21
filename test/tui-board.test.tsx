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
	it("keeps the left gutter stable before and after horizontal scrolling", () => {
		const initial = Board({ state: state() }) as React.ReactElement;
		const scrolled = Board({
			state: state({ focus: { agentIndex: 1, fieldIndex: 0 }, scrollOffset: 1 }),
		}) as React.ReactElement;

		expect(renderedChildren(initial)[0]).toMatchObject({ props: { width: 3 } });
		expect(renderedChildren(scrolled)[0]).toMatchObject({ props: { width: 3 } });
	});
});
