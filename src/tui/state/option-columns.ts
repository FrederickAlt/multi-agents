import type { AgentConfigState, DiscoveredOptions, OptionColumnFieldName } from "./types.js";
import { OPTION_COLUMN_FIELDS } from "./types.js";

export function getOptionColumnAvailableItems(
	options: DiscoveredOptions,
	fieldName: OptionColumnFieldName,
): string[] {
	switch (fieldName) {
		case "reasoning_effort":
			return options.reasoningEfforts;
		case "depth":
			return options.depths.map(String);
	}
}

export function getOptionColumnDefaultValue(
	fieldName: OptionColumnFieldName,
): string {
	switch (fieldName) {
		case "reasoning_effort":
			return "medium";
		case "depth":
			return "0";
	}
}

export function getOptionColumnCurrentValue(
	agent: AgentConfigState,
	fieldName: OptionColumnFieldName,
): string | undefined {
	const raw = agent.frontmatter?.[fieldName];
	if (raw === undefined || raw === null || Array.isArray(raw)) return undefined;
	return String(raw);
}

export function getOptionColumnSelectedValue(
	agent: AgentConfigState,
	fieldName: OptionColumnFieldName,
): string {
	return getOptionColumnCurrentValue(agent, fieldName)
		?? getOptionColumnDefaultValue(fieldName);
}

export function getOptionColumnItems(
	agent: AgentConfigState,
	options: DiscoveredOptions,
	fieldName: OptionColumnFieldName,
): string[] {
	const availableItems = getOptionColumnAvailableItems(options, fieldName);
	const currentValue = getOptionColumnCurrentValue(agent, fieldName);
	if (currentValue !== undefined && !availableItems.includes(currentValue)) {
		return [currentValue, ...availableItems];
	}
	return availableItems;
}

export function getOptionColumnItemIndex(
	agent: AgentConfigState,
	options: DiscoveredOptions,
	fieldName: OptionColumnFieldName,
	itemValue = getOptionColumnSelectedValue(agent, fieldName),
): number {
	const items = getOptionColumnItems(agent, options, fieldName);
	const index = items.indexOf(itemValue);
	return index >= 0 ? index : 0;
}

export function getFocusedOptionColumnField(fieldIndex: number): OptionColumnFieldName {
	return OPTION_COLUMN_FIELDS[((fieldIndex % OPTION_COLUMN_FIELDS.length) + OPTION_COLUMN_FIELDS.length) % OPTION_COLUMN_FIELDS.length];
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
