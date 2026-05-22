import React from "react";
import { Box, Text } from "ink";
import type { ConfigState } from "../state/types.js";
import { COMPACT_ROW_HEIGHT, EXPANDED_ROW_HEIGHT } from "../state/types.js";
import { getAgentRowHeight, getMaxVisibleAgents, clampVerticalScrollOffset } from "../layout.js";
import { AgentRow } from "./AgentRow.js";

interface BoardProps {
	state: ConfigState;
}

export function Board({ state }: BoardProps) {
	if (state.agents.length === 0) return null;

	const maxVisible = getMaxVisibleAgents(
		undefined,
		state.expandedAgentIndex,
		state.agents.length,
	);

	const scrollOffset = clampVerticalScrollOffset(
		state.scrollOffset,
		state.focus.agentIndex,
		state.agents.length,
		state.expandedAgentIndex,
	);

	// Build visible agent slice and compute total consumed height
	let consumed = 0;
	const visibleAgents: { agent: typeof state.agents[0]; globalIdx: number }[] = [];
	for (let i = scrollOffset; i < state.agents.length; i++) {
		const h = getAgentRowHeight(i, state.expandedAgentIndex);
		if (consumed + h > (process.stdout.rows ?? 24)) break;
		visibleAgents.push({ agent: state.agents[i], globalIdx: i });
		consumed += h;
	}

	const hasMoreAbove = scrollOffset > 0;
	const hasMoreBelow = scrollOffset + visibleAgents.length < state.agents.length;

	return (
		<Box flexDirection="column" overflow="hidden" height="100%">
			{/* Scroll indicator: up */}
			{hasMoreAbove && (
				<Box height={1} justifyContent="center">
					<Text dimColor>▲ more above</Text>
				</Box>
			)}

			{visibleAgents.map(({ agent, globalIdx }) => {
				const isExpanded = globalIdx === state.expandedAgentIndex;
				return (
					<AgentRow
						key={agent.filePath}
						agent={agent}
						options={state.options}
						isFocused={state.focus.agentIndex === globalIdx}
						isExpanded={isExpanded}
						focusedField={isExpanded ? state.focus.fieldIndex : -1}
						status={state.statuses.get(agent.filePath)}
					/>
				);
			})}

			{/* Scroll indicator: down */}
			{hasMoreBelow && (
				<Box height={1} justifyContent="center">
					<Text dimColor>▼ more below</Text>
				</Box>
			)}
		</Box>
	);
}
