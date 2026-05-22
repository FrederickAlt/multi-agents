import { describe, it, expect, afterEach } from "vitest";
import { configReducer, createInitialState, resolveCheckboxSelection, computeCheckboxSaveValue } from "../../src/tui/state/reducer.js";
import {
	getOptionColumnItems,
	getOptionColumnAvailableItems,
	getOptionColumnSelectedValue,
	MODEL_OPTION_LOADING_ITEM,
	MODEL_OPTION_DEGRADED_STATUS,
} from "../../src/tui/state/option-columns.js";
import type { ConfigState, AgentConfigState, DiscoveredOptions } from "../../src/tui/state/types.js";

const originalRowsDescriptor = Object.getOwnPropertyDescriptor(
	process.stdout,
	"rows",
);
const originalColumnsDescriptor = Object.getOwnPropertyDescriptor(
	process.stdout,
	"columns",
);

function setTerminalRows(rows: number): void {
	Object.defineProperty(process.stdout, "rows", {
		value: rows,
		configurable: true,
	});
}

function setTerminalColumns(columns: number): void {
	Object.defineProperty(process.stdout, "columns", {
		value: columns,
		configurable: true,
	});
}

afterEach(() => {
	if (originalRowsDescriptor) {
		Object.defineProperty(process.stdout, "rows", originalRowsDescriptor);
	} else {
		delete (process.stdout as { rows?: number }).rows;
	}
	if (originalColumnsDescriptor) {
		Object.defineProperty(process.stdout, "columns", originalColumnsDescriptor);
	} else {
		delete (process.stdout as { columns?: number }).columns;
	}
});

function makeAgent(overrides: Partial<AgentConfigState> = {}): AgentConfigState {
	return {
		name: "test-agent",
		description: "A test agent",
		filePath: "/tmp/test-agent.md",
		frontmatter: { description: "A test agent", model: "claude" },
		body: "Some markdown body",
		error: null,
		staleItems: {},
		...overrides,
	};
}

function makeOptions(overrides: Partial<DiscoveredOptions> = {}): DiscoveredOptions {
	return {
		tools: ["read", "bash", "write"],
		extensions: ["ext-a", "ext-b"],
		models: [
			{ provider: "anthropic", modelId: "claude", displayName: "claude", canonicalRef: "claude" },
			{ provider: "openai", modelId: "gpt5", displayName: "gpt-5", canonicalRef: "gpt5" },
		],
		defaultModel: "claude",
		modelDiscovery: { status: "ready", error: null },
		reasoningEfforts: ["low", "medium", "high", "maximum"],
		depths: [0, 1, 2, 3, 4, 5],
		canSpawn: ["other-agent", "coder"],
		skills: ["skill-a", "skill-b"],
		promptParts: ["010-tools", "020-context"],
		...overrides,
	};
}

describe("configReducer", () => {
	it("INIT_COMPLETE populates agents and options", () => {
		const state = createInitialState();
		const agents = [makeAgent()];
		const options = makeOptions();
		const next = configReducer(state, { type: "INIT_COMPLETE", agents, options });
		expect(next.agents).toEqual(agents);
		expect(next.options).toEqual(options);
		expect(next.globalError).toBeNull();
	});

	it("INIT_ERROR sets global error", () => {
		const state = createInitialState();
		const next = configReducer(state, { type: "INIT_ERROR", error: "oops" });
		expect(next.globalError).toBe("oops");
	});

	it("FOCUS_AGENT moves agent index", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" }), makeAgent({ name: "c" })],
		};
		let next = configReducer(state, { type: "FOCUS_AGENT", direction: "next" });
		expect(next.focus.agentIndex).toBe(1);
		next = configReducer(next, { type: "FOCUS_AGENT", direction: "next" });
		expect(next.focus.agentIndex).toBe(2);
		next = configReducer(next, { type: "FOCUS_AGENT", direction: "next" });
		expect(next.focus.agentIndex).toBe(0); // wraps
		next = configReducer(next, { type: "FOCUS_AGENT", direction: "prev" });
		expect(next.focus.agentIndex).toBe(2);
	});

	it("FOCUS_AGENT does nothing with no agents", () => {
		const state = createInitialState();
		const next = configReducer(state, { type: "FOCUS_AGENT", direction: "next" });
		expect(next.focus.agentIndex).toBe(0);
	});

	it("FOCUS_FIELD moves field index", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent()],
		};
		let next = configReducer(state, { type: "FOCUS_FIELD", direction: "next" });
		expect(next.focus.fieldIndex).toBe(1);
		next = configReducer(next, { type: "FOCUS_FIELD", direction: "prev" });
		expect(next.focus.fieldIndex).toBe(0);
	});

	it("OPEN_OVERLAY creates checkbox overlay for tools", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { description: "test", tools: ["read"] } })],
			options: makeOptions(),
		};
		const next = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "tools" });
		expect(next.overlay).not.toBeNull();
		expect(next.overlay!.type).toBe("checkbox");
		expect(next.overlay!.localSelection).toEqual(["read"]);
		expect(next.overlay!.wasImplicit).toBe(false);
	});

	it("OPEN_OVERLAY creates implicit checkbox when field is missing", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { description: "test" } })],
			options: makeOptions(),
		};
		const next = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "tools" });
		expect(next.overlay!.localSelection).toEqual(["read", "bash", "write"]);
		expect(next.overlay!.wasImplicit).toBe(true);
	});

	it("OPEN_OVERLAY creates dropdown overlay for model", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { description: "test", model: "gpt-5" } })],
			options: makeOptions(),
		};
		const next = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "model" });
		expect(next.overlay).not.toBeNull();
		expect(next.overlay!.type).toBe("dropdown");
		expect(next.overlay!.localSelected).toBe("gpt-5");
	});

	it("CLOSE_OVERLAY clears overlay", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent()],
			options: makeOptions(),
		};
		const withOverlay = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "model" });
		expect(withOverlay.overlay).not.toBeNull();
		const closed = configReducer(withOverlay, { type: "CLOSE_OVERLAY" });
		expect(closed.overlay).toBeNull();
	});

	it("TOGGLE_CHECKBOX toggles item in localSelection", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { description: "test", tools: ["read"] } })],
			options: makeOptions(),
		};
		const withOverlay = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "tools" });
		// Uncheck "read"
		let toggled = configReducer(withOverlay, { type: "TOGGLE_CHECKBOX", item: "read" });
		expect(toggled.overlay!.localSelection).toEqual([]);
		// Check "bash"
		toggled = configReducer(toggled, { type: "TOGGLE_CHECKBOX", item: "bash" });
		expect(toggled.overlay!.localSelection).toEqual(["bash"]);
	});

	it("TOGGLE_CHECKBOX from implicit state makes selection explicit", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { description: "test" } })],
			options: makeOptions(),
		};
		const withOverlay = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "tools" });
		expect(withOverlay.overlay!.wasImplicit).toBe(true);
		expect(withOverlay.overlay!.localSelection).toEqual(["read", "bash", "write"]);
		// Toggle one - should become explicit with all others checked except toggled
		const toggled = configReducer(withOverlay, { type: "TOGGLE_CHECKBOX", item: "read" });
		expect(toggled.overlay!.wasImplicit).toBe(false);
		expect(toggled.overlay!.localSelection).toEqual(["bash", "write"]);
	});

	it("SAVE_COMPLETE updates statuses", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent()],
		};
		const next = configReducer(state, {
			type: "SAVE_COMPLETE",
			agentIndex: 0,
			status: { type: "saved", message: "Saved test-agent.md", timestamp: Date.now() },
		});
		expect(next.statuses.get("/tmp/test-agent.md")).toEqual({
			type: "saved",
			message: "Saved test-agent.md",
			timestamp: expect.any(Number),
		});
	});

	it("RESCAN clears overlay", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent()],
			options: makeOptions(),
		};
		const withOverlay = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "tools" });
		const rescanned = configReducer(withOverlay, { type: "RESCAN" });
		expect(rescanned.overlay).toBeNull();
	});

	it("RESCAN_COMPLETE replaces agents and options", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent()],
			options: makeOptions(),
		};
		const newAgents = [makeAgent({ name: "new" })];
		const newOptions = makeOptions({ tools: ["only-read"] });
		const next = configReducer(state, { type: "RESCAN_COMPLETE", agents: newAgents, options: newOptions });
		expect(next.agents).toEqual(newAgents);
		expect(next.options).toEqual(newOptions);
	});

	it("UPDATE_AGENT_FRONTMATTER updates agent in place", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { description: "old" } })],
		};
		const newFm = { description: "new", model: "claude" };
		const next = configReducer(state, {
			type: "UPDATE_AGENT_FRONTMATTER",
			agentIndex: 0,
			frontmatter: newFm,
			staleItems: {},
		});
		expect(next.agents[0].frontmatter).toEqual(newFm);
	});
});

