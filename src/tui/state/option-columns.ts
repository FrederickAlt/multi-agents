import type {
	AgentConfigState,
	DiscoveredOptions,
	FieldName,
	OptionColumnFieldName,
} from "./types.js";
import { FIELDS_ORDER, OPTION_COLUMN_FIELDS } from "./types.js";
import { resolveModelDisplayName } from "../discovery/options.js";

export const MODEL_OPTION_LOADING_ITEM = "(loading models...)";
export const MODEL_OPTION_DEGRADED_STATUS = "(model discovery unavailable)";

function clampIndex(index: number, length: number): number {
	if (length === 0) return 0;
	return ((index % length) + length) % length;
}

function addUnique(values: string[], value: string): void {
	if (!values.includes(value)) {
		values.push(value);
	}
}

export function getFieldName(fieldIndex: number): FieldName {
	return FIELDS_ORDER[clampIndex(fieldIndex, FIELDS_ORDER.length)];
}

export function isOptionColumnField(
	fieldName: string,
): fieldName is OptionColumnFieldName {
	return OPTION_COLUMN_FIELDS.includes(fieldName as OptionColumnFieldName);
}

export function isCheckboxOptionColumnField(
	fieldName: string,
): fieldName is OptionColumnFieldName {
	return (
		fieldName === "tools"
		|| fieldName === "extensions"
		|| fieldName === "can_spawn"
		|| fieldName === "skills"
		|| fieldName === "prompt_parts"
	);
}

export function getInlineOptionColumnFieldFromFieldIndex(fieldIndex: number): OptionColumnFieldName {
	return OPTION_COLUMN_FIELDS[clampIndex(fieldIndex, OPTION_COLUMN_FIELDS.length)];
}

export function getInlineOptionColumnFieldIndex(fieldName: string): number {
	return OPTION_COLUMN_FIELDS.indexOf(fieldName as OptionColumnFieldName);
}

export function getOptionColumnAvailableItems(
	options: DiscoveredOptions,
	fieldName: OptionColumnFieldName,
	agentName?: string,
): string[] {
	switch (fieldName) {
		case "tools":
			return options.tools;
		case "extensions":
			return options.extensions;
		case "model":
			if (options.modelDiscovery.status === "loading") {
				return [MODEL_OPTION_LOADING_ITEM];
			}
			if (options.modelDiscovery.status === "degraded" && options.models.length === 0) {
				return [MODEL_OPTION_DEGRADED_STATUS];
			}
			return options.models.map((m) => m.displayName);
		case "reasoning_effort":
			return options.reasoningEfforts;
		case "depth":
			return options.depths.map(String);
		case "can_spawn":
			return agentName === undefined
				? options.canSpawn
				: options.canSpawn.filter((name) => name !== agentName);
		case "skills":
			return options.skills;
		case "prompt_parts":
			return options.promptParts;
	}
	return [];
}

export function getOptionColumnDefaultValue(
	options: DiscoveredOptions,
	fieldName: OptionColumnFieldName,
): string {
	switch (fieldName) {
		case "reasoning_effort":
			return "medium";
		case "depth":
			return "0";
		case "model": {
			if (options.defaultModel) {
				return options.defaultModel;
			}
			if (options.modelDiscovery.status === "loading") {
				return MODEL_OPTION_LOADING_ITEM;
			}
			if (options.modelDiscovery.status === "degraded" && options.models.length === 0) {
				return MODEL_OPTION_DEGRADED_STATUS;
			}
			return "(none)";
		}
	}
	return "";
}

export function getOptionColumnCurrentValue(
	agent: AgentConfigState,
	options: DiscoveredOptions,
	fieldName: OptionColumnFieldName,
): string | undefined {
	const raw = agent.frontmatter?.[fieldName];
	if (raw === undefined || raw === null || Array.isArray(raw)) return undefined;
	const value = String(raw);
	if (fieldName === "model") {
		return resolveModelDisplayName(value, options.models) ?? value;
	}
	return value;
}

