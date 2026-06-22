import type { AgentConfig } from "./agents.js";

export const DEFAULT_ROOT_AGENT_NAME = "default";

export type RootAgentSelection = "session" | "default";

export interface ResolveRootAgentOptions {
	agents: AgentConfig[];
	selectedAgent?: string;
	defaultRootAgent?: string;
}

export const SELECTED_ROOT_AGENT_ENTRY_TYPE = "selected-root-agent" as const;
export const SELECTED_ROOT_AGENT_ENTRY_KEY = "selectedRootAgent" as const;

export interface ResolvedRootAgent {
	agent: AgentConfig;
	selection: RootAgentSelection;
}

export interface SessionCustomEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export function getSelectedRootAgentFromSessionEntries(entries: SessionCustomEntryLike[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom") continue;
		if (entry.customType !== SELECTED_ROOT_AGENT_ENTRY_TYPE) continue;
		if (!entry.data || typeof entry.data !== "object") continue;
		const raw = (entry.data as { [key: string]: unknown })[SELECTED_ROOT_AGENT_ENTRY_KEY];
		if (typeof raw !== "string") continue;
		const trimmed = raw.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
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
