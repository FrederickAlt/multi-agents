import { describe, expect, it } from "vitest";
import type { AgentConfigState, DiscoveredOptions } from "../../src/tui/state/types.js";
import { computeInlineCheckboxSaveValue } from "../../src/tui/hooks/useConfig.js";

function makeAgent(overrides: Partial<AgentConfigState> = {}): AgentConfigState {
	return {
		name: "agent-a",
		description: "A test agent",
		filePath: "/tmp/agent-a.md",
		frontmatter: { description: "A test agent" },
		body: "",
		error: null,
		staleItems: {},
		...overrides,
	};
}

function makeOptions(
	overrides: Partial<DiscoveredOptions> = {},
): DiscoveredOptions {
	return {
		tools: ["read", "bash", "write"],
		extensions: [],
		models: [],
		defaultModel: "",
		reasoningEfforts: ["low", "medium", "high", "maximum"],
		depths: [0, 1, 2, 3, 4, 5],
		canSpawn: ["agent-a", "agent-b", "agent-c"],
		skills: [],
		promptParts: [],
		...overrides,
	};
}

describe("computeInlineCheckboxSaveValue", () => {
	it("excludes current agent when saving inline can_spawn values", () => {
		const options = makeOptions();
		const agent = makeAgent({
			name: "agent-a",
			frontmatter: { description: "A test agent" },
		});

		const result = computeInlineCheckboxSaveValue(
			options,
			agent,
			"can_spawn",
			"agent-b",
		);

		// Missing can_spawn is implicit (all available after filtering self), then toggling
		// removes agent-b and keeps explicit single-item save path.
		expect(result).toEqual(["agent-c"]);
	});

	it("keeps explicit stale checkbox values when toggling inline can_spawn selections", () => {
		const options = makeOptions();
		const agent = makeAgent({
			name: "agent-a",
			frontmatter: {
				description: "A test agent",
				can_spawn: ["agent-b", "legacy-agent"],
			},
		});

		const result = computeInlineCheckboxSaveValue(
			options,
			agent,
			"can_spawn",
			"agent-c",
		);

		expect(result).toEqual(["agent-b", "legacy-agent", "agent-c"]);
	});

	it("filters self from explicit can_spawn selections before computing save value", () => {
		const options = makeOptions();
		const agent = makeAgent({
			name: "agent-a",
			frontmatter: {
				description: "A test agent",
				can_spawn: ["agent-a", "agent-b"],
			},
		});

		const result = computeInlineCheckboxSaveValue(
			options,
			agent,
			"can_spawn",
			"agent-b",
		);

		expect(result).toEqual([]);
		expect(result).not.toContain("agent-a");
	});
});
