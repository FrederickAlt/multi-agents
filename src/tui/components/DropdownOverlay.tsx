import React from "react";
import { Box, Text } from "ink";
import type { OverlayState } from "../state/types.js";

interface DropdownOverlayProps {
	overlay: OverlayState;
	focusedIndex: number;
}

export function DropdownOverlay({ overlay, focusedIndex }: DropdownOverlayProps) {
	const { agentIndex, fieldName, availableItems, localSelected } = overlay;

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

			{availableItems.map((item, idx) => {
				const isSelected = item === localSelected;
				const isFocused = idx === focusedIndex;

				return (
					<Box key={item} flexDirection="row">
						<Text
							color={isFocused ? "cyan" : undefined}
							bold={isFocused}
						>
							{isFocused ? "> " : "  "}
							{isSelected ? "●" : " "} {item}
						</Text>
					</Box>
				);
			})}

			<Box marginTop={1}>
				<Text dimColor>Enter: select  Esc: cancel</Text>
			</Box>
		</Box>
	);
}
