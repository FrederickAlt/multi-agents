import { Box, Text } from "ink";
import { normalizeReasoningEffort, PI_REASONING_EFFORTS } from "../../subagent/reasoning-effort.js";
import { getModelPinnedStatus, getOptionColumnLabel, getOptionColumnWidth } from "../option-column-layout.js";

interface OptionColumnProps {
	fieldName: string;
	items: string[];
	selectedValues?: string[];
	selectedValue?: string;
	focusedItemIndex: number;
	isFocused: boolean;
	isCheckbox?: boolean;
	staleItems?: string[];
	disabledItems?: string[];
	disabled?: boolean;
	filterText?: string;
	maxVisibleItems?: number;
	width?: number;
	modeSummary?: { model: string; reasoningEffort: string };
	linked?: boolean;
	centerLinked?: boolean;
}

const DEFAULT_MAX_VISIBLE_ITEMS = 5;

function clamp(index: number, len: number): number {
	if (len <= 0) return 0;
	return Math.max(0, Math.min(index, len));
}

function formatEffort(effort: string): string {
	const normalized = normalizeReasoningEffort(effort);
	const index = Math.max(0, normalized === undefined ? -1 : PI_REASONING_EFFORTS.indexOf(normalized));
	return PI_REASONING_EFFORTS.map((_level, itemIndex) => (itemIndex === index ? "●" : "○")).join("");
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
	selectedValue: selectedValueProp,
	focusedItemIndex,
	isFocused,
	isCheckbox = false,
	staleItems = [],
	disabledItems = [],
	disabled = false,
	filterText,
	maxVisibleItems = DEFAULT_MAX_VISIBLE_ITEMS,
	width,
	modeSummary,
	linked = false,
	centerLinked = false,
}: OptionColumnProps) {
	const label = getOptionColumnLabel(fieldName);
	const effectiveSelectedValues = selectedValues ?? (selectedValueProp !== undefined ? [selectedValueProp] : []);
	const selectedSet = new Set(effectiveSelectedValues);
	const selectedValue = effectiveSelectedValues[0] ?? "";
	const staleSet = new Set(staleItems);
	const disabledSet = new Set(disabledItems);
	const visibleItemCount = Math.max(1, maxVisibleItems);
	const filterValue = filterText?.trim() ?? "";
	const showFilterBar = isFocused && filterValue.length > 0;
	const columnWidth =
		width ??
		getOptionColumnWidth({
			fieldName,
			items,
			selectedValues,
			selectedValue: selectedValueProp,
			isFocused,
			isCheckbox,
			staleItems,
			filterText,
			modeSummary,
		});
	const pinnedStatus = fieldName === "model" || fieldName === "smart_model" ? getModelPinnedStatus(items) : undefined;
	const reservedLines = (showFilterBar ? 1 : 0) + (pinnedStatus ? 1 : 0);
	const scrollableItems = pinnedStatus ? items.slice(1) : items;
	const visibleItemWindow = Math.max(0, visibleItemCount - reservedLines);
	const focusedInScrollable =
		pinnedStatus && focusedItemIndex > 0 ? focusedItemIndex - 1 : Math.max(0, focusedItemIndex);
	const { start, end } = getVisibleRange(scrollableItems.length, focusedInScrollable, visibleItemWindow);
	const visibleItems = scrollableItems.slice(start, end);
	const isLinkedInactive = linked && !isFocused;
	const displayedEffort = modeSummary
		? (normalizeReasoningEffort(modeSummary.reasoningEffort) ?? modeSummary.reasoningEffort)
		: undefined;

	return (
		<Box
			flexDirection="column"
			width={columnWidth}
			flexShrink={0}
			borderStyle={isFocused ? "bold" : "single"}
			borderColor={disabled || isLinkedInactive ? "gray" : isFocused ? "cyan" : "gray"}
			paddingX={1}
		>
			<Text
				bold
				color={!disabled && !isLinkedInactive && isFocused ? "cyan" : undefined}
				dimColor={disabled || isLinkedInactive}
				wrap="truncate"
			>
				{label}
			</Text>
			{modeSummary && (
				<Text dimColor wrap="truncate">
					{modeSummary.model} {formatEffort(modeSummary.reasoningEffort)} {displayedEffort}
				</Text>
			)}
			{linked && (
				<Box width="100%" flexGrow={centerLinked ? 1 : undefined} justifyContent="center" alignItems="center">
					<Text bold dimColor>
						🔗 LINKED
					</Text>
				</Box>
			)}
			{showFilterBar && (
				<Text dimColor wrap="truncate">
					filter: {filterValue}
				</Text>
			)}

			{pinnedStatus && (
				<Text
					key={`${fieldName}-status`}
					color={
						isFocused && focusedItemIndex === 0 ? "cyan" : pinnedStatus === selectedValue ? "green" : undefined
					}
					bold={isFocused && focusedItemIndex === 0}
					wrap="truncate"
				>
					{isFocused && focusedItemIndex === 0 ? ">" : " "} {pinnedStatus === selectedValue ? "●" : "○"}{" "}
					{pinnedStatus}
				</Text>
			)}
			{visibleItems.map((item, index) => {
				const absoluteIndexInScrollable = start + index;
				const absoluteIndex = pinnedStatus ? absoluteIndexInScrollable + 1 : absoluteIndexInScrollable;
				const isFocusedItem = isFocused && absoluteIndex === focusedItemIndex;
				const isSelected = selectedSet.has(item);
				const isMissing = staleSet.has(item);
				const isDisabledItem = disabled || disabledSet.has(item);
				const isDimmed = isDisabledItem || isLinkedInactive;
				const mark = isCheckbox ? (isSelected ? "☑" : "☐") : isSelected ? "●" : "○";
				return (
					<Text
						key={`${fieldName}-${item}-${absoluteIndex}`}
						color={!isDisabledItem && isFocusedItem ? "cyan" : !isDimmed && isSelected ? "green" : undefined}
						dimColor={isDimmed}
						bold={!isDisabledItem && isFocusedItem}
						wrap="truncate"
					>
						{isFocusedItem ? ">" : " "} {mark} {item}
						{isMissing ? " (missing)" : isDisabledItem ? " (disabled)" : ""}
					</Text>
				);
			})}
		</Box>
	);
}
