import { useCallback, useEffect, useRef, useState } from "react";
import { readExtensionCatalog } from "../../subagent/extension-catalog.js";
import { PI_REASONING_EFFORTS } from "../../subagent/reasoning-effort.js";
import {
	discoverAllAgentNames,
	discoverCachedPiRuntimeResources,
	discoverConfiguredExtensions,
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

function buildExtensionAliasMap(discoveredExtensions: string[]): Record<string, string[]> {
	const extensionAliases: Record<string, string[]> = {};
	for (const extensionName of discoveredExtensions) {
		extensionAliases[extensionName] = [extensionName];
	}
	return extensionAliases;
}

function mergeAliasMaps(...maps: Array<Record<string, string[]> | undefined>): Record<string, string[]> {
	const merged: Record<string, string[]> = {};
	for (const map of maps) {
		for (const [extensionName, aliases] of Object.entries(map ?? {})) {
			const values = merged[extensionName] ?? [];
			for (const alias of aliases) {
				if (!values.includes(alias)) values.push(alias);
			}
			merged[extensionName] = values;
		}
	}
	return merged;
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
		disabledExtensions: [],
		extensionAliases: {},
		models: [],
		defaultModel: "",
		modelDiscovery: {
			status: "loading",
			error: null,
		},
		reasoningEfforts: [...PI_REASONING_EFFORTS],
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
			const cachedRuntimeResources = discoverCachedPiRuntimeResources(agentDir);
			const configuredExtensions = discoverConfiguredExtensions(agentDir);
			const authoritativeExtensions = readExtensionCatalog(agentDir, process.cwd());
			const authoritativeAliasMap = authoritativeExtensions
				? Object.fromEntries(authoritativeExtensions.map((entry) => [entry.selector, entry.aliases]))
				: undefined;
			const discoveredExtensions = authoritativeExtensions
				? authoritativeExtensions.map((entry) => entry.selector)
				: [...new Set([...configuredExtensions.extensions, ...cachedRuntimeResources.extensions])].sort();
			const discovered: DiscoveredOptions = {
				tools: [...new Set([...discoverTools(agentDir, toolLists), ...cachedRuntimeResources.tools])].sort(),
				toolExtensionNames: cachedRuntimeResources.toolExtensionNames,
				extensions: discoveredExtensions,
				disabledExtensions: authoritativeExtensions ? [] : configuredExtensions.disabledExtensions,
				extensionAliases:
					authoritativeAliasMap ??
					mergeAliasMaps(
						buildExtensionAliasMap(discoveredExtensions),
						cachedRuntimeResources.extensionAliases,
						configuredExtensions.extensionAliases,
					),
				models: [],
				defaultModel: "",
				modelDiscovery: {
					status: "loading",
					error: null,
				},
				reasoningEfforts: [...PI_REASONING_EFFORTS],
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
				discovered.extensionAliases,
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
							discovered.extensionAliases,
						);
						setAgents([...scanned]);
						return;
					}
					const runtimeExtensions = authoritativeExtensions
						? discovered.extensions
						: [...new Set([...piRuntimeResources.extensions, ...configuredExtensions.extensions])].sort();
					const runtimeDiscovered = {
						...discovered,
						tools: piRuntimeResources.tools,
						toolExtensionNames: piRuntimeResources.toolExtensionNames,
						extensions: runtimeExtensions,
						disabledExtensions: authoritativeExtensions ? [] : configuredExtensions.disabledExtensions,
						extensionAliases: authoritativeAliasMap
							? authoritativeAliasMap
							: mergeAliasMaps(
									piRuntimeResources.extensionAliases ?? discovered.extensionAliases,
									configuredExtensions.extensionAliases,
								),
						skills: piRuntimeResources.skills,
					};
					detectStaleItems(
						scanned,
						allNames,
						runtimeDiscovered.tools,
						runtimeDiscovered.extensions,
						runtimeDiscovered.skills,
						runtimeDiscovered.promptParts,
						runtimeDiscovered.extensionAliases,
					);
					setAgents([...scanned]);
					setOptions((prev) => ({
						...prev,
						tools: runtimeDiscovered.tools,
						toolExtensionNames: runtimeDiscovered.toolExtensionNames,
						extensions: runtimeDiscovered.extensions,
						disabledExtensions: runtimeDiscovered.disabledExtensions,
						extensionAliases: runtimeDiscovered.extensionAliases,
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
						discovered.extensionAliases,
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
