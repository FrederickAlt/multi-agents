// ---------------------------------------------------------------------------
// State types for Agent Configuration TUI
// ---------------------------------------------------------------------------

export interface AgentConfigState {
	name: string; // filename stem
	description: string; // from frontmatter, display-only
	filePath: string; // absolute path
	frontmatter: Record<string, unknown> | null; // parsed YAML (null if parse error)
	body: string; // markdown after frontmatter (never touched)
	error: string | null; // YAML parse error message
	staleItems: Record<string, string[]>; // fieldName → stale value names
}

export type AgentMode = "fast" | "smart";

export interface FocusState {
	agentIndex: number;
	fieldIndex: number; // index into FIELDS_ORDER while expanded
	optionItemIndex: number; // index into focused inline option column when focused field is inline
}

export type OverlayState =
	| {
			type: "checkbox";
			agentIndex: number;
			fieldName: string;
			currentValue: string[] | string | number | undefined; // from agent frontmatter
			availableItems: string[];
			staleItems: string[];
			// For checkbox: locally toggled set (starts as currentValue resolved)
			localSelection: string[];
			localSelected: string;
			// Tri-state: true when the field was missing (undefined) before opening
			wasImplicit: boolean;
	  }
	| {
			type: "dropdown";
			agentIndex: number;
			fieldName: string;
			currentValue: string[] | string | number | undefined; // from agent frontmatter
			availableItems: string[];
			staleItems: string[];
			localSelection: string[];
			// For dropdown: locally selected item
			localSelected: string;
			// Tri-state: true when the field was missing (undefined) before opening
			wasImplicit: boolean;
	  }
	| {
			type: "stale-cleanup";
			agentIndex: number;
			agentName: string;
			staleItems: Record<string, string[]>;
	  };

export interface ModelDiscoveryState {
	status: "loading" | "ready" | "degraded";
	/**
	 * Human-readable failure text when status is "degraded".
	 * Empty/undefined for loading/ready states.
	 */
	error?: string | null;
}

export interface DiscoveredOptions {
	tools: string[];
	/**
	 * Tool name -> extension identifiers that provide it. Built-in tools are
	 * omitted, and agent-declared tools are not availability evidence.
	 */
	toolExtensionNames?: Record<string, string[]>;
	extensions: string[];
	/**
	 * Extension option names that are present in settings but disabled at the
	 * package/resource level. They are shown for visibility but cannot be selected
	 * per agent because Pi will not load them until global/project settings change.
	 */
	disabledExtensions?: string[];
	extensionAliases?: Record<string, string[]>;
	models: ModelOption[];
	/**
	 * Display name of the runtime default model (first available with auth).
	 * Empty while model discovery is pending.
	 */
	defaultModel: string;
	/**
	 * Model discovery metadata for rendering a loading/degraded option column
	 * state in the TUI without blocking other fields.
	 */
	modelDiscovery: ModelDiscoveryState;
	reasoningEfforts: string[];
	depths: number[];
	canSpawn: string[];
	skills: string[];
	promptParts: string[];
}

export interface ModelOption {
	provider: string;
	modelId: string;
	displayName: string;
	/**
	 * Canonical runtime reference string:
	 * - bare modelId when it uniquely identifies one Pi model across providers
	 * - "provider/modelId" when modelId is ambiguous across providers
	 */
	canonicalRef: string;
}

export interface StatusInfo {
	type: "saved" | "error" | "saving";
	message: string;
	timestamp: number;
}

export interface OptionColumnItemOrder {
	agentIndex: number;
	fieldName: OptionColumnFieldName;
	filter: string;
	items: string[];
}

export interface ConfigState {
	agents: AgentConfigState[];
	options: DiscoveredOptions;
	focus: FocusState;
	expandedAgentIndex: number | null; // null = compact mode; index = which agent is expanded
	overlay: OverlayState | null;
	statuses: Map<string, StatusInfo>; // keyed by filePath
	scrollOffset: number; // vertical scroll (index of first visible agent)
	optionColumnScrollOffset: number; // horizontal scroll (index of first visible Option column)
	optionColumnItemOrder: OptionColumnItemOrder | null; // preserved order while toggling within one column
	/**
	 * Temporary text filter for the focused inline Option column.
	 * Cleared when focus moves to another column or actions require an unfiltered view.
	 */
	optionColumnFilter: string;
	/** Whether the linked Smart model picker has been explicitly opened with Enter/Space. */
	smartModelPickerOpen?: boolean;
	globalError: string | null;
}

// Field order for navigation (matches column layout)
export const FIELDS_ORDER = [
	"tools",
	"extensions",
	"model",
	"smart_model",
	"depth",
	"can_spawn",
	"skills",
	"prompt_parts",
] as const;

export type FieldName = (typeof FIELDS_ORDER)[number];

export const OPTION_COLUMN_FIELDS = [
	"tools",
	"extensions",
	"model",
	"smart_model",
	"depth",
	"can_spawn",
	"skills",
	"prompt_parts",
] as const;
export type OptionColumnFieldName = (typeof OPTION_COLUMN_FIELDS)[number];

export const OPTION_COLUMN_WIDTH = 22;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ConfigAction =
	| {
			type: "INIT_COMPLETE";
			agents: AgentConfigState[];
			options: DiscoveredOptions;
	  }
	| { type: "INIT_ERROR"; error: string }
	| { type: "FOCUS_AGENT"; direction: "next" | "prev" }
	| { type: "FOCUS_AGENT_AT"; agentIndex: number }
	| { type: "FOCUS_FIELD"; direction: "next" | "prev" }
	| { type: "FOCUS_OPTION_ITEM"; direction: "next" | "prev" }
	| { type: "OPEN_SMART_MODEL_PICKER" }
	| { type: "OPEN_OVERLAY"; agentIndex: number; fieldName: string }
	| { type: "CLOSE_OVERLAY" }
	| { type: "TOGGLE_CHECKBOX"; item: string }
	| { type: "SELECT_DROPDOWN"; item: string }
	| {
			type: "SAVE_COMPLETE";
			agentIndex: number;
			status: StatusInfo;
	  }
	| {
			type: "UPDATE_AGENT_FRONTMATTER";
			agentIndex: number;
			frontmatter: Record<string, unknown>;
			staleItems: Record<string, string[]>;
	  }
	| { type: "RESCAN" }
	| {
			type: "RESCAN_COMPLETE";
			agents: AgentConfigState[];
			options: DiscoveredOptions;
	  }
	| {
			type: "UPDATE_OPTIONS";
			options: DiscoveredOptions;
	  }
	| {
			type: "UPDATE_AGENT_STALE_ITEMS";
			agents: AgentConfigState[];
	  }
	| { type: "SCROLL"; direction: "up" | "down" }
	| { type: "EXPAND" }
	| { type: "EXPAND_WITHOUT_STALE_CHECK"; agentIndex: number }
	| { type: "COLLAPSE" }
	| { type: "SET_OPTION_COLUMN_FILTER"; filter: string }
	| { type: "CLEAR_OPTION_COLUMN_FILTER" };

/** Height of a compact agent row in terminal lines. */
export const COMPACT_ROW_HEIGHT = 3;

/** Height of an expanded agent row in terminal lines. */
export const EXPANDED_ROW_HEIGHT = 15;
