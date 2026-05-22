import React from "react";
import { Box, Text } from "ink";
import { OPTION_COLUMN_WIDTH } from "../state/types.js";

interface OptionColumnProps {
	fieldName: string;
	items: string[];
	selectedValues: string[];
	focusedItemIndex: number;
	isFocused: boolean;
	isCheckbox?: boolean;
	staleItems?: string[];
	maxVisibleItems?: number;
}

const FIELD_LABELS: Record<string, string> = {
	tools: "tools",
	extensions: "extensions",
	can_spawn: "can_spawn",
	skills: "skills",
	prompt_parts: "prompt_parts",
	reasoning_effort: "reasoning",
	depth: "depth",
	model: "model",
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
	selectedValues,
	focusedItemIndex,
	isFocused,
	isCheckbox = false,
	staleItems = [],
	maxVisibleItems = DEFAULT_MAX_VISIBLE_ITEMS,
}: OptionColumnProps) {
	const label = FIELD_LABELS[fieldName] ?? fieldName;
	const selectedSet = new Set(selectedValues);
	const staleSet = new Set(staleItems);
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
				const isFocusedItem = isFocused && absoluteIndex === focusedItemIndex;
				const isSelected = selectedSet.has(item);
				const isMissing = staleSet.has(item);
				const mark = isCheckbox ? (isSelected ? "☑" : "☐") : (isSelected ? "●" : "○");
				return (
					<Text
						key={`${fieldName}-${item}`}
						color={isFocusedItem ? "cyan" : isSelected ? "green" : undefined}
						bold={isFocusedItem}
					>
						{isFocusedItem ? ">" : " "} {mark} {item}
						{isMissing ? " (missing)" : ""}
					</Text>
				);
			})}
		</Box>
	);
}