describe("resolveCheckboxSelection", () => {
	it("returns all available items when frontmatter value is undefined", () => {
		const result = resolveCheckboxSelection(undefined, ["a", "b", "c"]);
		expect(result.localSelection).toEqual(["a", "b", "c"]);
		expect(result.wasImplicit).toBe(true);
	});

	it("returns empty when frontmatter value is empty array", () => {
		const result = resolveCheckboxSelection([], ["a", "b", "c"]);
		expect(result.localSelection).toEqual([]);
		expect(result.wasImplicit).toBe(false);
	});

	it("returns explicit list", () => {
		const result = resolveCheckboxSelection(["a", "c"], ["a", "b", "c", "d"]);
		expect(result.localSelection).toEqual(["a", "c"]);
		expect(result.wasImplicit).toBe(false);
	});
});

describe("computeCheckboxSaveValue", () => {
	it("returns explicit list when subset is selected", () => {
		const result = computeCheckboxSaveValue(["a", "c"], ["a", "b", "c"]);
		expect(result).toEqual(["a", "c"]);
	});

	it("does not return implicit-all when stale/extra values are present", () => {
		const result = computeCheckboxSaveValue(
			["read", "deleted_tool"],
			["read", "bash", "write"],
		);
		expect(result).toEqual(["read", "deleted_tool"]);
	});

	it("returns undefined when all items are selected (revert to implicit)", () => {
		const result = computeCheckboxSaveValue(["a", "b", "c"], ["a", "b", "c"]);
		expect(result).toBeUndefined();
	});

	it("returns empty array when no items are selected", () => {
		const result = computeCheckboxSaveValue([], ["a", "b", "c"]);
		expect(result).toEqual([]);
	});

	it("returns a copy, not the original array", () => {
		const input = ["a", "b"];
		const result = computeCheckboxSaveValue(input, ["a", "b", "c"]);
		expect(result).toEqual(["a", "b"]);
		expect(result).not.toBe(input);
	});

	it("returns undefined when single item matches all available", () => {
		const result = computeCheckboxSaveValue(["only"], ["only"]);
		expect(result).toBeUndefined();
	});
});

