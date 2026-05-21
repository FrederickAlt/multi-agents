import React from "react";
import { Box } from "ink";
import type { ConfigState } from "../state/types.js";
import { COLUMN_WIDTH } from "../state/types.js";
import { AgentColumn } from "./AgentColumn.js";

interface BoardProps {
	state: ConfigState;
}

export function Board({ state }: BoardProps) {
	if (state.agents.length === 0) return null;

	// Calculate how many columns fit in the terminal
	// We assume standard 80-col terminal, but Ink can measure dynamically.
	// For simplicity, we use the columns from process.stdout if available.
	const termWidth = process.stdout.columns ?? 80;
	const maxVisible = Math.max(1, Math.floor(termWidth / COLUMN_WIDTH));

	// Ensure scrollOffset keeps focused agent visible
	let scrollOffset = state.scrollOffset;
	if (state.focus.agentIndex < scrollOffset) {
		scrollOffset = state.focus.agentIndex;
	} else if (state.focus.agentIndex >= scrollOffset + maxVisible) {
		scrollOffset = state.focus.agentIndex - maxVisible + 1;
	}

	// Clamp
	scrollOffset = Math.max(
		0,
		Math.min(scrollOffset, state.agents.length - maxVisible),
	);

	const visibleAgents = state.agents.slice(
		scrollOffset,
		scrollOffset + maxVisible,
	);

	return (
		<Box flexDirection="row" overflow="hidden" height="100%">
			{scrollOffset > 0 && (
				<Box width={3} justifyContent="center" alignItems="center">
					{/* Left scroll indicator */}
				</Box>
			)}
			{visibleAgents.map((agent, i) => {
				const globalIdx = scrollOffset + i;
				return (
					<Box key={agent.filePath} flexShrink={0}>
						<AgentColumn
							agent={agent}
							options={state.options}
							isFocused={state.focus.agentIndex === globalIdx}
							focusedField={state.focus.fieldIndex}
							status={state.statuses.get(agent.filePath)}
						/>
					</Box>
				);
			})}
		</Box>
	);
}
