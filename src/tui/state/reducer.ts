import { resolveModelDisplayName } from "../discovery/options.js";
import { clampHorizontalScrollOffset, clampVerticalScrollOffset } from "../layout.js";
import { getOptionColumnWidth } from "../option-column-layout.js";
import {
	applyOptionColumnItemOrder,
	getFieldName,
	getInlineOptionColumnFieldIndex,
	getOptionColumnItemIndex,
	getOptionColumnItems,
	getOptionColumnSelectedValues,
	getToolsAvailableForAgent,
	isCheckboxOptionColumnField,
	isOptionColumnDisabledForAgent,
	isOptionColumnField,
	isOptionColumnItemDisabled,
	MODEL_OPTION_DEGRADED_STATUS,
	MODEL_OPTION_LOADING_ITEM,
} from "./option-columns.js";
import type {
	AgentConfigState,
	ConfigAction,
	ConfigState,
	DiscoveredOptions,
	OptionColumnItemOrder,
	OverlayState,
} from "./types.js";
import { FIELDS_ORDER, OPTION_COLUMN_FIELDS } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve tri-state checkbox value into local overlay selection. */
export function resolveCheckboxSelection(
	frontmatterValue: string[] | undefined,
	availableItems: string[],
): { localSelection: string[]; wasImplicit: boolean } {
	if (frontmatterValue === undefined) {
		// Missing → all items active
		return { localSelection: [...availableItems], wasImplicit: true };
	}
	return { localSelection: [...frontmatterValue], wasImplicit: false };
}

/**
 * Pure helper: compute new checkbox selection after a toggle.
 * Returns the new localSelection and whether the field is now explicit.
 */
export function applyToggle(
	localSelection: string[],
	wasImplicit: boolean,
	availableItems: string[],
	item: string,
): { localSelection: string[]; wasImplicit: boolean } {
	if (wasImplicit) {
		// First toggle from implicit: start with all items, remove the toggled one
		return {
			localSelection: [...availableItems].filter((i) => i !== item),
			wasImplicit: false,
		};
	}
	const idx = localSelection.indexOf(item);
	if (idx >= 0) {
		return {
			localSelection: [...localSelection.slice(0, idx), ...localSelection.slice(idx + 1)],
			wasImplicit: false,
		};
	}
	return {
		localSelection: [...localSelection, item],
		wasImplicit: false,
	};
}

/**
 * Compute the save value for a checkbox field after toggling.
 *
 * Tri-state semantics:
 * - All items selected → return undefined (remove field, revert to implicit)
 * - Subset selected → return the explicit list
 * - No items selected → return [] (explicit empty list)
 */
export function computeCheckboxSaveValue(localSelection: string[], availableItems: string[]): string[] | undefined {
	const selectedSet = new Set(localSelection.map(String));
	const availableSet = new Set(availableItems.map(String));
	if (selectedSet.size === availableSet.size && [...selectedSet].every((item) => availableSet.has(item))) {
		return undefined;
	}
	return [...localSelection];
}

const INITIAL_EXPANDED_FIELD_INDEX = FIELDS_ORDER.indexOf("reasoning_effort");

/** Build initial empty state. */
export function createInitialState(): ConfigState {
	return {
		agents: [],
		options: {
			tools: [],
			toolExtensionNames: {},
			extensions: [],
			models: [],
			defaultModel: "",
			modelDiscovery: {
				status: "ready",
				error: null,
			},
			reasoningEfforts: ["low", "medium", "high", "maximum"],
			depths: [0, 1, 2, 3, 4, 5],
			canSpawn: [],
			skills: [],
			promptParts: [],
		},
		focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 0 },
		expandedAgentIndex: null,
		overlay: null,
		statuses: new Map(),
		scrollOffset: 0,
		optionColumnScrollOffset: 0,
		optionColumnItemOrder: null,
		optionColumnFilter: "",
		globalError: null,
	};
}

/** Clamp index to range [0, len) */
function clamp(index: number, len: number): number {
	if (len === 0) return 0;
	return ((index % len) + len) % len;
}

