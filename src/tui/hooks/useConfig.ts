import { useReducer, useCallback, useEffect, useRef } from "react";
import type {
	ConfigState,
	AgentConfigState,
	DiscoveredOptions,
	StatusInfo,
} from "../state/types.js";
import { configReducer, createInitialState } from "../state/reducer.js";
import { useOptionDiscovery } from "./useOptionDiscovery.js";
import { writeFieldToFile } from "../file-io/write-agent.js";
import { readAgent } from "../file-io/read-agent.js";

/**
 * Central state hook for the Agent Configuration TUI.
 *
 * Orchestrates:
 * - Initial scan (agent reading + option discovery)
 * - State + dispatch via useReducer
 * - Overlay commit → selective file write-back
 * - Rescan support
 */
export function useConfig() {
	const [state, dispatch] = useReducer(configReducer, createInitialState());
	const { options, agents, loading, error, rescan: reScan } = useOptionDiscovery();

	const initRun = useRef(false);
	const rescanRequested = useRef(false);

	// Initialize state when discovery completes
	useEffect(() => {
		if (!loading && !initRun.current) {
			initRun.current = true;
			if (error) {
				dispatch({ type: "INIT_ERROR", error });
			} else {
				dispatch({ type: "INIT_COMPLETE", agents, options });
			}
		}
	}, [loading, error, agents, options]);

	// Rescan handler
	const rescan = useCallback(async () => {
		rescanRequested.current = true;
		dispatch({ type: "RESCAN" });
		await reScan();
	}, [reScan]);

	// When rescan completes, update state
	useEffect(() => {
		if (initRun.current && rescanRequested.current && !loading && !error) {
			rescanRequested.current = false;
			dispatch({ type: "RESCAN_COMPLETE", agents, options });
		}
	}, [loading, error, agents, options]);

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

	// Commit overlay: save to file
	const commitOverlay = useCallback(async () => {
		const overlay = state.overlay;
		if (!overlay) return;

		const agent = state.agents[overlay.agentIndex];
		if (!agent) return;

		let newValue: string[] | string | number | undefined;

		if (overlay.type === "checkbox") {
			// Determine whether to write explicit list or remove field
			if (overlay.wasImplicit && overlay.localSelection.length === overlay.availableItems.length) {
				// User opened implicit, didn't change anything → keep implicit (undefined)
				newValue = undefined;
			} else if (overlay.localSelection.length === overlay.availableItems.length && !overlay.wasImplicit) {
				// User toggled back to all selected → remove field (become implicit)
				newValue = undefined;
			} else {
				// Write explicit list
				newValue = overlay.localSelection;
			}
		} else {
			// Dropdown: always write explicit value
			newValue = overlay.localSelected;
			// For depth, convert to number
			if (overlay.fieldName === "depth") {
				const parsed = Number(overlay.localSelected);
				if (!Number.isNaN(parsed)) {
					newValue = parsed;
				}
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
			// Re-read the agent to update frontmatter in state
			const updated = readAgent(agent.filePath);
			if (updated.frontmatter) {
				// Re-detect stale items for just this agent
				// (We'll do a simplified version — just carry over existing stale items)
				dispatch({
					type: "UPDATE_AGENT_FRONTMATTER",
					agentIndex: overlay.agentIndex,
					frontmatter: updated.frontmatter,
					staleItems: updated.staleItems,
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
	}, [state.overlay, state.agents]);

	return {
		state,
		loading,
		focusNextAgent,
		focusPrevAgent,
		focusNextField,
		focusPrevField,
		openOverlay,
		closeOverlay,
		toggleCheckbox,
		selectDropdown,
		commitOverlay,
		rescan,
	};
}