describe("tri-state toggle flow", () => {
	it("implicit → first toggle makes explicit, writes explicit list", () => {
		// Open overlay on implicit field (all items checked, wasImplicit=true)
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { description: "test" } })],
			options: makeOptions(),
		};
		const withOverlay = configReducer(state, {
			type: "OPEN_OVERLAY",
			agentIndex: 0,
			fieldName: "tools",
		});
		expect(withOverlay.overlay!.wasImplicit).toBe(true);
		expect(withOverlay.overlay!.localSelection).toEqual(["read", "bash", "write"]);

		// First toggle removes one item and makes explicit
		const toggled = configReducer(withOverlay, {
			type: "TOGGLE_CHECKBOX",
			item: "read",
		});
		expect(toggled.overlay!.wasImplicit).toBe(false);
		expect(toggled.overlay!.localSelection).toEqual(["bash", "write"]);

		// computeCheckboxSaveValue should return explicit list (not all selected)
		const saveValue = computeCheckboxSaveValue(
			toggled.overlay!.localSelection,
			toggled.overlay!.availableItems,
		);
		expect(saveValue).toEqual(["bash", "write"]);
	});

	it("preserves stale checkbox entries as explicit after toggling", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [
				makeAgent({
					frontmatter: {
						description: "test",
						tools: ["read", "deleted_tool"],
					},
				}),
			],
			options: makeOptions(),
		};
		const withOverlay = configReducer(state, {
			type: "OPEN_OVERLAY",
			agentIndex: 0,
			fieldName: "tools",
		});
		expect(withOverlay.overlay!.localSelection).toEqual(["read", "deleted_tool"]);

		const toggled = configReducer(withOverlay, {
			type: "TOGGLE_CHECKBOX",
			item: "bash",
		});
		expect(toggled.overlay!.localSelection).toEqual(["read", "deleted_tool", "bash"]);

		const saveValue = computeCheckboxSaveValue(
			toggled.overlay!.localSelection,
			toggled.overlay!.availableItems,
		);
		expect(saveValue).toEqual(["read", "deleted_tool", "bash"]);
	});

	it("toggling the last checked item off writes empty array", () => {
		// Start with explicit single item
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { description: "test", tools: ["read"] } })],
			options: makeOptions(),
		};
		const withOverlay = configReducer(state, {
			type: "OPEN_OVERLAY",
			agentIndex: 0,
			fieldName: "tools",
		});
		expect(withOverlay.overlay!.localSelection).toEqual(["read"]);

		// Toggle last item off
		const toggled = configReducer(withOverlay, {
			type: "TOGGLE_CHECKBOX",
			item: "read",
		});
		expect(toggled.overlay!.localSelection).toEqual([]);

		// Should write [] (empty array), NOT undefined
		const saveValue = computeCheckboxSaveValue(
			toggled.overlay!.localSelection,
			toggled.overlay!.availableItems,
		);
		expect(saveValue).toEqual([]);
	});

	it("toggling all items back on writes undefined (revert to implicit)", () => {
		// Start with explicit subset
		const state: ConfigState = {
			...createInitialState(),
			agents: [
				makeAgent({
					frontmatter: { description: "test", tools: ["read", "bash"] },
				}),
			],
			options: makeOptions(),
		};
		const withOverlay = configReducer(state, {
			type: "OPEN_OVERLAY",
			agentIndex: 0,
			fieldName: "tools",
		});
		expect(withOverlay.overlay!.localSelection).toEqual(["read", "bash"]);

		// Toggle "write" on → now all three are selected
		const toggled = configReducer(withOverlay, {
			type: "TOGGLE_CHECKBOX",
			item: "write",
		});
		expect(toggled.overlay!.localSelection).toEqual(["read", "bash", "write"]);

		// All selected → save value should be undefined (remove field)
		const saveValue = computeCheckboxSaveValue(
			toggled.overlay!.localSelection,
			toggled.overlay!.availableItems,
		);
		expect(saveValue).toBeUndefined();
	});

	it("overlay stays open after toggle (TOGGLE_CHECKBOX does not close)", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { description: "test", tools: ["read"] } })],
			options: makeOptions(),
		};
		const withOverlay = configReducer(state, {
			type: "OPEN_OVERLAY",
			agentIndex: 0,
			fieldName: "tools",
		});
		expect(withOverlay.overlay).not.toBeNull();

		const toggled = configReducer(withOverlay, {
			type: "TOGGLE_CHECKBOX",
			item: "read",
		});
		// Overlay should still be open
		expect(toggled.overlay).not.toBeNull();
	});

	it("CLOSE_OVERLAY clears overlay (Enter/Escape closes after toggles)", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { description: "test", tools: ["read"] } })],
			options: makeOptions(),
		};
		let s = configReducer(state, {
			type: "OPEN_OVERLAY",
			agentIndex: 0,
			fieldName: "tools",
		});
		// Do a toggle (simulating immediate save flow)
		s = configReducer(s, { type: "TOGGLE_CHECKBOX", item: "read" });
		expect(s.overlay).not.toBeNull();

		// Close (Enter or Escape)
		s = configReducer(s, { type: "CLOSE_OVERLAY" });
		expect(s.overlay).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Dropdown overlay tests
// ---------------------------------------------------------------------------

describe("OPEN_OVERLAY dropdown", () => {
	function stateWithAgent(frontmatter: Record<string, unknown> = {}) {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter })],
			options: makeOptions(),
		};
		return state;
	}

	it("opens model dropdown with current value from frontmatter", () => {
		const state = stateWithAgent({ model: "gpt-5" });
		const next = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "model" });
		expect(next.overlay!.type).toBe("dropdown");
		expect(next.overlay!.localSelected).toBe("gpt-5");
		expect(next.overlay!.wasImplicit).toBe(false);
		expect(next.overlay!.availableItems).toEqual(["claude", "gpt-5"]);
	});

	it("opens model dropdown with default from options.defaultModel when field missing", () => {
		const state = stateWithAgent({ description: "no model" });
		const next = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "model" });
		expect(next.overlay!.type).toBe("dropdown");
		expect(next.overlay!.localSelected).toBe("claude");
		expect(next.overlay!.wasImplicit).toBe(true);
	});

	it("model dropdown falls back to first available when defaultModel is empty", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { description: "test" } })],
			options: makeOptions({ defaultModel: "" }),
		};
		const next = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "model" });
		expect(next.overlay!.localSelected).toBe("claude");
	});

	it("model dropdown shows (none) when no models available", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { description: "test" } })],
			options: makeOptions({ models: [], defaultModel: "" }),
		};
		const next = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "model" });
		expect(next.overlay!.localSelected).toBe("(none)");
		expect(next.overlay!.availableItems).toEqual([]);
		expect(next.overlay!.wasImplicit).toBe(true);
	});

	it("opens depth dropdown with default 0 when field missing", () => {
		const state = stateWithAgent({ description: "no depth" });
		const next = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "depth" });
		expect(next.overlay!.type).toBe("dropdown");
		expect(next.overlay!.localSelected).toBe("0");
		expect(next.overlay!.wasImplicit).toBe(true);
		expect(next.overlay!.availableItems).toEqual(["0", "1", "2", "3", "4", "5"]);
	});

	it("opens depth dropdown with current value from frontmatter", () => {
		const state = stateWithAgent({ depth: 3 });
		const next = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "depth" });
		expect(next.overlay!.localSelected).toBe("3");
		expect(next.overlay!.wasImplicit).toBe(false);
	});

	it("opens reasoning_effort dropdown with default medium when field missing", () => {
		const state = stateWithAgent({ description: "no reasoning" });
		const next = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "reasoning_effort" });
		expect(next.overlay!.type).toBe("dropdown");
		expect(next.overlay!.localSelected).toBe("medium");
		expect(next.overlay!.wasImplicit).toBe(true);
		expect(next.overlay!.availableItems).toEqual(["low", "medium", "high", "maximum"]);
	});

	it("opens reasoning_effort dropdown with current value from frontmatter", () => {
		const state = stateWithAgent({ reasoning_effort: "high" });
		const next = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "reasoning_effort" });
		expect(next.overlay!.localSelected).toBe("high");
		expect(next.overlay!.wasImplicit).toBe(false);
	});

	it("rejects OPEN_OVERLAY when agent has error", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ error: "parse error" })],
			options: makeOptions(),
		};
		const next = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "model" });
		expect(next.overlay).toBeNull();
	});

	it("rejects OPEN_OVERLAY when agent index out of bounds", () => {
		const state = stateWithAgent({ model: "claude" });
		const next = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 99, fieldName: "model" });
		expect(next.overlay).toBeNull();
	});
});

