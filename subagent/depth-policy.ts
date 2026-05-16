/**
 * DepthPolicy — centralised spawn-decision logic for the Task tool.
 *
 * One module owns every spawn decision: tree-depth limit, per-agent local
 * depth budget, and canSpawn allowlist.  Error messages are model-readable
 * so the LLM can recover from denials without guessing.
 *
 * Vocabulary:
 * - treeDepth        → current position in the agent tree (Root = 0, child = 1, …)
 * - rootDepthLimit   → max tree depth the Root agent permits
 * - localDepthLimit  → how many levels *this* agent config allows downward
 * - canSpawn         → optional allowlist of agent names this agent may delegate to
 */

import type { AgentConfig } from "./agents.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DepthPolicyState {
	/** Current agent-tree position.  Root is 0, first-level sub-agent is 1, etc. */
	treeDepth: number;
	/** The absolute maximum tree depth the Root agent allows. */
	rootDepthLimit: number;
	/**
	 * How many more Task levels this agent's own config permits.
	 * A value of 0 means this agent may never spawn (or resume) a sub-agent.
	 */
	localDepthLimit: number;
	/** Optional allowlist.  `undefined` = unrestricted. */
	canSpawn?: readonly string[];
}

export type SpawnDecision =
	| { allowed: true }
	| { allowed: false; code: string; error: string };

// ---------------------------------------------------------------------------
// Decision function
// ---------------------------------------------------------------------------

/**
 * Determine whether a Task call (new or resume) targeting `targetAgentName`
 * is permitted by `policy`.
 */
export function checkTaskAllowed(
	policy: DepthPolicyState,
	targetAgentName: string,
): SpawnDecision {
	// 1. Root tree-depth limit
	if (policy.treeDepth >= policy.rootDepthLimit) {
		return {
			allowed: false,
			code: "depth_limit",
			error: `Cannot task ${targetAgentName}: root depth limit ${policy.rootDepthLimit} has been reached at tree depth ${policy.treeDepth}.`,
		};
	}

	// 2. Current agent's local depth budget
	if (policy.localDepthLimit <= 0) {
		return {
			allowed: false,
			code: "depth_limit",
			error: `Cannot task ${targetAgentName}: the current agent's depth limit (${policy.localDepthLimit}) allows no further sub-agents.`,
		};
	}

	// 3. canSpawn allowlist (undefined = unrestricted)
	if (policy.canSpawn && !policy.canSpawn.includes(targetAgentName)) {
		const list = policy.canSpawn.length > 0
			? policy.canSpawn.join(", ")
			: "none";
		return {
			allowed: false,
			code: "spawn_not_allowed",
			error: `Cannot task ${targetAgentName}: the current agent is only allowed to task ${list}.`,
		};
	}

	return { allowed: true };
}

// ---------------------------------------------------------------------------
// Policy constructors
// ---------------------------------------------------------------------------

/**
 * Default Root agent policy — no persona selected.
 *
 * - treeDepth 0 (root)
 * - no tree-depth cap
 * - no local-depth restriction
 * - no spawn allowlist restriction
 */
export function defaultRootPolicy(): DepthPolicyState {
	return {
		treeDepth: 0,
		rootDepthLimit: Number.POSITIVE_INFINITY,
		localDepthLimit: Number.POSITIVE_INFINITY,
		canSpawn: undefined,
	};
}

/**
 * Build a Root policy from a *selected* Root agent persona.
 *
 * The Root agent's `depth` config serves as both the global tree limit
 * and the local budget for spawning children.
 */
export function selectedRootPolicy(agent: AgentConfig): DepthPolicyState {
	const depth = agent.depth ?? 0;
	return {
		treeDepth: 0,
		rootDepthLimit: depth,
		localDepthLimit: depth,
		canSpawn: agent.canSpawn,
	};
}

/**
 * Build the policy for a child agent that is about to be spawned.
 *
 * @param parent       The parent agent's current policy state.
 * @param childAgent   Config of the agent being spawned.
 * @param childTreeDepth  The child's position in the tree (1 for first-level, etc.).
 */
export function childPolicy(
	parent: DepthPolicyState,
	childAgent: AgentConfig,
	childTreeDepth: number,
): DepthPolicyState {
	const childLocalDepth = childAgent.depth ?? 0;

	return {
		treeDepth: childTreeDepth,
		rootDepthLimit: parent.rootDepthLimit,
		localDepthLimit: childLocalDepth,
		canSpawn: childAgent.canSpawn,
	};
}
