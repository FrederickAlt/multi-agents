import type { AgentConfig } from "./agents.js";

export const DEFAULT_ROOT_AGENT_NAME = "default";

export type RootAgentSelection = "session" | "default";

export interface ResolveRootAgentOptions {
	agents: AgentConfig[];
	selectedAgent?: string;
	defaultRootAgent?: string;
}

export interface ResolvedRootAgent {
	agent: AgentConfig;
	selection: RootAgentSelection;
}

export function resolveRootAgent(options: ResolveRootAgentOptions): ResolvedRootAgent {
	const defaultRootAgent = options.defaultRootAgent?.trim() || DEFAULT_ROOT_AGENT_NAME;
	const selectedAgent = options.selectedAgent?.trim();
	const name = selectedAgent || defaultRootAgent;
	const agent = options.agents.find((candidate) => candidate.name === name);

	if (!agent) {
		const available = options.agents.map((candidate) => candidate.name).join(", ") || "none";
		if (selectedAgent) {
			throw new Error(`Selected Root agent "${selectedAgent}" was not found. Available agents: ${available}.`);
		}
		throw new Error(`Default Root agent "${defaultRootAgent}" was not found. Available agents: ${available}.`);
	}

	return { agent, selection: selectedAgent ? "session" : "default" };
}