describe("SELECT_DROPDOWN", () => {
	it("updates localSelected", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { model: "claude" } })],
			options: makeOptions(),
		};
		const withOverlay = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "model" });
		const updated = configReducer(withOverlay, { type: "SELECT_DROPDOWN", item: "gpt-5" });
		expect(updated.overlay!.localSelected).toBe("gpt-5");
	});

	it("is a no-op when overlay is not dropdown", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { tools: ["read"] } })],
			options: makeOptions(),
		};
		const withOverlay = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "tools" });
		const updated = configReducer(withOverlay, { type: "SELECT_DROPDOWN", item: "bash" });
		// Should be unchanged since overlay is checkbox type
		expect(updated.overlay!.type).toBe("checkbox");
	});

	it("is a no-op when no overlay open", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent()],
			options: makeOptions(),
		};
		const updated = configReducer(state, { type: "SELECT_DROPDOWN", item: "claude" });
		expect(updated.overlay).toBeNull();
	});
});

describe("OPEN_OVERLAY validation", () => {
	it("opens dropdown with correct availableItems for depth (0-5)", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: {} })],
			options: makeOptions(),
		};
		const next = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "depth" });
		expect(next.overlay!.availableItems).toEqual(["0", "1", "2", "3", "4", "5"]);
	});

	it("opens dropdown with model display names from discovered models", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: {} })],
			options: makeOptions(),
		};
		const next = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "model" });
		expect(next.overlay!.availableItems).toEqual(["claude", "gpt-5"]);
	});

	it("selecting default value still sets wasImplicit to true", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: {} })],
			options: makeOptions(),
		};
		const next = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 0, fieldName: "depth" });
		// Depth was missing in frontmatter
		expect(next.overlay!.wasImplicit).toBe(true);
		// Default value "0" is selected
		expect(next.overlay!.localSelected).toBe("0");
	});
});

// ---------------------------------------------------------------------------
// Inline Option column tests
// ---------------------------------------------------------------------------

