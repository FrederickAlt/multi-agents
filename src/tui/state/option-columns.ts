import { isProtectedMultiAgentExtensionName } from "../../../subagent/protected-extension.js";
import { resolveModelDisplayName } from "../discovery/options.js";
import type {
	AgentConfigState,
	DiscoveredOptions,
	FieldName,
	OptionColumnFieldName,
	OptionColumnItemOrder,
} from "./types.js";
import { FIELDS_ORDER, OPTION_COLUMN_FIELDS } from "./types.js";

export const MODEL_OPTION_LOADING_ITEM = "(loading models...)";
export const MODEL_OPTION_DEGRADED_STATUS = "(model discovery unavailable)";

function normalizeFilter(text: string): string {
	return text.trim().toLowerCase();
}

function isModelStatusValue(item: string): boolean {
	return item === MODEL_OPTION_LOADING_ITEM || item === MODEL_OPTION_DEGRADED_STATUS;
}

function filterItems(items: string[], filter: string): string[] {
	const normalizedFilter = normalizeFilter(filter);
	if (!normalizedFilter) {
		return [...items];
	}
	return items.filter((item) => item.toLowerCase().includes(normalizedFilter));
}

function clampIndex(index: number, length: number): number {
	if (length === 0) return 0;
	return ((index % length) + length) % length;
}

function addUnique(values: string[], value: string): void {
	if (!values.includes(value)) {
		values.push(value);
	}
}

export function getAgentDepth(agent: AgentConfigState | undefined): number {
	const raw = agent?.frontmatter?.depth;
	if (raw === undefined || raw === null || raw === "") return 0;
	if (typeof raw === "number") {
		return Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
	}
	const trimmed = String(raw).trim();
	if (!/^-?\d+$/.test(trimmed)) return 0;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function isOptionColumnDisabledForAgent(
	agent: AgentConfigState | undefined,
	fieldName: OptionColumnFieldName,
): boolean {
	return fieldName === "can_spawn" && getAgentDepth(agent) <= 0;
}

function selectedExtensionsForAgent(agent: AgentConfigState | undefined): string[] | undefined {
	const raw = agent?.frontmatter?.extensions;
	if (raw === undefined || raw === null) return undefined;
	if (Array.isArray(raw)) return raw.map(String);
	return [String(raw)];
}

function protectedAvailableExtensions(options: DiscoveredOptions): string[] {
	return options.extensions.filter((name) => isProtectedMultiAgentExtensionName(name));
}

function effectiveSelectedExtensionsForAgent(
	options: DiscoveredOptions,
	agent: AgentConfigState | undefined,
): string[] | undefined {
	const selected = selectedExtensionsForAgent(agent);
	if (selected === undefined) return undefined;
	const result = [...selected];
	for (const extensionName of protectedAvailableExtensions(options)) {
		addUnique(result, extensionName);
	}
	return result;
}

function extensionToolIsEnabled(
	options: DiscoveredOptions,
	agent: AgentConfigState | undefined,
	toolName: string,
): boolean {
	const sourceNames = options.toolExtensionNames?.[toolName];
	if (!sourceNames || sourceNames.length === 0) return true;
	const selectedExtensions = effectiveSelectedExtensionsForAgent(options, agent);
	if (selectedExtensions === undefined) return true;
	if (selectedExtensions.length === 0) return false;
	return selectedExtensions.some((selected) =>
		sourceNames.some(
			(candidate) => candidate === selected || candidate.includes(selected) || selected.includes(candidate),
		),
	);
}

export function getOptionColumnDisabledItems(
	agent: AgentConfigState | undefined,
	options: DiscoveredOptions,
	fieldName: OptionColumnFieldName,
): string[] {
	if (fieldName === "tools" && getAgentDepth(agent) <= 0) {
		return ["Task"];
	}
	if (fieldName === "extensions") {
		return options.extensions.filter((extension) => isProtectedMultiAgentExtensionName(extension));
	}
	return [];
}

export function isOptionColumnItemDisabled(
	agent: AgentConfigState | undefined,
	options: DiscoveredOptions,
	fieldName: OptionColumnFieldName,
	item: string,
): boolean {
	if (isOptionColumnDisabledForAgent(agent, fieldName)) return true;
	return getOptionColumnDisabledItems(agent, options, fieldName).includes(item);
}

export function getToolsAvailableForAgent(options: DiscoveredOptions, agent: AgentConfigState | undefined): string[] {
	return options.tools.filter((tool) => extensionToolIsEnabled(options, agent, tool));
}

export function getFieldName(fieldIndex: number): FieldName {
	return FIELDS_ORDER[clampIndex(fieldIndex, FIELDS_ORDER.length)];
}

export function isOptionColumnField(fieldName: string): fieldName is OptionColumnFieldName {
	return OPTION_COLUMN_FIELDS.includes(fieldName as OptionColumnFieldName);
}

export function isCheckboxOptionColumnField(fieldName: string): fieldName is OptionColumnFieldName {
	return (
		fieldName === "tools" ||
		fieldName === "extensions" ||
		fieldName === "can_spawn" ||
		fieldName === "skills" ||
		fieldName === "prompt_parts"
	);
}

export function getInlineOptionColumnFieldIndex(fieldName: string): number {
	return OPTION_COLUMN_FIELDS.indexOf(fieldName as OptionColumnFieldName);
}

export function getOptionColumnAvailableItems(
	options: DiscoveredOptions,
	fieldName: OptionColumnFieldName,
	_agentName?: string,
	agent?: AgentConfigState,
): string[] {
	switch (fieldName) {
		case "tools":
			return getToolsAvailableForAgent(options, agent);
		case "extensions":
			return options.extensions;
		case "model": {
			const modelItems = options.models.map((m) => m.displayName);
			if (options.modelDiscovery.status === "loading") {
				return [MODEL_OPTION_LOADING_ITEM];
			}
			if (options.modelDiscovery.status === "degraded") {
				return [MODEL_OPTION_DEGRADED_STATUS, ...modelItems];
			}
			return modelItems;
		}
		case "reasoning_effort":
			return options.reasoningEfforts;
		case "depth":
			return options.depths.map(String);
		case "can_spawn":
			return options.canSpawn;
		case "skills":
			return options.skills;
		case "prompt_parts":
			return options.promptParts;
	}
	return [];
}

export function getOptionColumnDefaultValue(options: DiscoveredOptions, fieldName: OptionColumnFieldName): string {
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
			if (options.modelDiscovery.status === "degraded") {
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
			selectedValues = getOptionColumnAvailableItems(options, fieldName, agentName, agent);
		} else if (Array.isArray(raw)) {
			selectedValues = raw.map((v) => String(v));
		} else {
			selectedValues = [String(raw)];
		}

		if (fieldName === "tools") {
			return selectedValues.filter((value) => extensionToolIsEnabled(options, agent, value));
		}
		if (fieldName === "extensions") {
			for (const extensionName of protectedAvailableExtensions(options)) {
				addUnique(selectedValues, extensionName);
			}
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
	columnFilter = "",
): string[] {
	const availableItems = getOptionColumnAvailableItems(options, fieldName, agentName, agent);
	const selectedValues = getOptionColumnSelectedValues(agent, options, fieldName, agentName);
	const selectedValue = selectedValues[0];

	const unfilteredItems = (() => {
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
				return [availableItems[0], selectedValue, ...availableItems.slice(1)];
			}
		}

		if (selectedValue !== undefined && !availableItems.includes(selectedValue)) {
			return [selectedValue, ...availableItems];
		}
		return availableItems;
	})();

	if (fieldName === "model") {
		const [firstItem, ...rest] = unfilteredItems;
		if (!isModelStatusValue(firstItem)) {
			return filterItems(unfilteredItems, columnFilter);
		}
		return [firstItem, ...filterItems(rest, columnFilter)];
	}

	return filterItems(unfilteredItems, columnFilter);
}

