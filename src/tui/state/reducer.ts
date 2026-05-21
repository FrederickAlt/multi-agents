import type {
	ConfigState,
	ConfigAction,
	AgentConfigState,
	DiscoveredOptions,
	OverlayState,
} from "./types.js";
import { FIELDS_ORDER } from "./types.js";

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
	if (localSelection.length === availableItems.length) {
		return undefined;
	}
	return [...localSelection];
}

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
		focus: { agentIndex: 0, fieldIndex: 0 },
		overlay: null,
		statuses: new Map(),
		scrollOffset: 0,
		globalError: null,
	};
}

/** Clamp index to range [0, len) */
function clamp(index: number, len: number): number {
	if (len === 0) return 0;
	return ((index % len) + len) % len;
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
			return {
				...state,
				agents: action.agents,
				options: action.options,
				globalError: null,
				focus: {
					agentIndex: clamp(state.focus.agentIndex, action.agents.length),
					fieldIndex: clamp(state.focus.fieldIndex, FIELDS_ORDER.length),
				},
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
			// Auto-scroll
			let { scrollOffset } = state;
			if (newIdx < scrollOffset) scrollOffset = newIdx;
			if (newIdx >= scrollOffset + 1) scrollOffset = newIdx; // simplistic: always keep focused visible
			return {
				...state,
				focus: { ...state.focus, agentIndex: newIdx },
				scrollOffset,
			};
		}

		case "FOCUS_FIELD": {
			const len = FIELDS_ORDER.length;
			if (len === 0) return state;
			const delta = action.direction === "next" ? 1 : -1;
			return {
				...state,
				focus: {
					...state.focus,
					fieldIndex: clamp(state.focus.fieldIndex + delta, len),
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
				const current = currentValue !== undefined ? String(currentValue) : defaultVal;
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
			const agents = [...state.agents];
			const agent = { ...agents[action.agentIndex] };
			agent.frontmatter = action.frontmatter;
			agent.staleItems = action.staleItems;
			agents[action.agentIndex] = agent;
			return { ...state, agents };
		}

		case "RESCAN": {
			return { ...state, overlay: null };
		}

		case "RESCAN_COMPLETE": {
			const len = action.agents.length;
			return {
				...state,
				agents: action.agents,
				options: action.options,
				globalError: null,
				focus: {
					agentIndex: clamp(state.focus.agentIndex, len),
					fieldIndex: clamp(state.focus.fieldIndex, FIELDS_ORDER.length),
				},
			};
		}

		case "SCROLL": {
			return { ...state };
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