describe("inline Option columns", () => {
	it("EXPAND focuses the selected item in the first single-select option column", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { reasoning_effort: "high", depth: 2 } })],
			options: makeOptions(),
		};

		const next = configReducer(state, { type: "EXPAND" });

		expect(next.expandedAgentIndex).toBe(0);
		expect(next.focus.fieldIndex).toBe(2);
		expect(next.focus.optionItemIndex).toBe(2);
	});

	it("FOCUS_FIELD moves right across rendered option columns", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { reasoning_effort: "medium", depth: 3 } })],
			options: makeOptions(),
			expandedAgentIndex: 0,
			focus: { agentIndex: 0, fieldIndex: 2, optionItemIndex: 1 },
		};

		let next = configReducer(state, { type: "FOCUS_FIELD", direction: "next" });
		expect(next.focus.fieldIndex).toBe(3);
		expect(next.focus.optionItemIndex).toBe(3);

		next = configReducer(next, { type: "FOCUS_FIELD", direction: "next" });
		expect(next.focus.fieldIndex).toBe(4);
		expect(next.focus.optionItemIndex).toBe(0);
	});

	it("FOCUS_FIELD moves right from extensions to the rendered inline order", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { reasoning_effort: "medium", depth: 3 } })],
			options: makeOptions(),
			expandedAgentIndex: 0,
			focus: { agentIndex: 0, fieldIndex: 1, optionItemIndex: 0 },
		};

		const next = configReducer(state, { type: "FOCUS_FIELD", direction: "next" });

		expect(next.focus.fieldIndex).toBe(2);
		expect(next.focus.optionItemIndex).toBe(1);
	});

	it("FOCUS_FIELD moves left from can_spawn to model", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { reasoning_effort: "medium", depth: 3 } })],
			options: makeOptions(),
			expandedAgentIndex: 0,
			focus: { agentIndex: 0, fieldIndex: 5, optionItemIndex: 0 },
		};

		const next = configReducer(state, { type: "FOCUS_FIELD", direction: "prev" });

		expect(next.focus.fieldIndex).toBe(4);
		expect(next.focus.optionItemIndex).toBe(0);
	});

	it("FOCUS_OPTION_ITEM moves up and down within the focused option column", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { reasoning_effort: "medium" } })],
			options: makeOptions(),
			expandedAgentIndex: 0,
			focus: { agentIndex: 0, fieldIndex: 2, optionItemIndex: 1 },
		};

		let next = configReducer(state, { type: "FOCUS_OPTION_ITEM", direction: "next" });
		expect(next.focus.optionItemIndex).toBe(2);

		next = configReducer(next, { type: "FOCUS_OPTION_ITEM", direction: "prev" });
		expect(next.focus.optionItemIndex).toBe(1);
	});

	it("FOCUS_OPTION_ITEM works for checkbox fields", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { tools: ["read", "bash"] } })],
			options: makeOptions(),
			expandedAgentIndex: 0,
			focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 1 },
		};

		let next = configReducer(state, { type: "FOCUS_OPTION_ITEM", direction: "next" });
		expect(next.focus.optionItemIndex).toBe(2);

		next = configReducer(next, { type: "FOCUS_OPTION_ITEM", direction: "prev" });
		expect(next.focus.optionItemIndex).toBe(1);
	});

	it("excludes current agent from inline can_spawn options", () => {
		const options = makeOptions({
			canSpawn: ["peer", "self-agent", "advisor"],
		});
		const agent = makeAgent({
			name: "self-agent",
			frontmatter: { can_spawn: ["self-agent", "peer", "advisor"] },
		});

		expect(getOptionColumnItems(agent, options, "can_spawn", "self-agent")).toEqual([
			"peer",
			"advisor",
		]);
	});

	it("focus movement on can_spawn ignores self", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "self-agent", frontmatter: {} })],
			options: makeOptions({
				canSpawn: ["peer", "self-agent", "advisor"],
			}),
			expandedAgentIndex: 0,
			focus: { agentIndex: 0, fieldIndex: 5, optionItemIndex: 0 },
		};

		const next = configReducer(state, { type: "FOCUS_OPTION_ITEM", direction: "next" });
		expect(next.focus.optionItemIndex).toBe(1);
	});

	it("FOCUS_OPTION_ITEM wraps from last visible can_spawn item", () => {
		const options = makeOptions({
			canSpawn: ["peer", "self-agent", "advisor"],
		});
		const agent = makeAgent({
			name: "self-agent",
			frontmatter: { can_spawn: ["peer", "advisor"] },
		});
		const state: ConfigState = {
			...createInitialState(),
			agents: [agent],
			options,
			expandedAgentIndex: 0,
			focus: { agentIndex: 0, fieldIndex: 5, optionItemIndex: 1 },
		};

		const visibleItems = getOptionColumnItems(agent, options, "can_spawn", agent.name);
		expect(visibleItems).toEqual(["peer", "advisor"]);
		expect(visibleItems).toHaveLength(2);

		const next = configReducer(state, {
			type: "FOCUS_OPTION_ITEM",
			direction: "next",
		});
		const nextFocusedItem = visibleItems[next.focus.optionItemIndex];
		expect(next.focus.optionItemIndex).toBe(0);
		expect(nextFocusedItem).toBe("peer");
	});

	it("UPDATE_AGENT_FRONTMATTER preserves can_spawn focus using filtered visible items", () => {
		const options = makeOptions({
			canSpawn: ["peer", "self-agent", "advisor"],
		});
		const state: ConfigState = {
			...createInitialState(),
			agents: [
				makeAgent({
					name: "self-agent",
					frontmatter: { can_spawn: ["peer", "advisor"] },
				}),
			],
			options,
			expandedAgentIndex: 0,
			focus: { agentIndex: 0, fieldIndex: 5, optionItemIndex: 1 },
		};

		const next = configReducer(state, {
			type: "UPDATE_AGENT_FRONTMATTER",
			agentIndex: 0,
			frontmatter: { can_spawn: ["peer", "advisor"] },
			staleItems: {},
		});

		const nextVisibleItems = getOptionColumnItems(next.agents[0], options, "can_spawn", "self-agent");
		expect(nextVisibleItems).toEqual(["peer", "advisor"]);
		expect(next.focus.optionItemIndex).toBe(1);
		const focusedItem = nextVisibleItems[next.focus.optionItemIndex];
		expect(focusedItem).toBe("advisor");
	});

	it("horizontally scrolls option columns when terminal width only fits one column", () => {
		setTerminalColumns(24);
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { reasoning_effort: "low", depth: 2 } })],
			options: makeOptions(),
			expandedAgentIndex: 0,
			focus: { agentIndex: 0, fieldIndex: 2, optionItemIndex: 0 },
		};

		const next = configReducer(state, { type: "FOCUS_FIELD", direction: "next" });

		expect(next.focus.fieldIndex).toBe(3);
		expect(next.optionColumnScrollOffset).toBe(4);

	});

	it("realigns focused item after a stale custom value is replaced", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { reasoning_effort: "ultra" } })],
			options: makeOptions(),
			expandedAgentIndex: 0,
			focus: { agentIndex: 0, fieldIndex: 2, optionItemIndex: 1 },
		};

		const next = configReducer(state, {
			type: "UPDATE_AGENT_FRONTMATTER",
			agentIndex: 0,
			frontmatter: { reasoning_effort: "high" },
			staleItems: {},
		});

		expect(next.focus.optionItemIndex).toBe(0);
	});

	it("keeps stale custom checkbox values visible without changing frontmatter", () => {
		const agent = makeAgent({
			frontmatter: {
				tools: ["read", "deleted_tool"],
			},
		});
		const options = makeOptions();

		expect(getOptionColumnItems(agent, options, "tools")).toEqual([
			"read",
			"deleted_tool",
			"bash",
			"write",
		]);

		const state: ConfigState = {
			...createInitialState(),
			agents: [agent],
			options,
		};
		const next = configReducer(state, { type: "INIT_COMPLETE", agents: [agent], options });
		expect(next.agents[0].frontmatter).toEqual({ tools: ["read", "deleted_tool"] });
	});

	it("keeps expanded row state after updating checkbox frontmatter", () => {
		const options = makeOptions();
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ frontmatter: { tools: ["read", "bash"] } })],
			options,
			expandedAgentIndex: 0,
			focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 2 },
		};
		const next = configReducer(state, {
			type: "UPDATE_AGENT_FRONTMATTER",
			agentIndex: 0,
			frontmatter: { tools: ["read", "bash"] },
			staleItems: {},
		});
		expect(next.expandedAgentIndex).toBe(0);
		expect(next.focus.fieldIndex).toBe(0);
		expect(next.focus.optionItemIndex).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Model discovery state transitions
