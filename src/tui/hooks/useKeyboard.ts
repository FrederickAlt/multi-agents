import { useInput, useApp } from "ink";

export interface KeyboardActions {
	focusNextAgent: () => void;
	focusPrevAgent: () => void;
	focusNextField: () => void;
	focusPrevField: () => void;
	openOverlay: (agentIndex: number, fieldName: string) => void;
	focusAgentAt: (index: number) => void;
	closeOverlay: () => void;
	toggleCheckbox: (item: string) => void;
	selectDropdown: (item: string) => void;
	commitOverlay: () => void;
	rescan: () => void;
	overlayFocusUp: () => void;
	overlayFocusDown: () => void;
	overlayActivate: () => void;
}

export interface KeyboardState {
	isOverlayOpen: boolean;
	overlayType: "checkbox" | "dropdown" | null;
	overlayItems: string[];
	overlayFocusedIndex: number;
	agentIndex: number;
	fieldIndex: number;
	fieldName: string;
	scrollOffset: number;
}

/**
 * Hook that maps keyboard input to TUI actions.
 * Uses Ink's useInput for keypress handling.
 */
export function useKeyboard(
	actions: KeyboardActions,
	getState: () => KeyboardState,
) {
	const { exit } = useApp();

	useInput((input, key) => {
		// Global keys
		if (input === "q" || input === "Q") {
			exit();
			return;
		}

		if (input === "r" || input === "R") {
			actions.rescan();
			return;
		}

		const state = getState();

		if (state.isOverlayOpen) {
			// Overlay keyboard handling
			if (key.escape) {
				actions.closeOverlay();
				return;
			}

			if (key.return) {
				actions.overlayActivate();
				return;
			}

			if (key.upArrow || input === "k") {
				actions.overlayFocusUp();
				return;
			}

			if (key.downArrow || input === "j") {
				actions.overlayFocusDown();
				return;
			}

			if (input === " " && state.overlayType === "checkbox") {
				const item = state.overlayItems[state.overlayFocusedIndex];
				if (item) {
					actions.toggleCheckbox(item);
				}
				return;
			}
		} else {
			// Main board keyboard handling
			if (key.leftArrow || input === "h") {
				actions.focusPrevAgent();
				return;
			}

			if (key.rightArrow || input === "l") {
				actions.focusNextAgent();
				return;
			}

			if (key.upArrow || input === "k") {
				actions.focusPrevField();
				return;
			}

			if (key.downArrow || input === "j") {
				actions.focusNextField();
				return;
			}

			if (key.return) {
				actions.openOverlay(state.agentIndex, state.fieldName);
				return;
			}
		}
	});
}
