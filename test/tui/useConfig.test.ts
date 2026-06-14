import { describe, expect, it } from "vitest";
import { computeInlineCheckboxSaveValue } from "../../src/tui/hooks/useConfig.js";
import type { AgentConfigState, DiscoveredOptions } from "../../src/tui/state/types.js";

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

function makeOptions(overrides: Partial<DiscoveredOptions> = {}): DiscoveredOptions {
	return {
		tools: ["read", "bash", "write"],
		extensions: [],
		models: [],
		defaultModel: "",
		modelDiscovery: { status: "ready" as const, error: null },
		reasoningEfforts: ["low", "medium", "high", "maximum"],
		depths: [0, 1, 2, 3, 4, 5],
		canSpawn: ["agent-a", "agent-b", "agent-c"],
		skills: [],
		promptParts: [],
		...overrides,
	};
}

describe("computeInlineCheckboxSaveValue", () => {
	it("includes current agent when saving inline can_spawn values", () => {
		const options = makeOptions();
		const agent = makeAgent({
			name: "agent-a",
			frontmatter: { description: "A test agent", depth: 1 },
		});

		const result = computeInlineCheckboxSaveValue(options, agent, "can_spawn", "agent-b");

		// Missing can_spawn is implicit (all available, including self), then toggling
		// removes agent-b and keeps an explicit save value.
		expect(result).toEqual(["agent-a", "agent-c"]);
	});

	it("keeps explicit stale checkbox values when toggling inline can_spawn selections", () => {
		const options = makeOptions();
		const agent = makeAgent({
			name: "agent-a",
			frontmatter: {
				description: "A test agent",
				depth: 1,
				can_spawn: ["agent-b", "legacy-agent"],
			},
		});

		const result = computeInlineCheckboxSaveValue(options, agent, "can_spawn", "agent-c");

		expect(result).toEqual(["agent-b", "legacy-agent", "agent-c"]);
	});

	it("keeps self in explicit can_spawn selections when computing save value", () => {
		const options = makeOptions();
		const agent = makeAgent({
			name: "agent-a",
			frontmatter: {
				description: "A test agent",
				depth: 1,
				can_spawn: ["agent-a", "agent-b"],
			},
		});

		const result = computeInlineCheckboxSaveValue(options, agent, "can_spawn", "agent-b");

		expect(result).toEqual(["agent-a"]);
	});
});