// ---------------------------------------------------------------------------

describe("model discovery options", () => {
	it("shows loading placeholder in model option column while discovery is pending", () => {
		const options = {
			...makeOptions(),
			modelDiscovery: { status: "loading", error: null },
			models: [],
			defaultModel: "",
		};

		expect(getOptionColumnAvailableItems(options, "model")).toEqual([
			MODEL_OPTION_LOADING_ITEM,
		]);
	});

	it("shows degraded placeholder for unresolved model discovery", () => {
		const options = {
			...makeOptions(),
			modelDiscovery: { status: "degraded", error: "registry missing" },
			models: [],
			defaultModel: "",
		};

		expect(getOptionColumnAvailableItems(options, "model")).toEqual([
			MODEL_OPTION_DEGRADED_STATUS,
		]);
	});

	it("shows degraded marker while keeping fallback models when present", () => {
		const options = {
			...makeOptions(),
			modelDiscovery: { status: "degraded", error: "using builtin fallback" },
			models: [
				{ provider: "anthropic", modelId: "claude", displayName: "Claude", canonicalRef: "claude" },
				{ provider: "openai", modelId: "gpt-5", displayName: "GPT-5", canonicalRef: "gpt-5" },
			],
		};

		expect(getOptionColumnAvailableItems(options, "model")).toEqual([
			MODEL_OPTION_DEGRADED_STATUS,
			"Claude",
			"GPT-5",
		]);
	});

	it("keeps loading placeholder visible when an existing model is already set", () => {
		const options = {
			...makeOptions(),
			modelDiscovery: { status: "loading", error: null },
			models: [],
			defaultModel: "",
		};
		const agent = makeAgent({ frontmatter: { model: "claude", description: "agent" } });

		expect(getOptionColumnItems(agent, options, "model")).toEqual([
			MODEL_OPTION_LOADING_ITEM,
			"claude",
		]);
		expect(getOptionColumnSelectedValue(agent, options, "model")).toBe(
			MODEL_OPTION_LOADING_ITEM,
		);
	});

	it("keeps row and inline model option focus when model options update", () => {
		const agent = makeAgent({ frontmatter: { model: "claude", description: "agent" } });
		const baseState: ConfigState = {
			...createInitialState(),
			agents: [agent],
			options: {
				...makeOptions(),
				modelDiscovery: { status: "loading", error: null },
				models: [],
				defaultModel: "",
			},
			expandedAgentIndex: 0,
			focus: {
				agentIndex: 0,
				fieldIndex: 4,
				optionItemIndex: 0,
			},
		};

		const loadedOptions = {
			...makeOptions(),
			modelDiscovery: { status: "ready", error: null },
		};
		const next = configReducer(baseState, {
			type: "UPDATE_OPTIONS",
			options: loadedOptions,
		});

		expect(next.focus.agentIndex).toBe(0);
		expect(next.focus.fieldIndex).toBe(4);
		expect(next.focus.optionItemIndex).toBe(0);
		expect(next.options.modelDiscovery.status).toBe("ready");
		expect(next.options.models).toEqual(loadedOptions.models);
	});

	it("keeps row and inline model option focus when model discovery fails", () => {
		const agent = makeAgent({ frontmatter: { model: "claude", description: "agent" } });
		const baseline = {
			...makeOptions(),
			modelDiscovery: { status: "ready", error: null },
		};
		let state = configReducer(createInitialState(), {
			type: "INIT_COMPLETE",
			agents: [agent],
			options: baseline,
		});
		state = configReducer(state, { type: "EXPAND" });
		state = configReducer(state, { type: "FOCUS_FIELD", direction: "prev" }); // model
		const failed = configReducer(state, {
			type: "UPDATE_OPTIONS",
			options: {
				...makeOptions(),
				models: [],
				modelDiscovery: { status: "degraded", error: "network" },
				defaultModel: "",
			},
		});

		expect(failed.focus.agentIndex).toBe(0);
		expect(failed.focus.fieldIndex).toBe(4);
		expect(failed.focus.optionItemIndex).toBe(0);
		expect(failed.options.modelDiscovery.status).toBe("degraded");
	});

	it("preserves focus on non-model option column during model discovery updates", () => {
		const agent = makeAgent({
			frontmatter: { reasoning_effort: "high", depth: 3, description: "agent" },
		});
		const stateWithPendingModel = configReducer(createInitialState(), {
			type: "INIT_COMPLETE",
			agents: [agent],
			options: {
				...makeOptions(),
				modelDiscovery: { status: "loading", error: null },
				models: [],
			},
		});
		const focusedState = configReducer(stateWithPendingModel, { type: "EXPAND" });
		const withFocus = configReducer(focusedState, {
			type: "FOCUS_FIELD",
			direction: "next",
		}); // reasoning_effort -> depth
		const stable = configReducer(withFocus, {
			type: "UPDATE_OPTIONS",
			options: {
				...makeOptions(),
				modelDiscovery: { status: "ready", error: null },
				defaultModel: "claude",
			},
		});

		expect(stable.focus.agentIndex).toBe(0);
		expect(stable.focus.fieldIndex).toBe(3);
		expect(stable.focus.optionItemIndex).toBe(3); // depth value 3 remains selected
	});
});

// ---------------------------------------------------------------------------
// Expand / collapse tests
// ---------------------------------------------------------------------------

