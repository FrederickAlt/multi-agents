import { afterEach, describe, expect, it } from "vitest";
import { configReducer } from "../src/tui/state/reducer.js";
import type { AgentConfigState, ConfigState, DiscoveredOptions } from "../src/tui/state/types.js";

const originalColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");

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

function state(): ConfigState {
	return {
		agents: [agent("default"), agent("explorer"), agent("planner"), agent("coder")],
		options,
		focus: { agentIndex: 0, fieldIndex: 0 },
		overlay: null,
		statuses: new Map(),
		scrollOffset: 0,
		globalError: null,
	};
}

function setTerminalColumns(columns: number): void {
	Object.defineProperty(process.stdout, "columns", {
		value: columns,
		configurable: true,
	});
}

afterEach(() => {
	if (originalColumnsDescriptor) {
		Object.defineProperty(process.stdout, "columns", originalColumnsDescriptor);
	} else {
		delete (process.stdout as { columns?: number }).columns;
	}
});

describe("agent focus navigation", () => {
	it("does not scroll when the newly focused agent is already visible", () => {
		setTerminalColumns(100);

		const next = configReducer(state(), { type: "FOCUS_AGENT", direction: "next" });

		expect(next.focus.agentIndex).toBe(1);
		expect(next.scrollOffset).toBe(0);
	});
});
