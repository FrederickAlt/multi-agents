import React from "react";
import { Box, Text } from "ink";
import type { ConfigState } from "../state/types.js";
import { SCROLL_GUTTER_WIDTH } from "../state/types.js";
import { clampScrollOffset, getMaxVisibleAgents } from "../layout.js";
import { AgentColumn } from "./AgentColumn.js";

interface BoardProps {
	state: ConfigState;
}

export function Board({ state }: BoardProps) {
	if (state.agents.length === 0) return null;

	const maxVisible = getMaxVisibleAgents();
	const scrollOffset = clampScrollOffset(
		state.scrollOffset,
		state.focus.agentIndex,
		state.agents.length,
		maxVisible,
	);

	const visibleAgents = state.agents.slice(
		scrollOffset,
		scrollOffset + maxVisible,
	);

	return (
		<Box flexDirection="row" overflow="hidden" height="100%">
			<Box width={SCROLL_GUTTER_WIDTH} justifyContent="center" alignItems="center">
				{scrollOffset > 0 && <Text dimColor>‹</Text>}
			</Box>
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
