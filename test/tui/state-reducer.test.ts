import { describe, it, expect } from "vitest";
import { configReducer, createInitialState, resolveCheckboxSelection, computeCheckboxSaveValue } from "../../src/tui/state/reducer.js";
import type { ConfigState, AgentConfigState, DiscoveredOptions } from "../../src/tui/state/types.js";

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
			{ provider: "anthropic", modelId: "claude", displayName: "claude" },
			{ provider: "openai", modelId: "gpt5", displayName: "gpt-5" },
		],
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
