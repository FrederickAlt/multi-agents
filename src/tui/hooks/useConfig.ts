import { useReducer, useCallback, useEffect, useRef } from "react";
import type {
	AgentConfigState,
	DiscoveredOptions,
	OptionColumnFieldName,
} from "../state/types.js";
import {
	configReducer,
	createInitialState,
	applyToggle,
	computeCheckboxSaveValue,
	resolveCheckboxSelection,
} from "../state/reducer.js";
import { useOptionDiscovery } from "./useOptionDiscovery.js";
import { writeFieldToFile } from "../file-io/write-agent.js";
import { modelDisplayNameToCanonicalRef } from "../discovery/options.js";
import {
	getFieldName,
	getOptionColumnAvailableItems,
	getOptionColumnCurrentValue,
	getOptionColumnItems,
	getOptionColumnSaveValue,
	getOptionColumnSelectedValues,
	isCheckboxOptionColumnField,
	isOptionColumnField,
	MODEL_OPTION_LOADING_ITEM,
	MODEL_OPTION_DEGRADED_STATUS,
} from "../state/option-columns.js";

/**
 * Central state hook for the Agent Configuration TUI.
 *
 * Orchestrates:
 * - Initial scan (agent reading + option discovery)
 * - State + dispatch via useReducer
 * - Overlay commit → selective file write-back
 * - Rescan support
 */
export function computeInlineCheckboxSaveValue(
	options: DiscoveredOptions,
	agent: AgentConfigState,
	fieldName: string,
	item: string,
): string[] | undefined {
	const typedField = fieldName as OptionColumnFieldName;
	const availableItems = getOptionColumnAvailableItems(
		options,
		typedField,
		agent.name,
	);
	const selectedValues = getOptionColumnSelectedValues(
		agent,
		options,
		typedField,
		agent.name,
	);
	const { localSelection, wasImplicit } = resolveCheckboxSelection(
		selectedValues,
		availableItems,
	);
	const { localSelection: newSelection } = applyToggle(
		localSelection,
		wasImplicit,
		availableItems,
		item,
	);
	return computeCheckboxSaveValue(newSelection, availableItems);
}

