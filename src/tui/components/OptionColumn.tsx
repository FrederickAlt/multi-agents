import React from "react";
import { Box, Text } from "ink";
import { OPTION_COLUMN_WIDTH } from "../state/types.js";

interface OptionColumnProps {
	fieldName: string;
	items: string[];
	selectedValue: string;
	focusedItemIndex: number;
	isFocused: boolean;
}

const FIELD_LABELS: Record<string, string> = {
	reasoning_effort: "reasoning",
	depth: "depth",
};

export function OptionColumn({
	fieldName,
	items,
	selectedValue,
	focusedItemIndex,
	isFocused,
}: OptionColumnProps) {
	const label = FIELD_LABELS[fieldName] ?? fieldName;

	return (
		<Box
			flexDirection="column"
			width={OPTION_COLUMN_WIDTH}
			flexShrink={0}
			borderStyle={isFocused ? "bold" : "single"}
			borderColor={isFocused ? "cyan" : "gray"}
			paddingX={1}
		>
			<Text bold color={isFocused ? "cyan" : undefined}>{label}</Text>
			{items.map((item, index) => {
				const selected = item === selectedValue;
				const focused = isFocused && index === focusedItemIndex;
				return (
					<Text
						key={`${fieldName}-${item}`}
						color={focused ? "cyan" : selected ? "green" : undefined}
						bold={focused}
					>
						{focused ? ">" : " "} {selected ? "●" : "○"} {item}
					</Text>
				);
			})}
		</Box>
	);
}
