import React from "react";
import { Box, Text } from "ink";
import type { OverlayState } from "../state/types.js";

interface CheckboxOverlayProps {
	overlay: OverlayState;
	focusedIndex: number;
}

export function CheckboxOverlay({ overlay, focusedIndex }: CheckboxOverlayProps) {
	const { agentIndex, fieldName, availableItems, localSelection, staleItems, wasImplicit } = overlay;

	return (
		<Box
			flexDirection="column"
			borderStyle="double"
			borderColor="yellow"
			paddingX={1}
			position="absolute"
			top={4}
			left={10}
			width={40}
			height={Math.min(availableItems.length + 5, 20)}
		>
			<Text bold>
				{fieldName} — agent {agentIndex}
			</Text>

			{wasImplicit && (
				<Text dimColor>All items selected (field not in file)</Text>
			)}

			{availableItems.map((item, idx) => {
				const isChecked = localSelection.includes(item);
				const isStale = staleItems.includes(item);
				const isFocused = idx === focusedIndex;

				return (
					<Box key={item} flexDirection="row">
						<Text
							color={isFocused ? "cyan" : undefined}
							bold={isFocused}
						>
							{isFocused ? "> " : "  "}
							{isChecked ? "☑" : "☐"} {item}
							{isStale ? " (missing)" : ""}
						</Text>
					</Box>
				);
			})}

			<Box marginTop={1}>
				<Text dimColor>Enter: save  Esc: cancel  Space: toggle</Text>
			</Box>
		</Box>
	);
}
