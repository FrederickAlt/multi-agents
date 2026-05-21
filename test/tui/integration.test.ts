/**
 * Integration tests for Agent Configuration TUI.
 *
 * Smoke tests for the full flow: scan agents, modify fields, verify write-back.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Set PI_CODING_AGENT_DIR before importing modules that use getAgentDir()
const tempRoot = fs.mkdtempSync(path.join(tmpdir(), "pi-config-integration-"));
process.env.PI_CODING_AGENT_DIR = tempRoot;

import { scanAgents, readAgent, detectStaleItems } from "../../src/tui/file-io/read-agent.js";
import { writeFieldToFile } from "../../src/tui/file-io/write-agent.js";
import {
	discoverTools,
	discoverExtensions,
	discoverSkills,
	discoverPromptParts,
	discoverAllAgentNames,
} from "../../src/tui/discovery/options.js";
import { configReducer, createInitialState } from "../../src/tui/state/reducer.js";
import type { AgentConfigState, DiscoveredOptions } from "../../src/tui/state/types.js";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

let agentsDir: string;

beforeEach(() => {
	agentsDir = path.join(tempRoot, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

function writeAgentMd(name: string, frontmatter: Record<string, unknown>, body: string = "Test body"): string {
	const lines: string[] = ["---"];
	for (const [key, value] of Object.entries(frontmatter)) {
		if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${key}: []`);
			} else {
				lines.push(`${key}:`);
				for (const item of value) {
					lines.push(`  - ${String(item)}`);
				}
			}
		} else if (typeof value === "number") {
			lines.push(`${key}: ${value}`);
		} else {
			lines.push(`${key}: ${JSON.stringify(value)}`);
		}
	}
	lines.push("---", "", body);
	const filePath = path.join(agentsDir, `${name}.md`);
	fs.writeFileSync(filePath, lines.join("\n"));
	return filePath;
}

describe("Integration: scan → write → read → verify", () => {
	it("full round-trip for a single agent", () => {
		// Create an agent
		const p = writeAgentMd("test-agent", {
			description: "A test agent",
			model: "claude-sonnet",
			depth: 1,
			tools: ["read", "bash"],
		});

		// Read it
		const agent = readAgent(p);
		expect(agent.name).toBe("test-agent");
		expect(agent.error).toBeNull();
		expect(agent.frontmatter).toMatchObject({
			description: "A test agent",
			model: "claude-sonnet",
			depth: 1,
			tools: ["read", "bash"],
		});

		// Modify a field
		const result = writeFieldToFile(p, "model", "gpt-5");
		expect(result.success).toBe(true);

		// Read back
		const updated = readAgent(p);
		expect(updated.frontmatter).toMatchObject({
			description: "A test agent",
			model: "gpt-5",
			depth: 1,
			tools: ["read", "bash"],
		});
		expect(updated.body).toBe("Test body");
	});

	it("add new field, then remove it", () => {
		const p = writeAgentMd("minimal", {
			description: "Minimal agent",
		});

		// Add tools
		writeFieldToFile(p, "tools", ["edit", "write"]);
		let agent = readAgent(p);
		expect(agent.frontmatter!.tools).toEqual(["edit", "write"]);

		// Remove tools (set to undefined)
		writeFieldToFile(p, "tools", undefined);
		agent = readAgent(p);
		expect(agent.frontmatter!.tools).toBeUndefined();
		expect(agent.frontmatter!.description).toBe("Minimal agent");
	});

	it("modify list field without touching other fields", () => {
		const p = writeAgentMd("multi", {
			description: "Multi-field agent",
			model: "claude",
			depth: 2,
			tools: ["read", "bash"],
			extensions: [],
		});

		// Change tools
		writeFieldToFile(p, "tools", ["grep", "find", "ls"]);
		const agent = readAgent(p);
		expect(agent.frontmatter!.tools).toEqual(["grep", "find", "ls"]);
		expect(agent.frontmatter!.model).toBe("claude");
		expect(agent.frontmatter!.depth).toBe(2);
		expect(agent.frontmatter!.extensions).toEqual([]);
		expect(agent.body).toBe("Test body");
	});

	it("write empty list when all items unchecked", () => {
		const p = writeAgentMd("full", {
			description: "Full agent",
			tools: ["read", "bash", "edit"],
		});

		writeFieldToFile(p, "tools", []);
		const agent = readAgent(p);
		expect(agent.frontmatter!.tools).toEqual([]);

		const content = fs.readFileSync(p, "utf-8");
		expect(content).toContain("tools: []");
	});
});

describe("Integration: scanAgents with discovery", () => {
	it("discovers agents and detects stale items", () => {
		writeAgentMd("agent-a", {
			description: "Agent A",
			can_spawn: ["agent-b", "deleted-agent"],
		});
		writeAgentMd("agent-b", {
			description: "Agent B",
			skills: ["real-skill", "missing-skill"],
		});

		// Create one real skill
		const skillsDir = path.join(tempRoot, "skills", "real-skill");
		fs.mkdirSync(skillsDir, { recursive: true });
		fs.writeFileSync(path.join(skillsDir, "SKILL.md"), "# Real Skill");

		const agents = scanAgents(tempRoot);

		const allNames = discoverAllAgentNames(tempRoot);
		const discoveredSkills = discoverSkills(tempRoot);

		detectStaleItems(
			agents,
			allNames,
			[],
			[],
			discoveredSkills,
			[],
		);

		const agentA = agents.find((a) => a.name === "agent-a")!;
		const agentB = agents.find((a) => a.name === "agent-b")!;

		expect(agentA.staleItems.can_spawn).toEqual(["deleted-agent"]);
		expect(agentB.staleItems.skills).toEqual(["missing-skill"]);
	});

	it("scanAgents returns empty when no agents dir", () => {
		fs.rmSync(agentsDir, { recursive: true });
		const agents = scanAgents(tempRoot);
		expect(agents).toEqual([]);
	});
});

describe("Integration: reducer + state flow", () => {
	it("simulates full navigation and overlay cycle", () => {
		const agent1: AgentConfigState = {
			name: "a1",
			description: "Agent 1",
			filePath: "/tmp/a1.md",
			frontmatter: { description: "Agent 1", model: "claude" },
			body: "body1",
			error: null,
			staleItems: {},
		};
		const agent2: AgentConfigState = {
			name: "a2",
			description: "Agent 2",
			filePath: "/tmp/a2.md",
			frontmatter: { description: "Agent 2", tools: ["read"] },
			body: "body2",
			error: null,
			staleItems: {},
		};

		const options: DiscoveredOptions = {
			tools: ["read", "bash", "write"],
			extensions: [],
			models: [{ provider: "a", modelId: "c", displayName: "claude" }],
			reasoningEfforts: ["low", "medium", "high"],
			depths: [0, 1, 2],
			canSpawn: ["a2"],
			skills: [],
			promptParts: [],
		};

		let state = createInitialState();
		state = configReducer(state, { type: "INIT_COMPLETE", agents: [agent1, agent2], options });

		// Focus next agent
		state = configReducer(state, { type: "FOCUS_AGENT", direction: "next" });
		expect(state.focus.agentIndex).toBe(1);

		// Focus next field
		state = configReducer(state, { type: "FOCUS_FIELD", direction: "next" });
		expect(state.focus.fieldIndex).toBe(1);

		// Open overlay on tools field on agent 2
		state = configReducer(state, { type: "OPEN_OVERLAY", agentIndex: 1, fieldName: "tools" });
		expect(state.overlay).not.toBeNull();
		expect(state.overlay!.type).toBe("checkbox");
		expect(state.overlay!.localSelection).toEqual(["read"]);

		// Toggle checkbox
		state = configReducer(state, { type: "TOGGLE_CHECKBOX", item: "read" });
		expect(state.overlay!.localSelection).toEqual([]);

		state = configReducer(state, { type: "TOGGLE_CHECKBOX", item: "bash" });
		expect(state.overlay!.localSelection).toEqual(["bash"]);

		// Close overlay
		state = configReducer(state, { type: "CLOSE_OVERLAY" });
		expect(state.overlay).toBeNull();
	});
});