function getInlineFocusFieldIndex(fieldIndex: number): number | null {
	const focusedFieldName = getFieldName(fieldIndex);
	if (!isOptionColumnField(focusedFieldName)) {
		return null;
	}
	return getInlineOptionColumnFieldIndex(focusedFieldName);
}

function clampToFieldRange(index: number): number {
	return Math.max(0, Math.min(index, FIELDS_ORDER.length - 1));
}

function getInlineFieldMovementTarget(
	fieldIndex: number,
	direction: "next" | "prev",
	agent?: AgentConfigState,
): number {
	const currentFieldIndex = clampToFieldRange(fieldIndex);
	const focusedFieldName = getFieldName(currentFieldIndex);
	if (!isOptionColumnField(focusedFieldName)) {
		return clampToFieldRange(currentFieldIndex + (direction === "next" ? 1 : -1));
	}

	const inlineIndex = getInlineOptionColumnFieldIndex(focusedFieldName);
	if (inlineIndex === -1) {
		return clampToFieldRange(currentFieldIndex + (direction === "next" ? 1 : -1));
	}

	const delta = direction === "next" ? 1 : -1;
	for (
		let nextInlineIndex = inlineIndex + delta;
		nextInlineIndex >= 0 && nextInlineIndex < OPTION_COLUMN_FIELDS.length;
		nextInlineIndex += delta
	) {
		const nextField = OPTION_COLUMN_FIELDS[nextInlineIndex];
		if (!isOptionColumnDisabledForAgent(agent, nextField)) {
			return FIELDS_ORDER.indexOf(nextField);
		}
	}

	return currentFieldIndex;
}

function getFocusedOptionItemIndex(
	agent: AgentConfigState | undefined,
	options: DiscoveredOptions,
	fieldIndex: number,
	focusedItemValue?: string,
	columnFilter = "",
): number {
	if (!agent) return 0;
	const fieldName = getFieldName(fieldIndex);
	if (!isOptionColumnField(fieldName)) return 0;
	const items = getOptionColumnItems(agent, options, fieldName, agent.name, columnFilter);
	const index = getOptionColumnItemIndex(agent, options, fieldName, focusedItemValue, agent.name, columnFilter);
	return getNearestEnabledOptionItemIndex(agent, options, fieldName, items, index);
}

function getNearestEnabledOptionItemIndex(
	agent: AgentConfigState,
	options: DiscoveredOptions,
	fieldName: ReturnType<typeof getFieldName>,
	items: string[],
	preferredIndex: number,
): number {
	if (!isOptionColumnField(fieldName) || items.length === 0) return 0;
	const start = Math.max(0, Math.min(preferredIndex, items.length - 1));
	if (!isOptionColumnItemDisabled(agent, options, fieldName, items[start])) return start;
	for (let i = start + 1; i < items.length; i += 1) {
		if (!isOptionColumnItemDisabled(agent, options, fieldName, items[i])) return i;
	}
	for (let i = start - 1; i >= 0; i -= 1) {
		if (!isOptionColumnItemDisabled(agent, options, fieldName, items[i])) return i;
	}
	return start;
}

function getNextEnabledOptionItemIndex(
	agent: AgentConfigState,
	options: DiscoveredOptions,
	fieldName: ReturnType<typeof getFieldName>,
	items: string[],
	currentIndex: number,
	direction: "next" | "prev",
): number {
	if (!isOptionColumnField(fieldName) || items.length === 0) return 0;
	const delta = direction === "next" ? 1 : -1;
	for (let step = 1; step <= items.length; step += 1) {
		const index = clamp(currentIndex + delta * step, items.length);
		if (!isOptionColumnItemDisabled(agent, options, fieldName, items[index])) {
			return index;
		}
	}
	return Math.max(0, Math.min(currentIndex, items.length - 1));
}
function getEffectiveOptionColumnItems(
	state: ConfigState,
	agent: AgentConfigState,
	fieldName: ReturnType<typeof getFieldName>,
): string[] {
	if (!isOptionColumnField(fieldName)) return [];
	const items = getOptionColumnItems(agent, state.options, fieldName, agent.name, state.optionColumnFilter);
	return applyOptionColumnItemOrder(
		items,
		state.optionColumnItemOrder,
		state.focus.agentIndex,
		fieldName,
		state.optionColumnFilter,
	);
}

