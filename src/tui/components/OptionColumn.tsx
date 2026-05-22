import React from "react";
import { Box, Text } from "ink";
import { OPTION_COLUMN_WIDTH } from "../state/types.js";
import {
	MODEL_OPTION_DEGRADED_STATUS,
	MODEL_OPTION_LOADING_ITEM,
} from "../state/option-columns.js";

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

function isModelStatusValue(item: string): boolean {
	return item === MODEL_OPTION_LOADING_ITEM || item === MODEL_OPTION_DEGRADED_STATUS;
}

function getModelPinnedStatus(items: string[]): string | undefined {
	const candidate = items[0];
	return isModelStatusValue(candidate) ? candidate : undefined;
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
	const selectedValue = selectedValues[0] ?? "";
	const staleSet = new Set(staleItems);
	const visibleItemCount = Math.max(1, maxVisibleItems);
	const pinnedStatus = fieldName === "model" ? getModelPinnedStatus(items) : undefined;
	const scrollableItems = pinnedStatus ? items.slice(1) : items;
	const focusedInScrollable = pinnedStatus && focusedItemIndex > 0
		? focusedItemIndex - 1
		: Math.max(0, focusedItemIndex);
	const { start, end } = getVisibleRange(
		scrollableItems.length,
		focusedInScrollable,
		visibleItemCount,
	);
	const visibleItems = scrollableItems.slice(start, end);

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
			{pinnedStatus && (
				<Text
					key={`${fieldName}-status`}
					color={
						isFocused && focusedItemIndex === 0
							? "cyan"
							: pinnedStatus === selectedValue
								? "green"
								: undefined
					}
					bold={isFocused && focusedItemIndex === 0}
				>
					{isFocused && focusedItemIndex === 0 ? ">" : " "} {pinnedStatus === selectedValue ? "●" : "○"} {pinnedStatus}
				</Text>
			)}
			{visibleItems.map((item, index) => {
				const absoluteIndexInScrollable = start + index;
				const absoluteIndex = pinnedStatus
					? absoluteIndexInScrollable + 1
					: absoluteIndexInScrollable;
				const isFocusedItem = isFocused && absoluteIndex === focusedItemIndex;
				const isSelected = selectedSet.has(item);
				const isMissing = staleSet.has(item);
				const mark = isCheckbox
					? isSelected
						? "☑"
						: "☐"
					: isSelected
						? "●"
						: "○";
				return (
					<Text
						key={`${fieldName}-${item}-${absoluteIndex}`}
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
