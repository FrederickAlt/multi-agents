import { COLUMN_WIDTH, SCROLL_GUTTER_WIDTH } from "./state/types.js";

export function getMaxVisibleAgents(termWidth = process.stdout.columns ?? 80): number {
	const availableWidth = Math.max(COLUMN_WIDTH, termWidth - SCROLL_GUTTER_WIDTH);
	return Math.max(1, Math.floor(availableWidth / COLUMN_WIDTH));
}

export function clampScrollOffset(
	scrollOffset: number,
	focusedAgentIndex: number,
	agentCount: number,
	maxVisible = getMaxVisibleAgents(),
): number {
	let nextOffset = scrollOffset;
	if (focusedAgentIndex < nextOffset) {
		nextOffset = focusedAgentIndex;
	} else if (focusedAgentIndex >= nextOffset + maxVisible) {
		nextOffset = focusedAgentIndex - maxVisible + 1;
	}

	return Math.max(0, Math.min(nextOffset, agentCount - maxVisible));
}