function getOptionColumnWidthsForAgent(
	agent: AgentConfigState | undefined,
	options: DiscoveredOptions,
	focusedFieldIndex: number,
	optionColumnFilter = "",
	optionColumnItemOrder: OptionColumnItemOrder | null = null,
	agentIndex = 0,
): number[] | undefined {
	if (!agent) return undefined;
	const focusedFieldName = getFieldName(focusedFieldIndex);

	return OPTION_COLUMN_FIELDS.map((fieldName) => {
		const isFocusedField = focusedFieldName === fieldName;
		const isInlineCheckbox = isCheckboxOptionColumnField(fieldName);
		const columnFilter = isFocusedField ? optionColumnFilter : "";
		const items = applyOptionColumnItemOrder(
			getOptionColumnItems(agent, options, fieldName, agent.name, columnFilter),
			optionColumnItemOrder,
			agentIndex,
			fieldName,
			columnFilter,
		);
		return getOptionColumnWidth({
			fieldName,
			items,
			selectedValues: getOptionColumnSelectedValues(agent, options, fieldName, agent.name),
			isFocused: isFocusedField,
			isCheckbox: isInlineCheckbox,
			staleItems: agent.staleItems[fieldName] ?? [],
			filterText: isFocusedField ? optionColumnFilter : undefined,
		});
	});
}

function syncOptionColumnScrollOffset(
	scrollOffset: number,
	fieldIndex: number,
	columnCount: number,
	agent?: AgentConfigState,
	options?: DiscoveredOptions,
	optionColumnFilter = "",
	optionColumnItemOrder: OptionColumnItemOrder | null = null,
	agentIndex = 0,
): number {
	const inlineFieldIndex = getInlineFocusFieldIndex(fieldIndex);
	if (inlineFieldIndex === null) {
		return scrollOffset;
	}
	const columnWidths = options
		? getOptionColumnWidthsForAgent(agent, options, fieldIndex, optionColumnFilter, optionColumnItemOrder, agentIndex)
		: undefined;
	return clampHorizontalScrollOffset(scrollOffset, inlineFieldIndex, columnCount, undefined, columnWidths);
}

/** Extract current value for a field from agent frontmatter */
function getFieldValue(agent: AgentConfigState, fieldName: string): string[] | string | number | undefined {
	const fm = agent.frontmatter ?? {};
	const raw = fm[fieldName];
	if (raw === undefined || raw === null) return undefined;
	if (Array.isArray(raw)) return raw.map(String);
	if (typeof raw === "number") return raw;
	return String(raw);
}

function getStaleCleanupItems(agent: AgentConfigState): Record<string, string[]> {
	const staleItems: Record<string, string[]> = {};
	for (const [fieldName, values] of Object.entries(agent.staleItems)) {
		if (values.length > 0) {
			staleItems[fieldName] = values;
		}
	}
	return staleItems;
}

function hasStaleCleanupItems(staleItems: Record<string, string[]>): boolean {
	return Object.values(staleItems).some((values) => values.length > 0);
}

