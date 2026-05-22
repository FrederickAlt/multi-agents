import { useEffect, useRef } from "react";
import { useStdin } from "ink";
import type { KeyboardActions, KeyboardState } from "./useKeyboard.js";
import { FIELDS_ORDER, COMPACT_ROW_HEIGHT, EXPANDED_ROW_HEIGHT } from "../state/types.js";

/** First row index where content starts in expanded mode (after border + header + spacer). */
const EXPANDED_FIELD_START_ROW = 4;

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
				handleBoardClick(row, state, act);
			}
		};

		internal_eventEmitter.on("input", handleInput);
		return () => {
			internal_eventEmitter.removeListener("input", handleInput);
		};
	}, [internal_eventEmitter]);
}

function handleBoardClick(
	row: number,
	state: KeyboardState,
	actions: KeyboardActions,
): void {
	// Rows are counted from top of board area.
	// We don't know the exact scroll position from mouse context alone,
	// so we focus the row that was clicked (assuming no scrolling,
	// or minimal). The reducer will clamp.
	// Row 1 is the first border line of the first visible agent.
	// For compact rows (3 lines), agent 0 spans rows 1-3, agent 1 spans 4-6, etc.
	// For expanded rows (10 lines), the expanded agent spans 10 rows.

	// If clicking in an expanded agent's field area, try to open that field.
	// Otherwise, just focus the agent the row belongs to.

	// Approximate: no scroll indicators at top.
	let rowCursor = 1; // first border line

	// Walk through agents, computing which one was clicked
	// We need to figure out which agent was clicked based on row position.
	// This is approximate since we don't track the exact scroll/more-above state.
	for (let i = state.scrollOffset; ; i++) {
		const isExpanded = state.isExpanded && i === state.agentIndex;
		const height = isExpanded ? EXPANDED_ROW_HEIGHT : COMPACT_ROW_HEIGHT;
		if (row >= rowCursor && row < rowCursor + height) {
			// Found the agent
			actions.focusAgentAt(i);

			if (isExpanded) {
				// Check if click is on a field row
				const fieldOffset = row - rowCursor - EXPANDED_FIELD_START_ROW;
				if (fieldOffset >= 0 && fieldOffset < FIELDS_ORDER.length) {
					const fieldName = FIELDS_ORDER[fieldOffset];
					actions.openOverlay(i, fieldName);
				}
			}
			return;
		}
		rowCursor += height;
		if (rowCursor > process.stdout.rows ?? 24) break;
	}
}

function handleOverlayClick(
	col: number,
	row: number,
	state: KeyboardState,
	actions: KeyboardActions,
): void {
	const OVERLAY_TOP = 4;
	const OVERLAY_LEFT = 10;

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
