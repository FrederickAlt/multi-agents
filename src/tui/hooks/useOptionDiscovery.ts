import { useCallback, useEffect, useRef, useState } from "react";
import {
	discoverAllAgentNames,
	discoverExtensions,
	discoverModels,
	discoverPiRuntimeResources,
	discoverPromptParts,
	discoverSkills,
	discoverTools,
} from "../discovery/options.js";
import { detectStaleItems, scanAgents } from "../file-io/read-agent.js";
import { getAgentDir } from "../pi-compat.js";
import type { AgentConfigState, DiscoveredOptions } from "../state/types.js";

const RUNTIME_RESOURCE_STALE_FIELDS = ["tools", "extensions"] as const;

function clearRuntimeResourceStaleItems(agents: AgentConfigState[]): void {
	for (const agent of agents) {
		for (const field of RUNTIME_RESOURCE_STALE_FIELDS) {
			delete agent.staleItems[field];
		}
	}
}

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
	const latestRequestId = useRef(0);
	const isMounted = useRef(true);

	const [options, setOptions] = useState<DiscoveredOptions>({
		tools: [],
		toolExtensionNames: {},
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

	const scan = useCallback(async () => {
		const requestId = ++latestRequestId.current;
		const isCurrentRequest = () => isMounted.current && requestId === latestRequestId.current;

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

			const piRuntimeResourcesPromise = discoverPiRuntimeResources(agentDir, toolLists);
			const discovered: DiscoveredOptions = {
				tools: discoverTools(agentDir, toolLists),
				toolExtensionNames: {},
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

			// Runtime discovery can add extension-provided tools/extensions shortly
			// after fallback options render, so do not mark those fields stale yet.
			detectStaleItems(
				scanned,
				allNames,
				discovered.tools,
				discovered.extensions,
				discovered.skills,
				discovered.promptParts,
			);
			clearRuntimeResourceStaleItems(scanned);

			if (!isCurrentRequest()) {
				return;
			}

			setAgents(scanned);
			setOptions(discovered);
			setLoading(false);

			void piRuntimeResourcesPromise
				.then((piRuntimeResources) => {
					if (!isCurrentRequest()) return;
					if (!piRuntimeResources) {
						detectStaleItems(
							scanned,
							allNames,
							discovered.tools,
							discovered.extensions,
							discovered.skills,
							discovered.promptParts,
						);
						setAgents([...scanned]);
						return;
					}
					const runtimeDiscovered = {
						...discovered,
						tools: piRuntimeResources.tools,
						toolExtensionNames: piRuntimeResources.toolExtensionNames,
						extensions: piRuntimeResources.extensions,
						skills: piRuntimeResources.skills,
					};
					detectStaleItems(
						scanned,
						allNames,
						runtimeDiscovered.tools,
						runtimeDiscovered.extensions,
						runtimeDiscovered.skills,
						runtimeDiscovered.promptParts,
					);
					setAgents([...scanned]);
					setOptions((prev) => ({
						...prev,
						tools: runtimeDiscovered.tools,
						toolExtensionNames: runtimeDiscovered.toolExtensionNames,
						extensions: runtimeDiscovered.extensions,
						skills: runtimeDiscovered.skills,
					}));
				})
				.catch(() => {
					if (!isCurrentRequest()) return;
					detectStaleItems(
						scanned,
						allNames,
						discovered.tools,
						discovered.extensions,
						discovered.skills,
						discovered.promptParts,
					);
					setAgents([...scanned]);
				});

			// Continue model discovery asynchronously.
			try {
				const {
					models: discoveredModels,
					defaultModelDisplayName,
					status,
					error: modelError,
				} = await discoverModels(agentDir);
				if (!isCurrentRequest()) {
					return;
				}
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
				if (!isCurrentRequest()) {
					return;
				}
				setOptions((prev) => ({
					...prev,
					modelDiscovery: {
						status: "degraded",
						error: (modelErr as Error).message,
					},
				}));
			}
		} catch (err) {
			if (!isCurrentRequest()) {
				return;
			}
			setError((err as Error).message);
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		isMounted.current = true;
		scan();

		return () => {
			isMounted.current = false;
		};
	}, [scan]);
	return { options, agents, loading, error, rescan: scan };
}
