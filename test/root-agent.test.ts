import { describe, expect, it } from "vitest";
import { resolveRootAgent } from "../subagent/root-agent.js";
import type { AgentConfig } from "../subagent/agents.js";

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
		expect(() => resolveRootAgent({
			agents: [makeAgent("planner")],
			defaultRootAgent: "missing",
		})).toThrow('Default Root agent "missing" was not found');
	});
});
