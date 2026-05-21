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

export interface FocusState {
	agentIndex: number;
	fieldIndex: number; // index into FIELDS_ORDER
}

export interface OverlayState {
	type: "checkbox" | "dropdown";
	agentIndex: number;
	fieldName: string;
	currentValue: string[] | string | number | undefined; // from agent frontmatter
	availableItems: string[];
	staleItems: string[];
	// For checkbox: locally toggled set (starts as currentValue resolved)
	localSelection: string[];
	// For dropdown: locally selected item
	localSelected: string;
	// Tri-state: true when the field was missing (undefined) before opening
	wasImplicit: boolean;
}

export interface DiscoveredOptions {
	tools: string[];
	extensions: string[];
	models: ModelOption[];
	/** Display name of the runtime default model (first available with auth). */
	defaultModel: string;
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
}

export interface StatusInfo {
	type: "saved" | "error" | "saving";
	message: string;
	timestamp: number;
}

export interface ConfigState {
	agents: AgentConfigState[];
	options: DiscoveredOptions;
	focus: FocusState;
	overlay: OverlayState | null;
	statuses: Map<string, StatusInfo>; // keyed by filePath
	scrollOffset: number;
	globalError: string | null;
}

// Field order for navigation (matches column layout)
export const FIELDS_ORDER = [
	"tools",
	"extensions",
	"model",
	"reasoning_effort",
	"depth",
	"can_spawn",
	"skills",
	"prompt_parts",
] as const;

export type FieldName = (typeof FIELDS_ORDER)[number];

/** Width of each agent column in terminal cells (30 content + 2 borders). */
export const COLUMN_WIDTH = 32;

/** Reserved left gutter for horizontal scroll indication. */
export const SCROLL_GUTTER_WIDTH = 3;

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
	| { type: "SCROLL"; direction: "left" | "right" };