export function getOptionColumnSelectedValues(
	agent: AgentConfigState,
	options: DiscoveredOptions,
	fieldName: OptionColumnFieldName,
	agentName?: string,
): string[] {
	if (isCheckboxOptionColumnField(fieldName)) {
		const raw = agent.frontmatter?.[fieldName];
		let selectedValues: string[];
		if (raw === undefined || raw === null) {
			selectedValues = getOptionColumnAvailableItems(options, fieldName, agentName);
		} else if (Array.isArray(raw)) {
			selectedValues = raw.map((v) => String(v));
		} else {
			selectedValues = [String(raw)];
		}

		if (fieldName === "can_spawn" && agentName !== undefined) {
			return selectedValues.filter((value) => value !== agentName);
		}
		return selectedValues;
	}

	const currentValue = getOptionColumnCurrentValue(agent, options, fieldName);
	if (currentValue === undefined) {
		return [getOptionColumnDefaultValue(options, fieldName)];
	}
	return [currentValue];
}

export function getOptionColumnSelectedValue(
	agent: AgentConfigState,
	options: DiscoveredOptions,
	fieldName: OptionColumnFieldName,
	agentName?: string,
): string {
	const selectedValues = getOptionColumnSelectedValues(agent, options, fieldName, agentName);
	return selectedValues[0] ?? "";
}

export function getOptionColumnItems(
	agent: AgentConfigState,
	options: DiscoveredOptions,
	fieldName: OptionColumnFieldName,
	agentName?: string,
): string[] {
	const availableItems = getOptionColumnAvailableItems(
		options,
		fieldName,
		agentName,
	);
	const selectedValues = getOptionColumnSelectedValues(
		agent,
		options,
		fieldName,
		agentName,
	);
	const selectedValue = selectedValues[0];

	if (isCheckboxOptionColumnField(fieldName)) {
		const items: string[] = [];
		for (const item of selectedValues) {
			addUnique(items, item);
		}
		for (const item of availableItems) {
			addUnique(items, item);
		}
		return items;
	}

	if (fieldName === "model") {
		if (options.modelDiscovery.status === "loading") {
			if (selectedValue === undefined || availableItems.includes(selectedValue)) {
				return availableItems;
			}
			return [...availableItems, selectedValue];
		}
		if (options.modelDiscovery.status === "degraded") {
			if (selectedValue === undefined || availableItems.includes(selectedValue)) {
				return availableItems;
			}
			return [
				availableItems[0],
				selectedValue,
				...availableItems.slice(1),
			];
		}
	}

	if (selectedValue !== undefined && !availableItems.includes(selectedValue)) {
		return [selectedValue, ...availableItems];
	}
	return availableItems;
}

export function getOptionColumnItemIndex(
	agent: AgentConfigState,
	options: DiscoveredOptions,
	fieldName: OptionColumnFieldName,
	itemValue?: string,
	agentName?: string,
): number {
	const items = getOptionColumnItems(agent, options, fieldName, agentName);
	if (items.length === 0) {
		return 0;
	}
	const fallbackValues = getOptionColumnSelectedValues(
		agent,
		options,
		fieldName,
		agentName,
	);
	const fallback = itemValue ?? fallbackValues[0] ?? items[0];
	const index = items.indexOf(fallback);
	return index >= 0 ? index : 0;
}

export function getFocusedOptionColumnField(fieldIndex: number): OptionColumnFieldName {
	const fieldName = getFieldName(fieldIndex);
	return isOptionColumnField(fieldName)
		? fieldName
		: OPTION_COLUMN_FIELDS[0];
}

export function getOptionColumnSaveValue(
	fieldName: OptionColumnFieldName,
	item: string,
): string | number {
	if (fieldName === "depth") {
		const parsed = Number(item);
		return Number.isNaN(parsed) ? item : parsed;
	}
	return item;
}
