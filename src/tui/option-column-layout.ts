import { MODEL_OPTION_DEGRADED_STATUS, MODEL_OPTION_LOADING_ITEM } from "./state/option-columns.js";
import { OPTION_COLUMN_WIDTH } from "./state/types.js";

export const OPTION_COLUMN_HORIZONTAL_CHROME = 4; // border left/right + paddingX left/right

const FIELD_LABELS: Record<string, string> = {
	tools: "tools",
	extensions: "extensions",
	can_spawn: "can_spawn",
	skills: "skills",
	prompt_parts: "prompt_parts",
	reasoning_effort: "reasoning",
	depth: "depth",
	model: "fast",
	smart_model: "smart",
};

interface OptionColumnWidthArgs {
	fieldName: string;
	items: string[];
	selectedValues?: string[];
	selectedValue?: string;
	isFocused?: boolean;
	isCheckbox?: boolean;
	staleItems?: string[];
	filterText?: string;
}

export function getOptionColumnLabel(fieldName: string): string {
	return FIELD_LABELS[fieldName] ?? fieldName;
}

function isModelStatusValue(item: string | undefined): item is string {
	return item === MODEL_OPTION_LOADING_ITEM || item === MODEL_OPTION_DEGRADED_STATUS;
}

function displayWidth(text: string): number {
	return Array.from(text).length;
}

function formatItemText(item: string, isCheckbox: boolean, selectedSet: Set<string>, staleSet: Set<string>): string {
	const mark = isCheckbox ? (selectedSet.has(item) ? "☑" : "☐") : selectedSet.has(item) ? "●" : "○";
	return `> ${mark} ${item}${staleSet.has(item) ? " (missing)" : ""}`;
}

/**
 * Compute the full Ink Box width needed for an option column without truncating
 * any currently renderable text. The returned width includes borders and
 * horizontal padding.
 */
export function getOptionColumnWidth({
	fieldName,
	items,
	selectedValues,
	selectedValue: selectedValueProp,
	isFocused = false,
	isCheckbox = false,
	staleItems = [],
	filterText,
}: OptionColumnWidthArgs): number {
	const effectiveSelectedValues = selectedValues ?? (selectedValueProp !== undefined ? [selectedValueProp] : []);
	const selectedSet = new Set(effectiveSelectedValues);
	const staleSet = new Set(staleItems);
	const lines = [getOptionColumnLabel(fieldName)];
	const filterValue = filterText?.trim() ?? "";

	if (isFocused && filterValue.length > 0) {
		lines.push(`filter: ${filterValue}`);
	}

	for (const item of items) {
		lines.push(formatItemText(item, isCheckbox, selectedSet, staleSet));
	}

	const contentWidth = Math.max(...lines.map(displayWidth));
	// The combined model column shows two mode summaries with effort circles.
	const minimumContentWidth = OPTION_COLUMN_WIDTH - OPTION_COLUMN_HORIZONTAL_CHROME;
	return Math.max(
		OPTION_COLUMN_WIDTH,
		minimumContentWidth + OPTION_COLUMN_HORIZONTAL_CHROME,
		contentWidth + OPTION_COLUMN_HORIZONTAL_CHROME,
	);
}

export function getModelPinnedStatus(items: string[]): string | undefined {
	return isModelStatusValue(items[0]) ? items[0] : undefined;
}
