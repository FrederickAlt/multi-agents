import { useInput, useApp, useStdin } from "ink";

export interface KeyboardActions {
	focusNextAgent: () => void;
	focusPrevAgent: () => void;
	focusNextField: () => void;
	focusPrevField: () => void;
	focusNextOptionItem: () => void;
	focusPrevOptionItem: () => void;
	openOverlay: (agentIndex: number, fieldName: string) => void;
	focusAgentAt: (index: number) => void;
	closeOverlay: () => void;
	toggleCheckbox: (item: string) => void;
	selectDropdown: (item: string) => void;
	commitOverlay: () => void;
	selectFocusedOption: () => void;
	rescan: () => void;
	expand: () => void;
	collapse: () => void;
	overlayFocusUp: () => void;
	overlayFocusDown: () => void;
	overlayActivate: () => void;
}

export interface KeyboardState {
	isOverlayOpen: boolean;
	isExpanded: boolean;
	overlayType: "checkbox" | "dropdown" | null;
	overlayItems: string[];
	overlayFocusedIndex: number;
	agentIndex: number;
	fieldIndex: number;
	fieldName: string;
	scrollOffset: number;
}

export function isInlineEditableField(fieldName: string): boolean {
	return fieldName === "reasoning_effort" || fieldName === "depth";
}

export function handleExpandedEnterOrSpace(
	state: Pick<KeyboardState, "fieldName" | "agentIndex">,
	actions: Pick<KeyboardActions, "selectFocusedOption" | "openOverlay">,
): void {
	if (isInlineEditableField(state.fieldName)) {
		actions.selectFocusedOption();
	} else {
		actions.openOverlay(state.agentIndex, state.fieldName);
	}
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
	const { isRawModeSupported } = useStdin();
	const inputIsActive = Boolean(isRawModeSupported && typeof process.stdin.setRawMode === "function");

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
			// Overlay keyboard handling (unchanged from horizontal layout)
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
			// Main board keyboard handling (vertical layout)
			if (state.isExpanded) {
				if (key.escape) {
					actions.collapse();
					return;
				}

				if (key.leftArrow || input === "h") {
					actions.focusPrevField();
					return;
				}

				if (key.rightArrow || input === "l") {
					actions.focusNextField();
					return;
				}

				if (key.upArrow || input === "k") {
					if (isInlineEditableField(state.fieldName)) {
						actions.focusPrevOptionItem();
					} else {
						actions.focusPrevField();
					}
					return;
				}

				if (key.downArrow || input === "j") {
					if (isInlineEditableField(state.fieldName)) {
						actions.focusNextOptionItem();
					} else {
						actions.focusNextField();
					}
					return;
				}

				if (key.return || input === " ") {
					handleExpandedEnterOrSpace(state, actions);
					return;
				}

				return;
			} else {
				// Compact mode: Up/Down navigate agents, Enter/Space expands,
				// Left/Right are no-ops
				if (key.upArrow || input === "k") {
					actions.focusPrevAgent();
					return;
				}

				if (key.downArrow || input === "j") {
					actions.focusNextAgent();
					return;
				}

				if (key.return || input === " ") {
					actions.expand();
					return;
				}

				// Left/Right are no-ops in compact mode
				return;
			}
		}
	}, { isActive: inputIsActive });
}
