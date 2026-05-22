import React from "react";
import { Box, Text } from "ink";
import { OPTION_COLUMN_WIDTH } from "../state/types.js";

interface OptionColumnProps {
	fieldName: string;
	items: string[];
	selectedValue: string;
	focusedItemIndex: number;
	isFocused: boolean;
	maxVisibleItems?: number;
}

const FIELD_LABELS: Record<string, string> = {
	reasoning_effort: "reasoning",
	depth: "depth",
};

const DEFAULT_MAX_VISIBLE_ITEMS = 5;

function clamp(index: number, len: number): number {
	if (len <= 0) return 0;
	return Math.max(0, Math.min(index, len));
}

function getVisibleRange(
	itemsCount: number,
	focusedItemIndex: number,
	maxItems: number,
): { start: number; end: number } {
	if (itemsCount <= 0 || maxItems <= 0) {
		return { start: 0, end: 0 };
	}

	if (itemsCount <= maxItems) {
		return { start: 0, end: itemsCount };
	}

	const maxStart = itemsCount - maxItems;
	const center = Math.floor((maxItems - 1) / 2);
	const start = clamp(focusedItemIndex - center, maxStart);
	return { start, end: start + maxItems };
}

export function OptionColumn({
	fieldName,
	items,
	selectedValue,
	focusedItemIndex,
	isFocused,
	maxVisibleItems = DEFAULT_MAX_VISIBLE_ITEMS,
}: OptionColumnProps) {
	const label = FIELD_LABELS[fieldName] ?? fieldName;
	const visibleItemCount = Math.max(1, maxVisibleItems);
	const { start, end } = getVisibleRange(
		items.length,
		focusedItemIndex,
		visibleItemCount,
	);
	const visibleItems = items.slice(start, end);

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
			{visibleItems.map((item, index) => {
				const absoluteIndex = start + index;
				const selected = item === selectedValue;
				const focused = isFocused && absoluteIndex === focusedItemIndex;
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
