import { useState, useEffect } from "react";
import type { DiscoveredOptions, AgentConfigState } from "../state/types.js";
import {
	discoverTools,
	discoverExtensions,
	discoverModels,
	discoverSkills,
	discoverPromptParts,
	discoverAllAgentNames,
} from "../discovery/options.js";
import { scanAgents, detectStaleItems } from "../file-io/read-agent.js";
import { getAgentDir } from "../pi-compat.js";

/**
 * Hook that scans ~/.pi/agent/ for all selectable options on mount.
 * Returns discovered options and a rescan function.
 */
export function useOptionDiscovery(): {
	options: DiscoveredOptions;
	agents: AgentConfigState[];
	loading: boolean;
	error: string | null;
	rescan: () => Promise<void>;
} {
	const [options, setOptions] = useState<DiscoveredOptions>({
		tools: [],
		extensions: [],
		models: [],
		defaultModel: "",
		modelDiscovery: {
			status: "loading",
			error: null,
		},
		reasoningEfforts: ["low", "medium", "high", "maximum"],
		depths: [0, 1, 2, 3, 4, 5],
		canSpawn: [],
		skills: [],
		promptParts: [],
	});
	const [agents, setAgents] = useState<AgentConfigState[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const scan = async () => {
		setLoading(true);
		setError(null);
		try {
			const agentDir = getAgentDir();
			const scanned = scanAgents(agentDir);

			const allNames = discoverAllAgentNames(agentDir);
			const toolLists = scanned
				.filter((a) => a.frontmatter && !a.error)
				.map((a) => {
					const t = a.frontmatter!.tools;
					return Array.isArray(t) ? t.map(String) : [];
				});

			const discovered: DiscoveredOptions = {
				tools: discoverTools(agentDir, toolLists),
				extensions: discoverExtensions(agentDir),
				models: [],
				defaultModel: "",
				modelDiscovery: {
					status: "loading",
					error: null,
				},
				reasoningEfforts: ["low", "medium", "high", "maximum"],
				depths: [0, 1, 2, 3, 4, 5],
				canSpawn: allNames,
				skills: discoverSkills(agentDir),
				promptParts: discoverPromptParts(agentDir),
			};

			// Detect stale items before surfacing options to the UI.
			detectStaleItems(
				scanned,
				allNames,
				discovered.tools,
				discovered.extensions,
				discovered.skills,
				discovered.promptParts,
			);

			setAgents(scanned);
			setOptions(discovered);
			setLoading(false);

			// Continue model discovery asynchronously.
			try {
				const {
					models: discoveredModels,
					defaultModelDisplayName,
					status,
					error: modelError,
				} = await discoverModels(agentDir);
				setOptions((prev) => ({
					...prev,
					models: discoveredModels,
					defaultModel: defaultModelDisplayName,
					modelDiscovery: {
						status,
						error: modelError ?? null,
					},
				}));
			} catch (modelErr) {
				setOptions((prev) => ({
					...prev,
					modelDiscovery: {
						status: "degraded",
						error: (modelErr as Error).message,
					},
				}));
			}
		} catch (err) {
			setError((err as Error).message);
			setLoading(false);
		}
	};

	useEffect(() => {
		scan();
	}, []);

	return { options, agents, loading, error, rescan: scan };
}
