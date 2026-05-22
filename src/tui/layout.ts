import { COMPACT_ROW_HEIGHT, EXPANDED_ROW_HEIGHT } from "./state/types.js";

/** Height of a single agent row given the expansion state. */
export function getAgentRowHeight(
	agentIndex: number,
	expandedAgentIndex: number | null,
): number {
	if (agentIndex === expandedAgentIndex) {
		return EXPANDED_ROW_HEIGHT;
	}
	return COMPACT_ROW_HEIGHT;
}

/**
 * Compute total visible agent count that fits the terminal height,
 * accounting for the expanded agent taking more lines.
 */
export function getMaxVisibleAgents(
	termHeight: number = process.stdout.rows ?? 24,
	expandedAgentIndex: number | null = null,
	agentCount = 1,
): number {
	let remaining = termHeight;
	let count = 0;
	for (let i = 0; i < agentCount && remaining > 0; i++) {
		const h = getAgentRowHeight(i, expandedAgentIndex);
		if (remaining < h) break;
		remaining -= h;
		count++;
	}
	return Math.max(1, count);
}

/**
 * Clamp the scroll offset so the focused agent stays visible,
 * accounting for the expanded row if present.
 */
export function clampVerticalScrollOffset(
	scrollOffset: number,
	focusedAgentIndex: number,
	agentCount: number,
	expandedAgentIndex: number | null = null,
): number {
	if (agentCount === 0) return 0;

	const termHeight = process.stdout.rows ?? 24;
	let nextOffset = scrollOffset;

	// If focused agent is before the visible window, scroll up to it
	if (focusedAgentIndex < nextOffset) {
		return focusedAgentIndex;
	}

	// If focused agent is after the visible window, advance scroll
	// so it fits.
	let used = 0;
	let visible = 0;
	for (let i = nextOffset; i < agentCount; i++) {
		const h = getAgentRowHeight(i, expandedAgentIndex);
		if (used + h > termHeight) break;
		used += h;
		visible++;
	}

	if (focusedAgentIndex >= nextOffset + visible) {
		// Advance until focused agent is the last (or only) visible
		nextOffset = focusedAgentIndex;
		// Walk back to fill remaining space
		while (nextOffset > 0) {
			const h = getAgentRowHeight(nextOffset - 1, expandedAgentIndex);
			if (h + used > termHeight) break;
			used += h;
			nextOffset--;
		}
		return nextOffset;
	}

	return Math.max(0, Math.min(nextOffset, agentCount - 1));
}