describe("EXPAND", () => {
	it("sets expandedAgentIndex to the focused agent index", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" })],
			focus: { agentIndex: 1, fieldIndex: 0, optionItemIndex: 0 },
		};
		const next = configReducer(state, { type: "EXPAND" });
		expect(next.expandedAgentIndex).toBe(1);
	});

	it("resets fieldIndex to the default inline field when expanding", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" })],
			focus: { agentIndex: 0, fieldIndex: 2, optionItemIndex: 0 },
		};
		const next = configReducer(state, { type: "EXPAND" });
		expect(next.focus.fieldIndex).toBe(2);
	});

	it("collapses the previous expanded row when a different agent is expanded", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" })],
			focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 0 },
			expandedAgentIndex: 1,
		};
		// Expand agent 0 (currently focused) should collapse agent 1
		const next = configReducer(state, { type: "EXPAND" });
		expect(next.expandedAgentIndex).toBe(0);
	});

	it("is a no-op when no agents exist", () => {
		const state = createInitialState();
		const next = configReducer(state, { type: "EXPAND" });
		expect(next.expandedAgentIndex).toBeNull();
	});

	it("keeps the focused agent unchanged", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" })],
			focus: { agentIndex: 0, fieldIndex: 2, optionItemIndex: 0 },
		};
		const next = configReducer(state, { type: "EXPAND" });
		expect(next.focus.agentIndex).toBe(0);
	});
});

describe("COLLAPSE", () => {
	it("sets expandedAgentIndex to null", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" })],
			expandedAgentIndex: 0,
		};
		const next = configReducer(state, { type: "COLLAPSE" });
		expect(next.expandedAgentIndex).toBeNull();
	});

	it("preserves the focused agent index after collapse", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" })],
			focus: { agentIndex: 1, fieldIndex: 3, optionItemIndex: 0 },
			expandedAgentIndex: 1,
		};
		const next = configReducer(state, { type: "COLLAPSE" });
		expect(next.expandedAgentIndex).toBeNull();
		expect(next.focus.agentIndex).toBe(1);
	});

	it("is a no-op when nothing is expanded", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" })],
			expandedAgentIndex: null,
		};
		const next = configReducer(state, { type: "COLLAPSE" });
		expect(next.expandedAgentIndex).toBeNull();
	});
});

describe("one-expanded-row behavior", () => {
	it("only one agent can be expanded at a time", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" }), makeAgent({ name: "c" })],
			focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 0 },
		};
		// Expand agent 0
		let next = configReducer(state, { type: "EXPAND" });
		expect(next.expandedAgentIndex).toBe(0);

		// Move focus to agent 2 and expand
		next = configReducer(next, { type: "FOCUS_AGENT", direction: "next" });
		next = configReducer(next, { type: "FOCUS_AGENT", direction: "next" });
		next = configReducer(next, { type: "EXPAND" });
		expect(next.expandedAgentIndex).toBe(2);
	});

	it("collapsing a row then expanding another should work", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" })],
			focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 0 },
			expandedAgentIndex: 0,
		};
		// Collapse
		let next = configReducer(state, { type: "COLLAPSE" });
		expect(next.expandedAgentIndex).toBeNull();

		// Move to agent 1 and expand
		next = configReducer(next, { type: "FOCUS_AGENT", direction: "next" });
		next = configReducer(next, { type: "EXPAND" });
		expect(next.expandedAgentIndex).toBe(1);
	});
});

describe("compact-mode navigation", () => {
	it("FOCUS_AGENT wraps up/down navigation", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" }), makeAgent({ name: "c" })],
		};
		// prev from index 0 wraps to last
		let next = configReducer(state, { type: "FOCUS_AGENT", direction: "prev" });
		expect(next.focus.agentIndex).toBe(2);
		// next from index 2 wraps to first
		next = configReducer(next, { type: "FOCUS_AGENT", direction: "next" });
		expect(next.focus.agentIndex).toBe(0);
	});

	it("FOCUS_AGENT does nothing with no agents", () => {
		const state = createInitialState();
		const next = configReducer(state, { type: "FOCUS_AGENT", direction: "next" });
		expect(next.focus.agentIndex).toBe(0);
	});

	it("focus remains on same agent when expanding then collapsing", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" })],
			focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 0 },
		};
		// Navigate to agent 1
		let next = configReducer(state, { type: "FOCUS_AGENT", direction: "next" });
		expect(next.focus.agentIndex).toBe(1);
		// Expand
		next = configReducer(next, { type: "EXPAND" });
		expect(next.expandedAgentIndex).toBe(1);
		expect(next.focus.agentIndex).toBe(1);
		// Collapse
		next = configReducer(next, { type: "COLLAPSE" });
		expect(next.expandedAgentIndex).toBeNull();
		expect(next.focus.agentIndex).toBe(1);
	});
});

