import { Box, Text } from "ink";
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
	mode?: "fast" | "smart";
	modeSelection?: {
		fast: { model: string; reasoningEffort: string };
		smart: { model: string; reasoningEffort: string };
	};
	isSmartLinked?: boolean;
	isModeFocused?: boolean;
}

const DEFAULT_MAX_VISIBLE_ITEMS = 5;

function clamp(index: number, len: number): number {
	if (len <= 0) return 0;
	return Math.max(0, Math.min(index, len));
}

function formatEffort(effort: string): string {
	const levels = ["low", "medium", "high", "maximum"];
	const index = Math.max(0, levels.indexOf(effort));
	return levels.map((_level, itemIndex) => (itemIndex === index ? "●" : "○")).join("");
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
	mode = "fast",
	modeSelection,
	isSmartLinked = false,
	isModeFocused = false,
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
		});
	const pinnedStatus = fieldName === "model" ? getModelPinnedStatus(items) : undefined;
	const reservedLines = (showFilterBar ? 1 : 0) + (pinnedStatus ? 1 : 0);
	const scrollableItems = pinnedStatus ? items.slice(1) : items;
	const visibleItemWindow = Math.max(0, visibleItemCount - reservedLines);
	const focusedInScrollable =
		pinnedStatus && focusedItemIndex > 0 ? focusedItemIndex - 1 : Math.max(0, focusedItemIndex);
	const { start, end } = getVisibleRange(scrollableItems.length, focusedInScrollable, visibleItemWindow);
	const visibleItems = scrollableItems.slice(start, end);

	return (
		<Box
			flexDirection="column"
			width={columnWidth}
			flexShrink={0}
			borderStyle={isFocused ? "bold" : "single"}
			borderColor={disabled ? "gray" : isFocused ? "cyan" : "gray"}
			paddingX={1}
		>
			<Text bold color={!disabled && isFocused ? "cyan" : undefined} dimColor={disabled} wrap="truncate">
				{label}
			</Text>
			{fieldName === "model" && modeSelection && (
				<>
					<Text
						color={isModeFocused && mode === "fast" ? "cyan" : undefined}
						bold={isModeFocused && mode === "fast"}
						wrap="truncate"
					>
						{isModeFocused && mode === "fast" ? ">" : " "} fast {modeSelection.fast.model}{" "}
						{formatEffort(modeSelection.fast.reasoningEffort)}
					</Text>
					<Text
						dimColor={isSmartLinked && !(isModeFocused && mode === "smart")}
						color={isModeFocused && mode === "smart" ? "cyan" : undefined}
						bold={isModeFocused && mode === "smart"}
						wrap="truncate"
					>
						{isModeFocused && mode === "smart" ? ">" : " "} {isSmartLinked ? "↳" : " "} smart{" "}
						{isSmartLinked ? "linked" : "      "} {modeSelection.smart.model}{" "}
						{formatEffort(modeSelection.smart.reasoningEffort)}
					</Text>
				</>
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
				const mark = isCheckbox ? (isSelected ? "☑" : "☐") : isSelected ? "●" : "○";
				return (
					<Text
						key={`${fieldName}-${item}-${absoluteIndex}`}
						color={
							!isDisabledItem && isFocusedItem ? "cyan" : !isDisabledItem && isSelected ? "green" : undefined
						}
						dimColor={isDisabledItem}
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
