/**
 * Unit tests for DepthPolicy — pure spawn-decision logic.
 */
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../subagent/agents.js";
import {
	checkTaskAllowed,
	childPolicy,
	type DepthPolicyState,
	defaultRootPolicy,
	selectedRootPolicy,
} from "../subagent/depth-policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(name: string, overrides: Partial<Pick<AgentConfig, "depth" | "can_spawn">> = {}): AgentConfig {
	return {
		name,
		description: `${name} description`,
		systemPrompt: "You are {{agent_name}}.",
		source: "builtin",
		filePath: `/tmp/${name}.md`,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// checkTaskAllowed
// ---------------------------------------------------------------------------

describe("checkTaskAllowed", () => {
	// ---- Default Root ----

	it("allows tasking any agent with default root policy", () => {
		const policy = defaultRootPolicy();
		const result = checkTaskAllowed(policy, "explorer");
		expect(result.allowed).toBe(true);
	});

	it("default root policy has no can_spawn restriction", () => {
		const policy = defaultRootPolicy();
		const result = checkTaskAllowed(policy, "any_agent");
		expect(result.allowed).toBe(true);
	});

	// ---- Selected Root depth ----

	it("denies tasking when selected root has depth 0", () => {
		const policy = selectedRootPolicy(makeAgent("root", { depth: 0 }));
		const result = checkTaskAllowed(policy, "explorer");
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("depth_limit");
		expect(result.error).toContain("depth limit 0");
	});

	it("allows tasking when selected root has depth 1", () => {
		const policy = selectedRootPolicy(makeAgent("root", { depth: 1 }));
		const result = checkTaskAllowed(policy, "explorer");
		expect(result.allowed).toBe(true);
	});

	it("denies tasking when selected root has depth 1 and treeDepth is 1 (root limit reached)", () => {
		const policy = selectedRootPolicy(makeAgent("root", { depth: 1 }));
		const atDepthOne: DepthPolicyState = { ...policy, treeDepth: 1 };
		const result = checkTaskAllowed(atDepthOne, "explorer");
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("depth_limit");
	});

	// ---- Selected Root can_spawn ----

	it("allows tasking when agent type is in can_spawn allowlist", () => {
		const policy = selectedRootPolicy(makeAgent("root", { depth: 2, can_spawn: ["planner", "explorer"] }));
		const result = checkTaskAllowed(policy, "explorer");
		expect(result.allowed).toBe(true);
	});

	it("denies tasking when agent type is not in can_spawn allowlist", () => {
		const policy = selectedRootPolicy(makeAgent("root", { depth: 2, can_spawn: ["planner"] }));
		const result = checkTaskAllowed(policy, "explorer");
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("spawn_not_allowed");
		expect(result.error).toContain("only allowed to task planner");
	});

	// ---- Sub-agent local depth ----

	it("denies tasking when sub-agent has local depth 0", () => {
		const child = makeAgent("coder", { depth: 0, can_spawn: ["explorer"] });
		const parentPolicy: DepthPolicyState = {
			treeDepth: 1,
			rootDepthLimit: 2,
			localDepthLimit: 0,
			can_spawn: child.can_spawn,
		};
		const result = checkTaskAllowed(parentPolicy, "explorer");
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("depth_limit");
		expect(result.error).toContain("depth limit (0)");
	});

	it("allows tasking when sub-agent has local depth 1 and root limit allows", () => {
		const child = makeAgent("coder", { depth: 1, can_spawn: ["explorer"] });
		const parentPolicy: DepthPolicyState = {
			treeDepth: 1,
			rootDepthLimit: 2,
			localDepthLimit: 1,
			can_spawn: child.can_spawn,
		};
		const result = checkTaskAllowed(parentPolicy, "explorer");
		expect(result.allowed).toBe(true);
	});

	// ---- Grandchild ----

	it("denies grandchild when treeDepth reaches root depth limit", () => {
		const policy: DepthPolicyState = {
			treeDepth: 2,
			rootDepthLimit: 2,
			localDepthLimit: 1,
			can_spawn: ["scout"],
		};
		const result = checkTaskAllowed(policy, "scout");
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("depth_limit");
	});

	it("allows grandchild when treeDepth is below root limit and local depth allows", () => {
		const policy: DepthPolicyState = {
			treeDepth: 2,
			rootDepthLimit: 3,
			localDepthLimit: 1,
			can_spawn: ["scout"],
		};
		const result = checkTaskAllowed(policy, "scout");
		expect(result.allowed).toBe(true);
	});

	// ---- can_spawn edge cases ----

	it("allows tasking any agent when can_spawn is undefined", () => {
		const policy: DepthPolicyState = {
			treeDepth: 1,
			rootDepthLimit: 2,
			localDepthLimit: 1,
			can_spawn: undefined,
		};
		const result = checkTaskAllowed(policy, "any_agent");
		expect(result.allowed).toBe(true);
	});

	it("denies tasking all agents when can_spawn is empty array", () => {
		const policy: DepthPolicyState = {
			treeDepth: 1,
			rootDepthLimit: 2,
			localDepthLimit: 1,
			can_spawn: [],
		};
		const result = checkTaskAllowed(policy, "explorer");
		expect(result.allowed).toBe(false);
		expect(result.code).toBe("spawn_not_allowed");
		expect(result.error).toContain("only allowed to task none");
	});
});

// ---------------------------------------------------------------------------
// childPolicy
// ---------------------------------------------------------------------------

describe("childPolicy", () => {
	it("inherits root depth limit from parent", () => {
		const parent: DepthPolicyState = {
			treeDepth: 0,
			rootDepthLimit: 3,
			localDepthLimit: 3,
			can_spawn: undefined,
		};
		const child = childPolicy(parent, makeAgent("explorer", { depth: 1 }), 1);

		expect(child.treeDepth).toBe(1);
		expect(child.rootDepthLimit).toBe(3);
		expect(child.localDepthLimit).toBe(1);
		expect(child.can_spawn).toBeUndefined();
	});

	it("uses child agent's depth for local depth limit", () => {
		const parent = defaultRootPolicy();
		const child = childPolicy(parent, makeAgent("coder", { depth: 0 }), 1);
		expect(child.localDepthLimit).toBe(0);
	});

	it("passes through child's can_spawn allowlist", () => {
		const parent = defaultRootPolicy();
		const childAgent = makeAgent("coder", { depth: 1, can_spawn: ["scout"] });
		const child = childPolicy(parent, childAgent, 1);
		expect(child.can_spawn).toEqual(["scout"]);
	});

	it("calculates tree depth correctly at level 2", () => {
		const parent: DepthPolicyState = {
			treeDepth: 1,
			rootDepthLimit: 3,
			localDepthLimit: 2,
			can_spawn: undefined,
		};
		const grandchild = childPolicy(parent, makeAgent("scout", { depth: 1 }), 2);
		expect(grandchild.treeDepth).toBe(2);
	});
});