describe("vertical scrolling", () => {
	it("scrollOffset starts at 0", () => {
		const state = createInitialState();
		expect(state.scrollOffset).toBe(0);
	});

	it("SCROLL down advances offset", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" })],
		};
		const next = configReducer(state, { type: "SCROLL", direction: "down" });
		expect(next.scrollOffset).toBe(1);
	});

	it("SCROLL up decreases offset", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" })],
			scrollOffset: 1,
		};
		const next = configReducer(state, { type: "SCROLL", direction: "up" });
		expect(next.scrollOffset).toBe(0);
	});

	it("SCROLL clamps to valid range", () => {
		// Only 2 agents, index range is [0, 1]
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" })],
			scrollOffset: 0,
		};
		// Scroll up from 0 should stay at 0
		const up = configReducer(state, { type: "SCROLL", direction: "up" });
		expect(up.scrollOffset).toBe(0);
		// Scroll down to end
		const down = configReducer(state, { type: "SCROLL", direction: "down" });
		expect(down.scrollOffset).toBe(1);
		// Scroll down again stays at 1
		const down2 = configReducer(down, { type: "SCROLL", direction: "down" });
		expect(down2.scrollOffset).toBe(1);
	});

	it("SCROLL is no-op with no agents", () => {
		const state = createInitialState();
		const next = configReducer(state, { type: "SCROLL", direction: "down" });
		expect(next.scrollOffset).toBe(0);
	});

	it("focus navigation auto-scrolls to keep focused agent visible", () => {
		setTerminalRows(24);
		const state: ConfigState = {
			...createInitialState(),
			agents: [
				makeAgent({ name: "a" }),
				makeAgent({ name: "b" }),
				makeAgent({ name: "c" }),
				makeAgent({ name: "d" }),
				makeAgent({ name: "e" }),
			],
			focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 0 },
		};

		// Navigate forward — all 5 agents (15 lines) fit in 24, so no scroll needed.
		let next = state;
		for (let i = 0; i < 4; i++) {
			next = configReducer(next, { type: "FOCUS_AGENT", direction: "next" });
		}
		expect(next.focus.agentIndex).toBe(4);
		expect(next.scrollOffset).toBe(0);
	});

	it("focus navigation scrolls when focused agent goes beyond visible window", () => {
		// Small terminal: only 2 compact agents (6 lines) fit
		setTerminalRows(6);
		const state: ConfigState = {
			...createInitialState(),
			agents: [
				makeAgent({ name: "a" }),
				makeAgent({ name: "b" }),
				makeAgent({ name: "c" }),
				makeAgent({ name: "d" }),
				makeAgent({ name: "e" }),
			],
			focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 0 },
		};

		// Navigate to agent 4 — should trigger scroll
		let next = state;
		for (let i = 0; i < 4; i++) {
			next = configReducer(next, { type: "FOCUS_AGENT", direction: "next" });
		}
		expect(next.focus.agentIndex).toBe(4);
		// Walk-back from agent 4: 4(3)+3(3)=6 fits, but 2(3)=9>6 → offset=3
		expect(next.scrollOffset).toBe(3);
	});

	it("EXPAND resets scroll to keep expanded agent visible", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" })],
			focus: { agentIndex: 1, fieldIndex: 0, optionItemIndex: 0 },
			scrollOffset: 1,
		};
		const next = configReducer(state, { type: "EXPAND" });
		expect(next.expandedAgentIndex).toBe(1);
	});

	it("RESCAN_COMPLETE resets expandedAgentIndex to null", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" })],
			options: makeOptions(),
			expandedAgentIndex: 0,
		};
		const next = configReducer(state, {
			type: "RESCAN_COMPLETE",
			agents: [makeAgent({ name: "a" })],
			options: makeOptions(),
		});
		expect(next.expandedAgentIndex).toBeNull();
	});

	it("INIT_COMPLETE resets expandedAgentIndex to null", () => {
		const state: ConfigState = {
			...createInitialState(),
			expandedAgentIndex: 5,
		};
		const next = configReducer(state, {
			type: "INIT_COMPLETE",
			agents: [makeAgent({ name: "a" })],
			options: makeOptions(),
		});
		expect(next.expandedAgentIndex).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Focus collapses expanded row when moving away
// ---------------------------------------------------------------------------

describe("focus collapses expanded row", () => {
	it("FOCUS_AGENT collapses expansion when focus moves to different agent", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" }), makeAgent({ name: "c" })],
			focus: { agentIndex: 0, fieldIndex: 2, optionItemIndex: 0 },
			expandedAgentIndex: 0,
		};
		const next = configReducer(state, { type: "FOCUS_AGENT", direction: "next" });
		expect(next.expandedAgentIndex).toBeNull();
		expect(next.focus.agentIndex).toBe(1);
	});

	it("FOCUS_AGENT preserves expansion when focus wraps back to the expanded agent", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" }), makeAgent({ name: "c" })],
			focus: { agentIndex: 2, fieldIndex: 0, optionItemIndex: 0 },
			expandedAgentIndex: 0,
		};
		// prev from 2 → 1 (not expanded, collapse)
		let next = configReducer(state, { type: "FOCUS_AGENT", direction: "prev" });
		expect(next.expandedAgentIndex).toBeNull();
		// prev from 1 → 0 (back to the formerly expanded agent, but it was already collapsed)
		next = configReducer(next, { type: "FOCUS_AGENT", direction: "prev" });
		expect(next.focus.agentIndex).toBe(0);
	});

	it("FOCUS_AGENT_AT collapses expansion when clicking a different agent", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" }), makeAgent({ name: "c" })],
			focus: { agentIndex: 0, fieldIndex: 3, optionItemIndex: 0 },
			expandedAgentIndex: 0,
		};
		const next = configReducer(state, { type: "FOCUS_AGENT_AT", agentIndex: 2 });
		expect(next.expandedAgentIndex).toBeNull();
		expect(next.focus.agentIndex).toBe(2);
	});

	it("FOCUS_AGENT_AT keeps expansion when clicking the same expanded agent", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" })],
			focus: { agentIndex: 0, fieldIndex: 2, optionItemIndex: 0 },
			expandedAgentIndex: 0,
		};
		const next = configReducer(state, { type: "FOCUS_AGENT_AT", agentIndex: 0 });
		expect(next.expandedAgentIndex).toBe(0);
		expect(next.focus.agentIndex).toBe(0);
	});

	it("FOCUS_AGENT does not collapse when nothing is expanded", () => {
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" })],
			focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 0 },
			expandedAgentIndex: null,
		};
		const next = configReducer(state, { type: "FOCUS_AGENT", direction: "next" });
		expect(next.expandedAgentIndex).toBeNull();
		expect(next.focus.agentIndex).toBe(1);
	});

	it("EXPAND on the same agent after a FOCUS_AGENT round-trip works", () => {
		// Simulate: expand agent 0, navigate away, navigate back, expand again
		const state: ConfigState = {
			...createInitialState(),
			agents: [makeAgent({ name: "a" }), makeAgent({ name: "b" }), makeAgent({ name: "c" })],
			focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 0 },
		};
		let next = configReducer(state, { type: "EXPAND" });
		expect(next.expandedAgentIndex).toBe(0);

		// Navigate to agent 1 (collapses)
		next = configReducer(next, { type: "FOCUS_AGENT", direction: "next" });
		expect(next.expandedAgentIndex).toBeNull();

		// Navigate back to agent 0
		next = configReducer(next, { type: "FOCUS_AGENT", direction: "prev" });
		expect(next.focus.agentIndex).toBe(0);

		// Expand again
		next = configReducer(next, { type: "EXPAND" });
		expect(next.expandedAgentIndex).toBe(0);
	});
});
