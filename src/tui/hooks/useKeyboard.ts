import { useApp, useInput, useStdin } from "ink";
import { isOptionColumnField } from "../state/option-columns.js";

export interface KeyboardActions {
	focusNextAgent: () => void;
	focusPrevAgent: () => void;
	focusNextField: () => void;
	focusPrevField: () => void;
	focusNextOptionItem: () => void;
	focusPrevOptionItem: () => void;
	focusNextMode?: () => void;
	openOverlay: (agentIndex: number, fieldName: string) => void;
	focusAgentAt: (index: number) => void;
	closeOverlay: () => void;
	toggleCheckbox: (item: string) => void;
	selectDropdown: (item: string) => void;
	commitOverlay: () => void;
	confirmStaleCleanup: () => void;
	skipStaleCleanup: () => void;
	selectFocusedOption: () => void;
	rescan: () => void;
	expand: () => void;
	collapse: () => void;
	setOptionColumnFilter: (value: string) => void;
	overlayFocusUp: () => void;
	overlayFocusDown: () => void;
	overlayActivate: () => void;
}

export interface KeyboardState {
	isOverlayOpen: boolean;
	isExpanded: boolean;
	overlayType: "checkbox" | "dropdown" | "stale-cleanup" | null;
	overlayItems: string[];
	overlayFocusedIndex: number;
	agentIndex: number;
	fieldIndex: number;
	fieldName: string;
	scrollOffset: number;
	optionColumnFilter: string;
}

type KeyboardKey = {
	alt?: boolean;
	backspace?: boolean;
	ctrl?: boolean;
	delete?: boolean;
	downArrow?: boolean;
	escape?: boolean;
	leftArrow?: boolean;
	meta?: boolean;
	rightArrow?: boolean;
	tab?: boolean;
	return?: boolean;
	upArrow?: boolean;
};

const isInlineColumnFilterInput = (input: string, key: KeyboardKey): boolean => {
	return input.length === 1 && input !== " " && !key.ctrl && !key.meta && !key.alt;
};

export function isInlineEditableField(fieldName: string): boolean {
	return isOptionColumnField(fieldName);
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

export function handleKeyboardInput(
	input: string,
	key: KeyboardKey,
	state: KeyboardState,
	actions: KeyboardActions,
	exit: () => void,
): void {
	const isInlineOptionColumn = state.isExpanded && isOptionColumnField(state.fieldName);

	const shouldHandleGlobalShortcuts = !state.isExpanded || !isInlineOptionColumn || state.isOverlayOpen;

	if (shouldHandleGlobalShortcuts && key.escape && !state.isOverlayOpen && !state.isExpanded) {
		exit();
		return;
	}

	if (shouldHandleGlobalShortcuts && (input === "r" || input === "R")) {
		actions.rescan();
		return;
	}

	if (state.isOverlayOpen) {
		if (state.overlayType === "stale-cleanup") {
			if (key.return || input === "y" || input === "Y") {
				actions.confirmStaleCleanup();
				return;
			}
			if (key.escape || input === "n" || input === "N") {
				actions.skipStaleCleanup();
				return;
			}
			return;
		}

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

		return;
	}

	if (state.isExpanded) {
		if (key.escape) {
			actions.collapse();
			return;
		}

		if (key.tab && state.fieldName === "model") {
			actions.focusNextMode?.();
			return;
		}

		if (key.leftArrow) {
			actions.focusPrevField();
			return;
		}

		if (key.rightArrow) {
			actions.focusNextField();
			return;
		}

		if (key.upArrow) {
			if (isInlineOptionColumn) {
				actions.focusPrevOptionItem();
			} else {
				actions.focusPrevField();
			}
			return;
		}

		if (key.downArrow) {
			if (isInlineOptionColumn) {
				actions.focusNextOptionItem();
			} else {
				actions.focusNextField();
			}
			return;
		}

		if (!isInlineOptionColumn) {
			if (input === "h") {
				actions.focusPrevField();
				return;
			}

			if (input === "l") {
				actions.focusNextField();
				return;
			}

			if (input === "j") {
				actions.focusNextField();
				return;
			}

			if (input === "k") {
				actions.focusPrevField();
				return;
			}
		}

		if (key.backspace || key.delete) {
			if (isInlineOptionColumn) {
				actions.setOptionColumnFilter(state.optionColumnFilter.slice(0, -1));
			}
			return;
		}

		if (isInlineOptionColumn && isInlineColumnFilterInput(input, key)) {
			actions.setOptionColumnFilter(state.optionColumnFilter + input);
			return;
		}

		if (key.return || input === " ") {
			handleExpandedEnterOrSpace(state, actions);
			return;
		}

		return;
	}

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
}

/**
 * Hook that maps keyboard input to TUI actions.
 * Uses Ink's useInput for keypress handling.
 */
export function useKeyboard(actions: KeyboardActions, getState: () => KeyboardState) {
	const { exit } = useApp();
	const { isRawModeSupported } = useStdin();
	const inputIsActive = Boolean(isRawModeSupported && typeof process.stdin.setRawMode === "function");

	useInput(
		(input, key) => {
			const state = getState();
			handleKeyboardInput(input, key, state, actions, exit);
		},
		{ isActive: inputIsActive },
	);
}