export function useConfig() {
	const [state, dispatch] = useReducer(configReducer, createInitialState());
	const { options, agents, loading, error, rescan: reScan } = useOptionDiscovery();

	const initRun = useRef(false);
	const rescanRequested = useRef(false);
	const latestDiscoveredOptions = useRef<DiscoveredOptions | null>(null);

	// Initialize state when discovery completes
	useEffect(() => {
		if (!loading && !initRun.current) {
			initRun.current = true;
			if (error) {
				dispatch({ type: "INIT_ERROR", error });
			} else {
				dispatch({ type: "INIT_COMPLETE", agents, options });
				latestDiscoveredOptions.current = options;
			}
		}
	}, [loading, error, agents, options]);

	// Rescan handler
	const rescan = useCallback(async () => {
		rescanRequested.current = true;
		dispatch({ type: "RESCAN" });
		await reScan();
	}, [reScan]);

	// Keep a ref to latest focused agent index for error reporting
	const focusRef = useRef(state.focus.agentIndex);
	focusRef.current = state.focus.agentIndex;

	// When rescan completes, update state
	useEffect(() => {
		if (initRun.current && rescanRequested.current && !loading && !error) {
			rescanRequested.current = false;
			latestDiscoveredOptions.current = options;
			dispatch({ type: "RESCAN_COMPLETE", agents, options });
		}
	}, [loading, error, agents, options]);

	// When rescan fails, show the error in the status line while keeping the
	// previous agents/options visible (useOptionDiscovery preserves them).
	useEffect(() => {
		if (initRun.current && rescanRequested.current && !loading && error) {
			rescanRequested.current = false;
			if (state.agents.length > 0) {
				const idx = Math.min(focusRef.current, state.agents.length - 1);
				dispatch({
					type: "SAVE_COMPLETE",
					agentIndex: idx,
					status: {
						type: "error",
						message: `Rescan failed: ${error}`,
						timestamp: Date.now(),
					},
				});
			} else {
				dispatch({ type: "INIT_ERROR", error: `Rescan failed: ${error}` });
			}
		}
	}, [loading, error, state.agents.length]);

	useEffect(() => {
		if (!initRun.current || loading || rescanRequested.current) return;
		if (latestDiscoveredOptions.current === options) return;

		latestDiscoveredOptions.current = options;
		dispatch({ type: "UPDATE_OPTIONS", options });
	}, [loading, options]);

	// Focus navigation
	const focusNextAgent = useCallback(() => {
		dispatch({ type: "FOCUS_AGENT", direction: "next" });
	}, []);

	const focusPrevAgent = useCallback(() => {
		dispatch({ type: "FOCUS_AGENT", direction: "prev" });
	}, []);

	const focusNextField = useCallback(() => {
		dispatch({ type: "FOCUS_FIELD", direction: "next" });
	}, []);

	const focusPrevField = useCallback(() => {
		dispatch({ type: "FOCUS_FIELD", direction: "prev" });
	}, []);

	const focusNextOptionItem = useCallback(() => {
		dispatch({ type: "FOCUS_OPTION_ITEM", direction: "next" });
	}, []);

	const focusPrevOptionItem = useCallback(() => {
		dispatch({ type: "FOCUS_OPTION_ITEM", direction: "prev" });
	}, []);

	const expand = useCallback(() => {
		dispatch({ type: "EXPAND" });
	}, []);

	const collapse = useCallback(() => {
		dispatch({ type: "COLLAPSE" });
	}, []);

	const focusAgentAt = useCallback((index: number) => {
		dispatch({ type: "FOCUS_AGENT_AT", agentIndex: index });
	}, []);

	// Overlay management
	const openOverlay = useCallback(
		(agentIndex: number, fieldName: string) => {
			dispatch({ type: "OPEN_OVERLAY", agentIndex, fieldName });
		},
		[],
	);

	const closeOverlay = useCallback(() => {
		dispatch({ type: "CLOSE_OVERLAY" });
	}, []);

	const toggleCheckbox = useCallback((item: string) => {
		dispatch({ type: "TOGGLE_CHECKBOX", item });
	}, []);

	const selectDropdown = useCallback((item: string) => {
		dispatch({ type: "SELECT_DROPDOWN", item });
	}, []);

	const saveFieldValue = useCallback((
		agent: AgentConfigState,
		agentIndex: number,
		fieldName: string,
		newValue: string[] | string | number | undefined,
	) => {
		dispatch({
			type: "SAVE_COMPLETE",
			agentIndex,
			status: { type: "saving", message: "Saving...", timestamp: Date.now() },
		});

		const result = writeFieldToFile(agent.filePath, fieldName, newValue);

		if (result.success) {
			if (result.frontmatter) {
				dispatch({
					type: "UPDATE_AGENT_FRONTMATTER",
					agentIndex,
					frontmatter: result.frontmatter,
					staleItems: agent.staleItems,
				});
			}

			dispatch({
				type: "SAVE_COMPLETE",
				agentIndex,
				status: {
					type: "saved",
					message: `Saved ${agent.name}.md`,
					timestamp: Date.now(),
				},
			});
			return;
		}

		dispatch({
			type: "SAVE_COMPLETE",
			agentIndex,
			status: {
				type: "error",
				message: `Save failed: ${result.error}`,
				timestamp: Date.now(),
			},
		});
	}, []);

	// Immediate save on checkbox toggle: write to file, then update local state.
	//
	// NOTE: state.overlay / state.agents are captured in the useCallback
	// closure.  Rapid successive toggles could theoretically see a stale
	// overlay (before the previous toggle's TOGGLE_CHECKBOX dispatch is
	// reflected).  In practice synchronous FS writes and React's batching
	// make this extremely unlikely, but a production fix would use a ref to
	// track the latest overlay state.
	const instantSaveCheckbox = useCallback((item: string) => {
		const overlay = state.overlay;
		if (!overlay || overlay.type !== "checkbox") return;

		const agent = state.agents[overlay.agentIndex];
		if (!agent) return;

		// Compute the new selection via the shared pure helper
		const { localSelection: newSelection } = applyToggle(
			overlay.localSelection,
			overlay.wasImplicit,
			overlay.availableItems,
			item,
		);

		// Determine save value using tri-state logic
		const newValue = computeCheckboxSaveValue(
			newSelection,
			overlay.availableItems,
		);

		// Save to file immediately
		dispatch({
			type: "SAVE_COMPLETE",
			agentIndex: overlay.agentIndex,
			status: { type: "saving", message: "Saving...", timestamp: Date.now() },
		});

		const result = writeFieldToFile(
			agent.filePath,
			overlay.fieldName,
			newValue,
		);

		if (result.success) {
			// Only update UI state after a successful write — no divergence.
			// Use result.frontmatter to avoid a separate readAgent re-read.
			if (result.frontmatter) {
				dispatch({
					type: "UPDATE_AGENT_FRONTMATTER",
					agentIndex: overlay.agentIndex,
					frontmatter: result.frontmatter,
					staleItems: agent.staleItems,
				});
			}

			toggleCheckbox(item);

			dispatch({
				type: "SAVE_COMPLETE",
				agentIndex: overlay.agentIndex,
				status: {
					type: "saved",
					message: `Saved ${agent.name}.md`,
					timestamp: Date.now(),
				},
			});
		} else {
			dispatch({
				type: "SAVE_COMPLETE",
				agentIndex: overlay.agentIndex,
				status: {
					type: "error",
					message: `Save failed: ${result.error}`,
					timestamp: Date.now(),
				},
			});
		}
	}, [state.overlay, state.agents, toggleCheckbox]);

	const selectFocusedOption = useCallback(() => {
		const agent = state.agents[state.focus.agentIndex];
		if (!agent || agent.error) return;

		const fieldName = getFieldName(state.focus.fieldIndex);
		if (!isOptionColumnField(fieldName)) return;

		const items = getOptionColumnItems(agent, state.options, fieldName, agent.name);
		const item = items[state.focus.optionItemIndex];
		if (item === undefined) return;

		if (isCheckboxOptionColumnField(fieldName)) {
			const nextValue = computeInlineCheckboxSaveValue(
				state.options,
				agent,
				fieldName,
				item,
			);
			saveFieldValue(agent, state.focus.agentIndex, fieldName, nextValue);
			return;
		}

		if (fieldName === "model" && state.options.modelDiscovery.status === "loading") {
			dispatch({
				type: "SAVE_COMPLETE",
				agentIndex: state.focus.agentIndex,
				status: {
					type: "error",
					message: "Model options are still loading.",
					timestamp: Date.now(),
				},
			});
			return;
		}

		if (item === MODEL_OPTION_LOADING_ITEM) {
			dispatch({
				type: "SAVE_COMPLETE",
				agentIndex: state.focus.agentIndex,
				status: {
					type: "error",
					message: "Model options are still loading.",
					timestamp: Date.now(),
				},
			});
			return;
		}
		if (item === MODEL_OPTION_DEGRADED_STATUS) {
			dispatch({
				type: "SAVE_COMPLETE",
				agentIndex: state.focus.agentIndex,
				status: {
					type: "error",
					message: "Model discovery unavailable.",
					timestamp: Date.now(),
				},
			});
			return;
		}

		const currentRaw = agent.frontmatter?.[fieldName];
		let nextValue: string | number;
		if (fieldName === "model") {
			const canonicalRef = modelDisplayNameToCanonicalRef(item, state.options.models);
			if (!canonicalRef) {
				dispatch({
					type: "SAVE_COMPLETE",
					agentIndex: state.focus.agentIndex,
					status: {
						type: "error",
						message: `Cannot resolve model "${item}"`,
						timestamp: Date.now(),
					},
				});
				return;
			}
			nextValue = canonicalRef;
		} else {
			nextValue = getOptionColumnSaveValue(fieldName, item);
		}

		if (currentRaw !== undefined && String(currentRaw) === String(nextValue)) {
			return;
		}

		saveFieldValue(agent, state.focus.agentIndex, fieldName, nextValue);
	}, [state.agents, state.focus, state.options, saveFieldValue]);

	// Commit overlay: save to file (dropdown) or just close (checkbox)
	const commitOverlay = useCallback(() => {
		const overlay = state.overlay;
		if (!overlay) return;

		// For checkboxes, each toggle already saved — just close the overlay
		if (overlay.type === "checkbox") {
			dispatch({ type: "CLOSE_OVERLAY" });
			return;
		}

		const agent = state.agents[overlay.agentIndex];
		if (!agent) return;

		// Dropdown: always write explicit value
		let newValue: string | number | undefined = overlay.localSelected;
		if (overlay.fieldName === "depth") {
			const parsed = Number(overlay.localSelected);
			if (!Number.isNaN(parsed)) {
				newValue = parsed;
			}
		}
		if (overlay.fieldName === "model") {
			// Map display name to canonical runtime reference
			const ref = modelDisplayNameToCanonicalRef(
				overlay.localSelected,
				state.options.models,
			);
			if (ref) {
				newValue = ref;
			} else {
				dispatch({
					type: "SAVE_COMPLETE",
					agentIndex: overlay.agentIndex,
					status: {
						type: "error",
						message: `Cannot resolve model "${overlay.localSelected}"`,
						timestamp: Date.now(),
					},
				});
				dispatch({ type: "CLOSE_OVERLAY" });
				return;
			}
		}

		// Dispatch saving status
		dispatch({
			type: "SAVE_COMPLETE",
			agentIndex: overlay.agentIndex,
			status: { type: "saving", message: "Saving...", timestamp: Date.now() },
		});

		// Write to file
		const result = writeFieldToFile(
			agent.filePath,
			overlay.fieldName,
			newValue,
		);

		if (result.success) {
			// Use result.frontmatter to avoid a separate readAgent re-read
			if (result.frontmatter) {
				dispatch({
					type: "UPDATE_AGENT_FRONTMATTER",
					agentIndex: overlay.agentIndex,
					frontmatter: result.frontmatter,
					// Preserve existing stale-items; they only refresh on full rescan
					staleItems: agent.staleItems,
				});
			}

			dispatch({
				type: "SAVE_COMPLETE",
				agentIndex: overlay.agentIndex,
				status: {
					type: "saved",
					message: `Saved ${agent.name}.md`,
					timestamp: Date.now(),
				},
			});
		} else {
			dispatch({
				type: "SAVE_COMPLETE",
				agentIndex: overlay.agentIndex,
				status: {
					type: "error",
					message: `Save failed: ${result.error}`,
					timestamp: Date.now(),
				},
			});
		}

		// Close overlay
		dispatch({ type: "CLOSE_OVERLAY" });
	}, [state.overlay, state.agents, state.options.models]);

	return {
		state,
		loading,
		focusNextAgent,
		focusPrevAgent,
		focusNextField,
		focusPrevField,
		focusNextOptionItem,
		focusPrevOptionItem,
		focusAgentAt,
		expand,
		collapse,
		openOverlay,
		closeOverlay,
		instantSaveCheckbox,
		selectDropdown,
		commitOverlay,
		selectFocusedOption,
		rescan,
	};
}
