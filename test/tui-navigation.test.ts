import { afterEach, describe, expect, it } from "vitest";
import { configReducer } from "../src/tui/state/reducer.js";
import type { AgentConfigState, ConfigState, DiscoveredOptions } from "../src/tui/state/types.js";

const originalRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");

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
		expandedAgentIndex: null,
		overlay: null,
		statuses: new Map(),
		scrollOffset: 0,
		globalError: null,
	};
}

function setTerminalRows(rows: number): void {
	Object.defineProperty(process.stdout, "rows", {
		value: rows,
		configurable: true,
	});
}

afterEach(() => {
	if (originalRowsDescriptor) {
		Object.defineProperty(process.stdout, "rows", originalRowsDescriptor);
	} else {
		delete (process.stdout as { rows?: number }).rows;
	}
});

describe("agent focus navigation", () => {
	it("does not scroll when the newly focused agent is already visible", () => {
		// Many rows so all agents fit
		setTerminalRows(100);

		const next = configReducer(state(), { type: "FOCUS_AGENT", direction: "next" });

		expect(next.focus.agentIndex).toBe(1);
		expect(next.scrollOffset).toBe(0);
	});
});
