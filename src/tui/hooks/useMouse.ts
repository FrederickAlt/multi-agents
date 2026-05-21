import { useEffect, useRef } from "react";
import { useStdin } from "ink";
import type { KeyboardActions, KeyboardState } from "./useKeyboard.js";
import { FIELDS_ORDER, COLUMN_WIDTH, SCROLL_GUTTER_WIDTH } from "../state/types.js";

const HEADER_END_ROW = 4; // name(1) + desc(1) + spacer(1) + border(1) = 4
const OVERLAY_TOP = 4;
const OVERLAY_LEFT = 10;

/** SGR mouse sequence regex: \x1b[<Cb;Cx;CyM (press) or m (release) */
const MOUSE_SGR_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

export function useMouse(
	actions: KeyboardActions,
	getState: () => KeyboardState,
): void {
	const { stdin, internal_eventEmitter } = useStdin();
	const enabled = useRef(false);

	// Stable refs so the event listener doesn't re-register on every render
	const actionsRef = useRef(actions);
	actionsRef.current = actions;

	const getStateRef = useRef(getState);
	getStateRef.current = getState;

	// Enable SGR mouse tracking
	useEffect(() => {
		if (!stdin.isTTY || enabled.current) return;
		enabled.current = true;

		// Enable SGR extended mouse mode (coordinates beyond 223, button release)
		stdin.write("\x1b[?1006h");
		// Enable mouse tracking (button events)
		stdin.write("\x1b[?1000h");

		return () => {
			stdin.write("\x1b[?1000l");
			stdin.write("\x1b[?1006l");
			enabled.current = false;
		};
	}, [stdin]);

	// Listen for mouse events via the internal event emitter (same as useInput)
	useEffect(() => {
		if (!internal_eventEmitter) return;

		const handleInput = (data: string) => {
			const match = MOUSE_SGR_RE.exec(data);
			if (!match) return;

			const button = parseInt(match[1], 10);
			const col = parseInt(match[2], 10);
			const row = parseInt(match[3], 10);
			const eventType = match[4]; // M=press, m=release

			// Only handle left-button press
			if (button !== 0 || eventType !== "M") return;

			const state = getStateRef.current();
			const act = actionsRef.current;

			if (state.isOverlayOpen) {
				handleOverlayClick(col, row, state, act);
			} else {
				handleBoardClick(col, row, state, act);
			}
		};

		internal_eventEmitter.on("input", handleInput);
		return () => {
			internal_eventEmitter.removeListener("input", handleInput);
		};
	}, [internal_eventEmitter]);
}

function handleBoardClick(
	col: number,
	row: number,
	state: KeyboardState,
	actions: KeyboardActions,
): void {
	// Determine which column was clicked.
	// Column 0 starts after the reserved scroll gutter.
	if (col <= SCROLL_GUTTER_WIDTH) return;
	const columnIdx = Math.floor((col - SCROLL_GUTTER_WIDTH - 1) / COLUMN_WIDTH);
	if (columnIdx < 0) return;

	// Compute global agent index (visible column + scroll offset).
	const globalAgentIdx = state.scrollOffset + columnIdx;

	// Click within the header area (name, description, spacer + border)?
	const isHeader = row <= HEADER_END_ROW;

	// Focus the clicked agent directly (single dispatch, no loop).
	actions.focusAgentAt(globalAgentIdx);

	if (isHeader) return;

	// Field click: determine field index from row position
	// After the border (row 1) and header rows (2-4), fields start at row 5
	const fieldIdx = row - HEADER_END_ROW - 1;
	if (fieldIdx < 0 || fieldIdx >= FIELDS_ORDER.length) return;

	const fieldName = FIELDS_ORDER[fieldIdx];

	// Focus the field via relative moves
	const fieldDelta = fieldIdx - state.fieldIndex;
	for (let i = 0; i < Math.abs(fieldDelta); i++) {
		if (fieldDelta > 0) {
			actions.focusNextField();
		} else {
			actions.focusPrevField();
		}
	}

	// Open overlay for the clicked agent/field using global index.
	actions.openOverlay(globalAgentIdx, fieldName);
}

function handleOverlayClick(
	col: number,
	row: number,
	state: KeyboardState,
	actions: KeyboardActions,
): void {
	// Check if click is within the overlay bounding box
	if (col < OVERLAY_LEFT || col > OVERLAY_LEFT + 40) return;
	if (row < OVERLAY_TOP + 1 || row > OVERLAY_TOP + 20) return;

	// Item rows start at OVERLAY_TOP + 2 (border + title)
	const itemIdx = row - OVERLAY_TOP - 2;
	if (itemIdx < 0 || itemIdx >= state.overlayItems.length) {
		return;
	}

	const item = state.overlayItems[itemIdx];
	if (!item) return;

	if (state.overlayType === "checkbox") {
		actions.toggleCheckbox(item);
	} else if (state.overlayType === "dropdown") {
		actions.selectDropdown(item);
		actions.commitOverlay();
	}
}
