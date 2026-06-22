import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/subagent/agents.js";
import {
	getSelectedRootAgentFromSessionEntries,
	resolveRootAgent,
	SELECTED_ROOT_AGENT_ENTRY_KEY,
	SELECTED_ROOT_AGENT_ENTRY_TYPE,
} from "../src/subagent/root-agent.js";

function makeAgent(name: string): AgentConfig {
	return {
		name,
		description: `${name} description`,
		systemPrompt: `${name} prompt`,
		source: "builtin",
		filePath: `/tmp/${name}.md`,
	};
}

describe("resolveRootAgent", () => {
	it("uses the built-in default Root agent name when no default is configured", () => {
		const result = resolveRootAgent({
			agents: [makeAgent("default"), makeAgent("planner")],
		});

		expect(result.agent.name).toBe("default");
		expect(result.selection).toBe("default");
	});

	it("uses the configured default Root agent when the session has no selection", () => {
		const result = resolveRootAgent({
			agents: [makeAgent("default"), makeAgent("customroot")],
			defaultRootAgent: "customroot",
		});

		expect(result.agent.name).toBe("customroot");
		expect(result.selection).toBe("default");
	});

	it("uses the session-local Root agent selection before the configured default", () => {
		const result = resolveRootAgent({
			agents: [makeAgent("default"), makeAgent("planner")],
			selectedAgent: "planner",
			defaultRootAgent: "default",
		});

		expect(result.agent.name).toBe("planner");
		expect(result.selection).toBe("session");
	});

	it("throws a visible error when the configured default Root agent is missing", () => {
		expect(() =>
			resolveRootAgent({
				agents: [makeAgent("planner")],
				defaultRootAgent: "missing",
			}),
		).toThrow('Default Root agent "missing" was not found');
	});

	it("reads the latest selected-root-agent custom entry from session entries", () => {
		const entries = [
			{ type: "session", customType: undefined as string | undefined },
			{
				type: "custom",
				customType: SELECTED_ROOT_AGENT_ENTRY_TYPE,
				data: { [SELECTED_ROOT_AGENT_ENTRY_KEY]: "planner" },
			},
			{ type: "custom", customType: "other", data: { [SELECTED_ROOT_AGENT_ENTRY_KEY]: "customroot" } },
			{
				type: "custom",
				customType: SELECTED_ROOT_AGENT_ENTRY_TYPE,
				data: { [SELECTED_ROOT_AGENT_ENTRY_KEY]: "reviewer" },
			},
		];
		expect(getSelectedRootAgentFromSessionEntries(entries)).toBe("reviewer");
	});

	it("ignores malformed selected-root-agent custom entries", () => {
		expect(
			getSelectedRootAgentFromSessionEntries([
				{
					type: "custom",
					customType: SELECTED_ROOT_AGENT_ENTRY_TYPE,
					data: 42,
				},
				{
					type: "custom",
					customType: SELECTED_ROOT_AGENT_ENTRY_TYPE,
					data: { selectedRootAgent: "  " },
				},
			]),
		).toBeUndefined();
	});
});