export function applyOptionColumnItemOrder(
	items: string[],
	order: OptionColumnItemOrder | null | undefined,
	agentIndex: number,
	fieldName: OptionColumnFieldName,
	columnFilter = "",
): string[] {
	if (!order || order.agentIndex !== agentIndex || order.fieldName !== fieldName || order.filter !== columnFilter) {
		return items;
	}

	const itemSet = new Set(items);
	const orderedItems: string[] = [];
	for (const item of order.items) {
		if (itemSet.has(item)) {
			addUnique(orderedItems, item);
		}
	}
	for (const item of items) {
		addUnique(orderedItems, item);
	}
	return orderedItems;
}

export function getOptionColumnItemIndex(
	agent: AgentConfigState,
	options: DiscoveredOptions,
	fieldName: OptionColumnFieldName,
	itemValue?: string,
	agentName?: string,
	columnFilter = "",
): number {
	const items = getOptionColumnItems(agent, options, fieldName, agentName, columnFilter);
	if (items.length === 0) {
		return 0;
	}
	const fallbackValues = getOptionColumnSelectedValues(agent, options, fieldName, agentName);
	const fallback = itemValue ?? fallbackValues[0] ?? items[0];
	const index = items.indexOf(fallback);
	return index >= 0 ? index : 0;
}

export function getOptionColumnSaveValue(fieldName: OptionColumnFieldName, item: string): string | number {
	if (fieldName === "depth") {
		const parsed = Number(item);
		return Number.isNaN(parsed) ? item : parsed;
	}
	return item;
}