function expandAgent(state: ConfigState, idx: number, agent: AgentConfigState): ConfigState {
	const fieldIndex = INITIAL_EXPANDED_FIELD_INDEX === -1 ? 0 : INITIAL_EXPANDED_FIELD_INDEX;
	return {
		...state,
		expandedAgentIndex: idx,
		overlay: null,
		optionColumnFilter: "",
		optionColumnItemOrder: null,
		focus: {
			agentIndex: idx,
			fieldIndex,
			optionItemIndex: getFocusedOptionItemIndex(agent, state.options, fieldIndex),
		},
		optionColumnScrollOffset: syncOptionColumnScrollOffset(
			0,
			fieldIndex,
			OPTION_COLUMN_FIELDS.length,
			agent,
			state.options,
			"",
			null,
			idx,
		),
	};
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function configReducer(state: ConfigState, action: ConfigAction): ConfigState {
	switch (action.type) {
		case "INIT_COMPLETE": {
			const fieldCount = FIELDS_ORDER.length;
			const fieldIndex = clamp(state.focus.fieldIndex, fieldCount);
			const focusedAgentIndex = clamp(state.focus.agentIndex, action.agents.length);
			const focusedAgent = action.agents[focusedAgentIndex];
			return {
				...state,
				agents: action.agents,
				options: action.options,
				globalError: null,
				optionColumnFilter: "",
				optionColumnItemOrder: null,
				expandedAgentIndex: null,
				focus: {
					agentIndex: clamp(state.focus.agentIndex, action.agents.length),
					fieldIndex,
					optionItemIndex: getFocusedOptionItemIndex(focusedAgent, action.options, fieldIndex),
				},
				optionColumnScrollOffset: syncOptionColumnScrollOffset(
					state.optionColumnScrollOffset,
					fieldIndex,
					OPTION_COLUMN_FIELDS.length,
					focusedAgent,
					action.options,
					"",
					null,
					focusedAgentIndex,
				),
			};
		}

		case "INIT_ERROR": {
			return { ...state, globalError: action.error };
		}

		case "FOCUS_AGENT": {
			const len = state.agents.length;
			if (len === 0) return state;
			const delta = action.direction === "next" ? 1 : -1;
			const newIdx = clamp(state.focus.agentIndex + delta, len);
			// Collapse expanded row when focus leaves it
			const nextExpanded =
				state.expandedAgentIndex !== null && state.expandedAgentIndex !== newIdx ? null : state.expandedAgentIndex;
			return {
				...state,
				expandedAgentIndex: nextExpanded,
				optionColumnFilter: "",
				optionColumnItemOrder: null,
				focus: { ...state.focus, agentIndex: newIdx },
				scrollOffset: clampVerticalScrollOffset(state.scrollOffset, newIdx, len, nextExpanded),
			};
		}

		case "FOCUS_AGENT_AT": {
			const len = state.agents.length;
			if (len === 0) return state;
			const newIdx = clamp(action.agentIndex, len);
			// Collapse expanded row when focus moves away from the expanded agent
			const nextExpanded =
				state.expandedAgentIndex !== null && state.expandedAgentIndex !== newIdx ? null : state.expandedAgentIndex;
			return {
				...state,
				expandedAgentIndex: nextExpanded,
				optionColumnFilter: "",
				optionColumnItemOrder: null,
				focus: { ...state.focus, agentIndex: newIdx },
				scrollOffset: clampVerticalScrollOffset(state.scrollOffset, newIdx, len, nextExpanded),
			};
		}

		case "FOCUS_FIELD": {
			const agent = state.agents[state.focus.agentIndex];
			const fieldIndex = getInlineFieldMovementTarget(state.focus.fieldIndex, action.direction, agent);
			if (fieldIndex === state.focus.fieldIndex) return state;
			return {
				...state,
				optionColumnFilter: "",
				optionColumnItemOrder: null,
				focus: {
					...state.focus,
					fieldIndex,
					optionItemIndex: getFocusedOptionItemIndex(agent, state.options, fieldIndex),
				},
				optionColumnScrollOffset: syncOptionColumnScrollOffset(
					state.optionColumnScrollOffset,
					fieldIndex,
					OPTION_COLUMN_FIELDS.length,
					agent,
					state.options,
					"",
					null,
					state.focus.agentIndex,
				),
			};
		}

		case "FOCUS_OPTION_ITEM": {
			const agent = state.agents[state.focus.agentIndex];
			if (!agent) return state;
			const fieldName = getFieldName(state.focus.fieldIndex);
			if (!isOptionColumnField(fieldName)) {
				return state;
			}
			const items = getEffectiveOptionColumnItems(state, agent, fieldName);
			if (items.length === 0) return state;
			return {
				...state,
				focus: {
					...state.focus,
					optionItemIndex: getNextEnabledOptionItemIndex(
						agent,
						state.options,
						fieldName,
						items,
						state.focus.optionItemIndex,
						action.direction,
					),
				},
			};
		}

		case "OPEN_OVERLAY": {
			const agent = state.agents[action.agentIndex];
			if (!agent || agent.error) return state;

			const availableItems = getAvailableItems(state.options, action.fieldName, agent.name, agent);
			const currentValue = getFieldValue(agent, action.fieldName);

			let overlay: OverlayState;

			if (isCheckboxField(action.fieldName)) {
				const { localSelection, wasImplicit } = resolveCheckboxSelection(
					Array.isArray(currentValue) ? (currentValue as string[]) : undefined,
					availableItems,
				);
				overlay = {
					type: "checkbox",
					agentIndex: action.agentIndex,
					fieldName: action.fieldName,
					currentValue,
					availableItems,
					staleItems: agent.staleItems[action.fieldName] ?? [],
					localSelection,
					localSelected: "",
					wasImplicit,
				};
			} else {
				const defaultVal = getDefaultValue(action.fieldName, availableItems, state.options.defaultModel);
				let current = defaultVal;
				if (currentValue !== undefined) {
					if (action.fieldName === "model") {
						// Resolve stored value (bare ID / canonical ref / display name) to display name
						const resolved = resolveModelDisplayName(String(currentValue), state.options.models);
						current = resolved ?? String(currentValue);
					} else {
						current = String(currentValue);
					}
				}
				overlay = {
					type: "dropdown",
					agentIndex: action.agentIndex,
					fieldName: action.fieldName,
					currentValue,
					availableItems,
					staleItems: [],
					localSelection: [],
					localSelected: current,
					wasImplicit: currentValue === undefined,
				};
			}

			return { ...state, overlay, optionColumnFilter: "" };
		}

		case "CLOSE_OVERLAY": {
			return { ...state, overlay: null, optionColumnFilter: "" };
		}

		case "SET_OPTION_COLUMN_FILTER": {
			const filteredFieldName = getFieldName(state.focus.fieldIndex);
			if (!isOptionColumnField(filteredFieldName)) {
				return { ...state, optionColumnFilter: action.filter };
			}
			const agent = state.agents[state.focus.agentIndex];
			if (!agent) {
				return { ...state, optionColumnFilter: action.filter };
			}
			const currentItems = getOptionColumnItems(
				agent,
				state.options,
				filteredFieldName,
				agent.name,
				state.optionColumnFilter,
			);
			const focusedItem = currentItems[state.focus.optionItemIndex];
			return {
				...state,
				optionColumnFilter: action.filter,
				optionColumnItemOrder: null,
				focus: {
					...state.focus,
					optionItemIndex: getOptionColumnItemIndex(
						agent,
						state.options,
						filteredFieldName,
						focusedItem,
						agent.name,
						action.filter,
					),
				},
				optionColumnScrollOffset: syncOptionColumnScrollOffset(
					state.optionColumnScrollOffset,
					state.focus.fieldIndex,
					OPTION_COLUMN_FIELDS.length,
					agent,
					state.options,
					action.filter,
					null,
					state.focus.agentIndex,
				),
			};
		}

		case "CLEAR_OPTION_COLUMN_FILTER": {
			const filteredFieldName = getFieldName(state.focus.fieldIndex);
			if (!isOptionColumnField(filteredFieldName)) {
				return { ...state, optionColumnFilter: "" };
			}
			const agent = state.agents[state.focus.agentIndex];
			if (!agent) {
				return { ...state, optionColumnFilter: "" };
			}
			const currentItems = getOptionColumnItems(
				agent,
				state.options,
				filteredFieldName,
				agent.name,
				state.optionColumnFilter,
			);
			const focusedItem = currentItems[state.focus.optionItemIndex];
			return {
				...state,
				optionColumnFilter: "",
				optionColumnItemOrder: null,
				focus: {
					...state.focus,
					optionItemIndex: getOptionColumnItemIndex(
						agent,
						state.options,
						filteredFieldName,
						focusedItem,
						agent.name,
						"",
					),
				},
				optionColumnScrollOffset: syncOptionColumnScrollOffset(
					state.optionColumnScrollOffset,
					state.focus.fieldIndex,
					OPTION_COLUMN_FIELDS.length,
					agent,
					state.options,
					"",
					null,
					state.focus.agentIndex,
				),
			};
		}

		case "TOGGLE_CHECKBOX": {
			if (!state.overlay || state.overlay.type !== "checkbox") return state;
			const { localSelection, wasImplicit } = applyToggle(
				state.overlay.localSelection,
				state.overlay.wasImplicit,
				state.overlay.availableItems,
				action.item,
			);
			return {
				...state,
				overlay: { ...state.overlay, localSelection, wasImplicit },
			};
		}

		case "SELECT_DROPDOWN": {
			if (!state.overlay || state.overlay.type !== "dropdown") return state;
			return {
				...state,
				overlay: { ...state.overlay, localSelected: action.item },
			};
		}

		case "SAVE_COMPLETE": {
			const newStatuses = new Map(state.statuses);
			newStatuses.set(state.agents[action.agentIndex]?.filePath ?? "", action.status);
			return { ...state, statuses: newStatuses };
		}

		case "UPDATE_AGENT_FRONTMATTER": {
			const previousAgent = state.agents[action.agentIndex];
			const agents = [...state.agents];
			const agent = { ...agents[action.agentIndex] };
			agent.frontmatter = action.frontmatter;
			agent.staleItems = action.staleItems;
			agents[action.agentIndex] = agent;

			if (state.expandedAgentIndex === action.agentIndex && state.focus.agentIndex === action.agentIndex) {
				const fieldName = getFieldName(state.focus.fieldIndex);
				const previousItems =
					previousAgent && isOptionColumnField(fieldName)
						? applyOptionColumnItemOrder(
								getOptionColumnItems(
									previousAgent,
									state.options,
									fieldName,
									previousAgent.name,
									state.optionColumnFilter,
								),
								state.optionColumnItemOrder,
								action.agentIndex,
								fieldName,
								state.optionColumnFilter,
							)
						: [];
				const focusedItem = previousItems[state.focus.optionItemIndex];
				const shouldPreserveOrder = isOptionColumnField(fieldName) && isCheckboxOptionColumnField(fieldName);
				return {
					...state,
					agents,
					optionColumnItemOrder: shouldPreserveOrder
						? {
								agentIndex: action.agentIndex,
								fieldName,
								filter: state.optionColumnFilter,
								items: previousItems,
							}
						: state.optionColumnItemOrder,
					focus: {
						...state.focus,
						optionItemIndex: shouldPreserveOrder
							? Math.max(0, previousItems.indexOf(focusedItem))
							: getFocusedOptionItemIndex(
									agent,
									state.options,
									state.focus.fieldIndex,
									focusedItem,
									state.optionColumnFilter,
								),
					},
				};
			}

			return { ...state, agents };
		}

		case "RESCAN": {
			return { ...state, overlay: null, optionColumnFilter: "", optionColumnItemOrder: null };
		}

		case "RESCAN_COMPLETE": {
			const len = action.agents.length;
			const fieldIndex = clamp(state.focus.fieldIndex, FIELDS_ORDER.length);
			const focusedAgentIndex = clamp(state.focus.agentIndex, len);
			const focusedAgent = action.agents[focusedAgentIndex];
			return {
				...state,
				agents: action.agents,
				options: action.options,
				globalError: null,
				optionColumnFilter: "",
				optionColumnItemOrder: null,
				expandedAgentIndex: null,
				focus: {
					agentIndex: clamp(state.focus.agentIndex, len),
					fieldIndex,
					optionItemIndex: getFocusedOptionItemIndex(focusedAgent, action.options, fieldIndex),
				},
				optionColumnScrollOffset: syncOptionColumnScrollOffset(
					state.optionColumnScrollOffset,
					fieldIndex,
					OPTION_COLUMN_FIELDS.length,
					focusedAgent,
					action.options,
					"",
					null,
					focusedAgentIndex,
				),
			};
		}

		case "UPDATE_OPTIONS": {
			const focusedAgent = state.agents[state.focus.agentIndex];
			return {
				...state,
				options: action.options,
				optionColumnItemOrder: null,
				focus: {
					...state.focus,
					optionItemIndex: getFocusedOptionItemIndex(
						focusedAgent,
						action.options,
						state.focus.fieldIndex,
						undefined,
						state.optionColumnFilter,
					),
				},
				optionColumnScrollOffset: syncOptionColumnScrollOffset(
					state.optionColumnScrollOffset,
					state.focus.fieldIndex,
					OPTION_COLUMN_FIELDS.length,
					focusedAgent,
					action.options,
					state.optionColumnFilter,
					null,
					state.focus.agentIndex,
				),
			};
		}

		case "UPDATE_AGENTS": {
			const len = action.agents.length;
			const agentIndex = clamp(state.focus.agentIndex, len);
			const fieldIndex = clamp(state.focus.fieldIndex, FIELDS_ORDER.length);
			const focusedAgent = action.agents[agentIndex];
			return {
				...state,
				agents: action.agents,
				expandedAgentIndex:
					state.expandedAgentIndex !== null && state.expandedAgentIndex < len ? state.expandedAgentIndex : null,
				focus: {
					agentIndex,
					fieldIndex,
					optionItemIndex: getFocusedOptionItemIndex(
						focusedAgent,
						state.options,
						fieldIndex,
						undefined,
						state.optionColumnFilter,
					),
				},
			};
		}

		case "SCROLL": {
			const len = state.agents.length;
			if (len === 0) return state;
			const delta = action.direction === "down" ? 1 : -1;
			const newOffset = Math.max(0, Math.min(state.scrollOffset + delta, len - 1));
			return { ...state, scrollOffset: newOffset };
		}

		case "EXPAND": {
			const idx = state.focus.agentIndex;
			const agent = state.agents[idx];
			if (!agent || state.agents.length === 0) return state;
			const staleItems = getStaleCleanupItems(agent);
			if (hasStaleCleanupItems(staleItems)) {
				return {
					...state,
					overlay: {
						type: "stale-cleanup",
						agentIndex: idx,
						agentName: agent.name,
						staleItems,
					},
					optionColumnFilter: "",
					optionColumnItemOrder: null,
				};
			}
			return expandAgent(state, idx, agent);
		}

		case "EXPAND_WITHOUT_STALE_CHECK": {
			const idx = action.agentIndex;
			const agent = state.agents[idx];
			if (!agent || state.agents.length === 0) return state;
			return expandAgent(state, idx, agent);
		}

		case "COLLAPSE": {
			if (state.optionColumnFilter) {
				return { ...state, optionColumnFilter: "", optionColumnItemOrder: null };
			}
			return { ...state, expandedAgentIndex: null, optionColumnItemOrder: null };
		}

		default:
			return state;
	}
}

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

function isCheckboxField(fieldName: string): boolean {
	return ["tools", "extensions", "can_spawn", "skills", "prompt_parts"].includes(fieldName);
}

function getAvailableItems(
	options: DiscoveredOptions,
	fieldName: string,
	_selfName: string,
	agent?: AgentConfigState,
): string[] {
	switch (fieldName) {
		case "tools":
			return getToolsAvailableForAgent(options, agent);
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
			return options.canSpawn;
		case "skills":
			return options.skills;
		case "prompt_parts":
			return options.promptParts;
		default:
			return [];
	}
}

function getDefaultValue(fieldName: string, availableItems: string[], defaultModel?: string): string {
	if (fieldName === "depth") return "0";
	if (fieldName === "reasoning_effort") return "medium";
	if (fieldName === "model") {
		if (defaultModel) return defaultModel;
		if (availableItems.includes(MODEL_OPTION_LOADING_ITEM)) return MODEL_OPTION_LOADING_ITEM;
		if (availableItems.includes(MODEL_OPTION_DEGRADED_STATUS)) return MODEL_OPTION_DEGRADED_STATUS;
		return availableItems[0] || "(none)";
	}
	return availableItems[0] ?? "";
}
