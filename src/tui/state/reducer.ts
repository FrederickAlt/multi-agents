import type {
	ConfigState,
	ConfigAction,
	AgentConfigState,
	DiscoveredOptions,
	OverlayState,
} from "./types.js";
import { FIELDS_ORDER, OPTION_COLUMN_FIELDS } from "./types.js";
import { resolveModelDisplayName } from "../discovery/options.js";
import { clampHorizontalScrollOffset, clampVerticalScrollOffset } from "../layout.js";
import {
	getFieldName,
	getInlineOptionColumnFieldIndex,
	getOptionColumnItemIndex,
	getOptionColumnItems,
	isOptionColumnField,
} from "./option-columns.js";

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
			localSelection: [
				...localSelection.slice(0, idx),
				...localSelection.slice(idx + 1),
			],
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
export function computeCheckboxSaveValue(
	localSelection: string[],
	availableItems: string[],
): string[] | undefined {
	const selectedSet = new Set(localSelection.map(String));
	const availableSet = new Set(availableItems.map(String));
	if (
		selectedSet.size === availableSet.size
		&& [...selectedSet].every((item) => availableSet.has(item))
	) {
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
			extensions: [],
			models: [],
			defaultModel: "",
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

function getFocusedOptionItemIndex(
	agent: AgentConfigState | undefined,
	options: DiscoveredOptions,
	fieldIndex: number,
	focusedItemValue?: string,
): number {
	if (!agent) return 0;
	const fieldName = getFieldName(fieldIndex);
	if (!isOptionColumnField(fieldName)) return 0;
	return getOptionColumnItemIndex(
		agent,
		options,
		fieldName,
		focusedItemValue,
		agent.name,
	);
}
function syncOptionColumnScrollOffset(
	scrollOffset: number,
	fieldIndex: number,
	columnCount: number,
): number {
	const inlineFieldIndex = getInlineFocusFieldIndex(fieldIndex);
	if (inlineFieldIndex === null) {
		return scrollOffset;
	}
	return clampHorizontalScrollOffset(scrollOffset, inlineFieldIndex, columnCount);
}

/** Extract current value for a field from agent frontmatter */
function getFieldValue(
	agent: AgentConfigState,
	fieldName: string,
): string[] | string | number | undefined {
	const fm = agent.frontmatter ?? {};
	const raw = fm[fieldName];
	if (raw === undefined || raw === null) return undefined;
	if (Array.isArray(raw)) return raw.map(String);
	if (typeof raw === "number") return raw;
	return String(raw);
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function configReducer(state: ConfigState, action: ConfigAction): ConfigState {
	switch (action.type) {
		case "INIT_COMPLETE": {
			const fieldCount = FIELDS_ORDER.length;
			const fieldIndex = clamp(state.focus.fieldIndex, fieldCount);
			const focusedAgent = action.agents[clamp(state.focus.agentIndex, action.agents.length)];
			return {
				...state,
				agents: action.agents,
				options: action.options,
				globalError: null,
				expandedAgentIndex: null,
				focus: {
					agentIndex: clamp(state.focus.agentIndex, action.agents.length),
					fieldIndex,
					optionItemIndex: getFocusedOptionItemIndex(
						focusedAgent,
						action.options,
						fieldIndex,
					),
				},
				optionColumnScrollOffset: syncOptionColumnScrollOffset(
					state.optionColumnScrollOffset,
					fieldIndex,
					OPTION_COLUMN_FIELDS.length,
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
				state.expandedAgentIndex !== null && state.expandedAgentIndex !== newIdx
					? null
					: state.expandedAgentIndex;
			return {
				...state,
				expandedAgentIndex: nextExpanded,
				focus: { ...state.focus, agentIndex: newIdx },
				scrollOffset: clampVerticalScrollOffset(
					state.scrollOffset,
					newIdx,
					len,
					nextExpanded,
				),
			};
		}

		case "FOCUS_AGENT_AT": {
			const len = state.agents.length;
			if (len === 0) return state;
			const newIdx = clamp(action.agentIndex, len);
			// Collapse expanded row when focus moves away from the expanded agent
			const nextExpanded =
				state.expandedAgentIndex !== null && state.expandedAgentIndex !== newIdx
					? null
					: state.expandedAgentIndex;
			return {
				...state,
				expandedAgentIndex: nextExpanded,
				focus: { ...state.focus, agentIndex: newIdx },
				scrollOffset: clampVerticalScrollOffset(
					state.scrollOffset,
					newIdx,
					len,
					nextExpanded,
				),
			};
		}

		case "FOCUS_FIELD": {
			const len = FIELDS_ORDER.length;
			if (len === 0) return state;
			const delta = action.direction === "next" ? 1 : -1;
			const fieldIndex = clamp(state.focus.fieldIndex + delta, len);
			const agent = state.agents[state.focus.agentIndex];
			const fieldName = getFieldName(fieldIndex);
			return {
				...state,
				focus: {
					...state.focus,
					fieldIndex,
					optionItemIndex: getFocusedOptionItemIndex(agent, state.options, fieldIndex),
				},
				optionColumnScrollOffset: syncOptionColumnScrollOffset(
					state.optionColumnScrollOffset,
					fieldIndex,
					OPTION_COLUMN_FIELDS.length,
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
			const items = getOptionColumnItems(agent, state.options, fieldName);
			if (items.length === 0) return state;
			const delta = action.direction === "next" ? 1 : -1;
			return {
				...state,
				focus: {
					...state.focus,
					optionItemIndex: clamp(state.focus.optionItemIndex + delta, items.length),
				},
			};
		}

		case "OPEN_OVERLAY": {
			const agent = state.agents[action.agentIndex];
			if (!agent || agent.error) return state;

			const availableItems = getAvailableItems(
				state.options,
				action.fieldName,
				agent.name,
			);
			const currentValue = getFieldValue(agent, action.fieldName);

			let overlay: OverlayState;

			if (isCheckboxField(action.fieldName)) {
				const { localSelection, wasImplicit } = resolveCheckboxSelection(
					Array.isArray(currentValue) ? currentValue as string[] : undefined,
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

			return { ...state, overlay };
		}

		case "CLOSE_OVERLAY": {
			return { ...state, overlay: null };
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
			newStatuses.set(
				state.agents[action.agentIndex]?.filePath ?? "",
				action.status,
			);
			return { ...state, statuses: newStatuses };
		}

		case "UPDATE_AGENT_FRONTMATTER": {
			const previousAgent = state.agents[action.agentIndex];
			const agents = [...state.agents];
			const agent = { ...agents[action.agentIndex] };
			agent.frontmatter = action.frontmatter;
			agent.staleItems = action.staleItems;
			agents[action.agentIndex] = agent;

			if (
				state.expandedAgentIndex === action.agentIndex &&
				state.focus.agentIndex === action.agentIndex
			) {
				const fieldName = getFieldName(state.focus.fieldIndex);
				const previousItems = previousAgent && isOptionColumnField(fieldName)
					? getOptionColumnItems(previousAgent, state.options, fieldName, previousAgent.name)
					: [];
				const focusedItem = previousItems[state.focus.optionItemIndex];
				return {
					...state,
					agents,
					focus: {
						...state.focus,
						optionItemIndex: getFocusedOptionItemIndex(
							agent,
							state.options,
							state.focus.fieldIndex,
							focusedItem,
						),
					},
				};
			}

			return { ...state, agents };
		}

		case "RESCAN": {
			return { ...state, overlay: null };
		}

		case "RESCAN_COMPLETE": {
			const len = action.agents.length;
			const fieldIndex = clamp(state.focus.fieldIndex, FIELDS_ORDER.length);
			const focusedAgent = action.agents[clamp(state.focus.agentIndex, len)];
			return {
				...state,
				agents: action.agents,
				options: action.options,
				globalError: null,
				expandedAgentIndex: null,
				focus: {
					agentIndex: clamp(state.focus.agentIndex, len),
					fieldIndex,
					optionItemIndex: getFocusedOptionItemIndex(
						focusedAgent,
						action.options,
						fieldIndex,
					),
				},
				optionColumnScrollOffset: syncOptionColumnScrollOffset(
					state.optionColumnScrollOffset,
					fieldIndex,
					OPTION_COLUMN_FIELDS.length,
				),
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
			const fieldIndex =
				INITIAL_EXPANDED_FIELD_INDEX === -1 ? 0 : INITIAL_EXPANDED_FIELD_INDEX;
			return {
				...state,
				expandedAgentIndex: idx,
				focus: {
					agentIndex: idx,
					fieldIndex,
					optionItemIndex: getFocusedOptionItemIndex(
						agent,
						state.options,
						fieldIndex,
					),
				},
				optionColumnScrollOffset: syncOptionColumnScrollOffset(
					0,
					fieldIndex,
					OPTION_COLUMN_FIELDS.length,
				),
			};
		}

		case "COLLAPSE": {
			return { ...state, expandedAgentIndex: null };
		}

		default:
			return state;
	}
}

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

function isCheckboxField(fieldName: string): boolean {
	return [
		"tools",
		"extensions",
		"can_spawn",
		"skills",
		"prompt_parts",
	].includes(fieldName);
}

function getAvailableItems(
	options: DiscoveredOptions,
	fieldName: string,
	selfName: string,
): string[] {
	switch (fieldName) {
		case "tools":
			return options.tools;
		case "extensions":
			return options.extensions;
		case "model":
			return options.models.map((m) => m.displayName);
		case "reasoning_effort":
			return options.reasoningEfforts;
		case "depth":
			return options.depths.map(String);
		case "can_spawn":
			return options.canSpawn.filter((n) => n !== selfName);
		case "skills":
			return options.skills;
		case "prompt_parts":
			return options.promptParts;
		default:
			return [];
	}
}

function getDefaultValue(
	fieldName: string,
	availableItems: string[],
	defaultModel?: string,
): string {
	if (fieldName === "depth") return "0";
	if (fieldName === "reasoning_effort") return "medium";
	if (fieldName === "model") return defaultModel || availableItems[0] || "(none)";
	return availableItems[0] ?? "";
}
