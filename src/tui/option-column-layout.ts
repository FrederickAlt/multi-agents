import { normalizeReasoningEffort, PI_REASONING_EFFORTS } from "../subagent/reasoning-effort.js";
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
	model: "fast-mode",
	smart_model: "smart-mode",
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
	modeSummary?: { model: string; reasoningEffort: string };
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

function formatEffort(effort: string): string {
	const normalized = normalizeReasoningEffort(effort);
	const index = Math.max(0, normalized === undefined ? -1 : PI_REASONING_EFFORTS.indexOf(normalized));
	return PI_REASONING_EFFORTS.map((_level, itemIndex) => (itemIndex === index ? "●" : "○")).join("");
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
	modeSummary,
}: OptionColumnWidthArgs): number {
	const effectiveSelectedValues = selectedValues ?? (selectedValueProp !== undefined ? [selectedValueProp] : []);
	const selectedSet = new Set(effectiveSelectedValues);
	const staleSet = new Set(staleItems);
	const lines = [getOptionColumnLabel(fieldName)];
	const filterValue = filterText?.trim() ?? "";

	if (isFocused && filterValue.length > 0) {
		lines.push(`filter: ${filterValue}`);
	}
	if (modeSummary) {
		const displayedEffort = normalizeReasoningEffort(modeSummary.reasoningEffort) ?? modeSummary.reasoningEffort;
		lines.push(`${modeSummary.model} ${formatEffort(displayedEffort)} ${displayedEffort}`);
	}

	for (const item of items) {
		lines.push(formatItemText(item, isCheckbox, selectedSet, staleSet));
	}

	const contentWidth = Math.max(...lines.map(displayWidth));
	// Model columns include the model name, effort dots, and exact effort label.
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
