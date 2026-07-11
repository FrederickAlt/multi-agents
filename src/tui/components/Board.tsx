import { Box, Text } from "ink";
import { clampVerticalScrollOffset, getAgentRowHeight } from "../layout.js";
import type { ConfigState } from "../state/types.js";
import { AgentRow } from "./AgentRow.js";

interface BoardProps {
	state: ConfigState;
	height?: number;
}

export function Board({ state, height }: BoardProps) {
	if (state.agents.length === 0) return null;

	const scrollOffset = clampVerticalScrollOffset(
		state.scrollOffset,
		state.focus.agentIndex,
		state.agents.length,
		state.expandedAgentIndex,
	);

	// Build visible agent slice and compute total consumed height.
	// Reserve 1 line for each scroll indicator that may be shown.
	let consumed = 0;
	const visibleAgents: { agent: (typeof state.agents)[0]; globalIdx: number }[] = [];
	const termHeight = Math.max(1, Math.floor(height ?? process.stdout.rows ?? 24));
	for (let i = scrollOffset; i < state.agents.length; i++) {
		const h = getAgentRowHeight(i, state.expandedAgentIndex);
		if (consumed + h > termHeight && visibleAgents.length > 0) break;
		visibleAgents.push({ agent: state.agents[i], globalIdx: i });
		consumed += h;
		if (consumed > termHeight) break;
	}

	const hasMoreAbove = scrollOffset > 0;
	const hasMoreBelow = scrollOffset + visibleAgents.length < state.agents.length;

	// Trim from bottom if scroll indicators would cause overflow.
	// Never trim the focused agent or expanded agent so focus remains visible.
	const indicatorLines = (hasMoreAbove ? 1 : 0) + (hasMoreBelow ? 1 : 0);
	while (indicatorLines > 0 && visibleAgents.length > 0 && consumed + indicatorLines > termHeight) {
		const last = visibleAgents[visibleAgents.length - 1];
		if (last.globalIdx === state.focus.agentIndex || last.globalIdx === state.expandedAgentIndex) break;
		visibleAgents.pop();
		consumed -= getAgentRowHeight(last.globalIdx, state.expandedAgentIndex);
	}

	return (
		<Box flexDirection="column" overflow="hidden" height={termHeight} width="100%">
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
						isFocused={state.focus.agentIndex === globalIdx}
						isExpanded={isExpanded}
						focusedField={isExpanded ? state.focus.fieldIndex : -1}
						focusedOptionItem={isExpanded ? state.focus.optionItemIndex : -1}
						optionColumnScrollOffset={state.optionColumnScrollOffset}
						options={state.options}
						status={state.statuses.get(agent.filePath)}
						optionColumnFilter={state.optionColumnFilter}
						optionColumnItemOrder={state.optionColumnItemOrder}
						agentIndex={globalIdx}
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
