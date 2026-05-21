import React, { useState, useCallback } from "react";
import { Box } from "ink";
import { useConfig } from "../hooks/useConfig.js";
import { useKeyboard } from "../hooks/useKeyboard.js";
import { useMouse } from "../hooks/useMouse.js";
import { Board } from "../components/Board.js";
import { CheckboxOverlay } from "../components/CheckboxOverlay.js";
import { DropdownOverlay } from "../components/DropdownOverlay.js";
import { HelpFooter } from "../components/HelpFooter.js";
import { EmptyState } from "../components/EmptyState.js";
import { FIELDS_ORDER } from "../state/types.js";

/**
 * Root Ink component — state hub and layout orchestration.
 *
 * Owns useConfig() for state, useKeyboard() for input, and
 * manages an overlay-focused index for navigation within overlays.
 */
export function App() {
	const {
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
	} = useConfig();

	// Overlay-local focus index (for up/down navigation within overlay items)
	const [overlayFocusIndex, setOverlayFocusIndex] = useState(0);

	const overlay = state.overlay;

	// Reset overlay focus index when overlay opens/closes
	React.useEffect(() => {
		if (!overlay) {
			setOverlayFocusIndex(0);
		}
	}, [overlay]);

	// Build keyboard state getter for useKeyboard
	const getKeyboardState = useCallback(() => {
		const fieldName = state.focus.fieldIndex < FIELDS_ORDER.length
			? FIELDS_ORDER[state.focus.fieldIndex]
			: FIELDS_ORDER[0];

		return {
			isOverlayOpen: overlay !== null,
			overlayType: overlay?.type ?? null,
			overlayItems: overlay?.availableItems ?? [],
			overlayFocusedIndex: overlayFocusIndex,
			agentIndex: state.focus.agentIndex,
			fieldIndex: state.focus.fieldIndex,
			fieldName,
		};
	}, [overlay, overlayFocusIndex, state.focus]);

	// Wrap overlay navigation
	const handleOverlayUp = useCallback(() => {
		if (!overlay) return;
		const len = overlay.availableItems.length;
		if (len > 0) {
			setOverlayFocusIndex((prev) => (prev - 1 + len) % len);
		}
	}, [overlay]);

	const handleOverlayDown = useCallback(() => {
		if (!overlay) return;
		const len = overlay.availableItems.length;
		if (len > 0) {
			setOverlayFocusIndex((prev) => (prev + 1) % len);
		}
	}, [overlay]);

	const handleOverlayEnter = useCallback(() => {
		if (!overlay) return;
		if (overlay.type === "dropdown") {
			const item = overlay.availableItems[overlayFocusIndex];
			if (item) {
				selectDropdown(item);
			}
		}
		commitOverlay();
	}, [overlay, overlayFocusIndex, selectDropdown, commitOverlay]);

	// Keyboard hook
	useKeyboard(
		{
			focusNextAgent,
			focusPrevAgent,
			focusNextField,
			focusPrevField,
			openOverlay,
			closeOverlay,
			toggleCheckbox,
			selectDropdown,
			commitOverlay: () => commitOverlay(),
			rescan,
			overlayFocusUp: handleOverlayUp,
			overlayFocusDown: handleOverlayDown,
			overlayActivate: handleOverlayEnter,
		},
		getKeyboardState,
	);

	// Mouse hook (no-op)
	useMouse({});

	// Loading state
	if (loading) {
		return (
			<Box flexDirection="column" height="100%">
				<Box flexGrow={1} justifyContent="center" alignItems="center">
					<Box>Loading agent definitions...</Box>
				</Box>
			</Box>
		);
	}

	// Global error
	if (state.globalError) {
		return (
			<Box flexDirection="column" height="100%">
				<Box flexGrow={1} justifyContent="center" alignItems="center">
					<Box flexDirection="column">
						<Box color="red">Error: {state.globalError}</Box>
					</Box>
				</Box>
				<HelpFooter />
			</Box>
		);
	}

	// No agents
	if (state.agents.length === 0) {
		return (
			<Box flexDirection="column" height="100%">
				<Box flexGrow={1}>
					<EmptyState />
				</Box>
				<HelpFooter />
			</Box>
		);
	}

	return (
		<Box flexDirection="column" height="100%">
			<Box flexGrow={1}>
				<Board state={state} />
			</Box>

			{/* Overlays */}
			{overlay && overlay.type === "checkbox" && (
				<CheckboxOverlay
					overlay={overlay}
					focusedIndex={overlayFocusIndex}
				/>
			)}
			{overlay && overlay.type === "dropdown" && (
				<DropdownOverlay
					overlay={overlay}
					focusedIndex={overlayFocusIndex}
				/>
			)}

			<HelpFooter />
		</Box>
	);
}
