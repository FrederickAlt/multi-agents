import { describe, expect, it, vi } from "vitest";
import { getFieldName } from "../../src/tui/state/option-columns.js";
import {
	handleExpandedEnterOrSpace,
	handleKeyboardInput,
	isInlineEditableField,
	type KeyboardActions,
	type KeyboardState,
} from "../../src/tui/hooks/useKeyboard.js";

function makeState(overrides: Partial<KeyboardState> = {}): KeyboardState {
	return {
		isOverlayOpen: false,
		isExpanded: true,
		overlayType: null,
		overlayItems: [],
		overlayFocusedIndex: 0,
		agentIndex: 0,
		fieldIndex: 0,
		fieldName: getFieldName(0),
		scrollOffset: 0,
		optionColumnFilter: "",
		...overrides,
	};
}

function makeActions(): KeyboardActions {
	return {
		focusNextAgent: vi.fn(),
		focusPrevAgent: vi.fn(),
		focusNextField: vi.fn(),
		focusPrevField: vi.fn(),
		focusNextOptionItem: vi.fn(),
		focusPrevOptionItem: vi.fn(),
		openOverlay: vi.fn(),
		focusAgentAt: vi.fn(),
		closeOverlay: vi.fn(),
		toggleCheckbox: vi.fn(),
		selectDropdown: vi.fn(),
		commitOverlay: vi.fn(),
		selectFocusedOption: vi.fn(),
		rescan: vi.fn(),
		expand: vi.fn(),
		collapse: vi.fn(),
		setOptionColumnFilter: vi.fn(),
		overlayFocusUp: vi.fn(),
		overlayFocusDown: vi.fn(),
		overlayActivate: vi.fn(),
	};
}

describe("Keyboard editability mapping", () => {
	it("uses inline edit path for all inline checkbox/select fields", () => {
		expect(isInlineEditableField("reasoning_effort")).toBe(true);
		expect(isInlineEditableField("depth")).toBe(true);
		expect(isInlineEditableField("model")).toBe(true);
		expect(isInlineEditableField("tools")).toBe(true);
		expect(isInlineEditableField("extensions")).toBe(true);
		expect(isInlineEditableField("can_spawn")).toBe(true);
		expect(isInlineEditableField("skills")).toBe(true);
		expect(isInlineEditableField("prompt_parts")).toBe(true);
	});

	it("uses full field order indices for inline/non-inline behavior", () => {
		expect(isInlineEditableField(getFieldName(0))).toBe(true); // tools
		expect(isInlineEditableField(getFieldName(1))).toBe(true); // extensions
		expect(isInlineEditableField(getFieldName(2))).toBe(true); // reasoning_effort
		expect(isInlineEditableField(getFieldName(3))).toBe(true); // depth
		expect(isInlineEditableField(getFieldName(4))).toBe(true); // model
		expect(isInlineEditableField(getFieldName(5))).toBe(true); // can_spawn
		expect(isInlineEditableField(getFieldName(6))).toBe(true); // skills
		expect(isInlineEditableField(getFieldName(7))).toBe(true); // prompt_parts
	});
});

describe("Keyboard Enter/Space action routing", () => {
	it("routes inline Enter/Space to inline option selection", () => {
		const actions = {
			selectFocusedOption: vi.fn(),
			openOverlay: vi.fn(),
		} as Pick<KeyboardActions, "selectFocusedOption" | "openOverlay">;

		handleExpandedEnterOrSpace(
			{ agentIndex: 0, fieldName: getFieldName(0) },
			actions,
		);

		expect(actions.selectFocusedOption).toHaveBeenCalledTimes(1);
		expect(actions.openOverlay).not.toHaveBeenCalled();
	});

	it("routes non-inline Enter/Space to overlay opening", () => {
		const actions = {
			selectFocusedOption: vi.fn(),
			openOverlay: vi.fn(),
		} as Pick<KeyboardActions, "selectFocusedOption" | "openOverlay">;

		handleExpandedEnterOrSpace(
			{ agentIndex: 0, fieldName: "display_name" },
			actions,
		);

		expect(actions.openOverlay).toHaveBeenCalledTimes(1);
		expect(actions.openOverlay).toHaveBeenCalledWith(0, "display_name");
		expect(actions.selectFocusedOption).not.toHaveBeenCalled();
	});
});

describe("Keyboard input dispatch for inline option filtering", () => {
	it.each(["r", "q", "h", "j", "k", "l"]) (
		"routes typed %s to option filter in expanded inline columns",
		(char) => {
			const actions = makeActions();
			const exit = vi.fn();
			const state = makeState({ optionColumnFilter: "pre" });
			handleKeyboardInput(char, {}, state, actions, exit);

			expect(actions.setOptionColumnFilter).toHaveBeenCalledWith(`pre${char}`);
			expect(actions.setOptionColumnFilter).toHaveBeenCalledTimes(1);
			expect(actions.focusPrevOptionItem).not.toHaveBeenCalled();
			expect(actions.focusNextOptionItem).not.toHaveBeenCalled();
			expect(actions.focusPrevField).not.toHaveBeenCalled();
			expect(actions.focusNextField).not.toHaveBeenCalled();
			expect(actions.rescan).not.toHaveBeenCalled();
			expect(exit).not.toHaveBeenCalled();
		},
	);

	it("backspace/delete shortens the inline option filter", () => {
		const actions = makeActions();
		const exit = vi.fn();
		const state = makeState({ optionColumnFilter: "skill" });
		handleKeyboardInput("", { backspace: true }, state, actions, exit);

		expect(actions.setOptionColumnFilter).toHaveBeenCalledWith("skil");
		expect(actions.setOptionColumnFilter).toHaveBeenCalledTimes(1);
		expect(exit).not.toHaveBeenCalled();
	});

	it("escape triggers collapse while expanded option columns are focused", () => {
		const actions = makeActions();
		const exit = vi.fn();
		const state = makeState({ optionColumnFilter: "med" });
		handleKeyboardInput("", { escape: true }, state, actions, exit);

		expect(actions.collapse).toHaveBeenCalledTimes(1);
		expect(actions.setOptionColumnFilter).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
	});

	it("escape exits from compact outer level", () => {
		const actions = makeActions();
		const exit = vi.fn();
		const state = makeState({ isExpanded: false });
		handleKeyboardInput("", { escape: true }, state, actions, exit);

		expect(exit).toHaveBeenCalledTimes(1);
		expect(actions.collapse).not.toHaveBeenCalled();
	});

	it("q is ordinary input, not a quit shortcut, outside inline filters", () => {
		const actions = makeActions();
		const exit = vi.fn();
		const state = makeState({ isExpanded: false });
		handleKeyboardInput("q", {}, state, actions, exit);

		expect(exit).not.toHaveBeenCalled();
	});

	it("arrow keys still navigate option items in inline expanded mode", () => {
		const actions = makeActions();
		const exit = vi.fn();
		const state = makeState({ optionColumnFilter: "m" });
		handleKeyboardInput("", { upArrow: true }, state, actions, exit);
		handleKeyboardInput("", { downArrow: true }, state, actions, exit);

		expect(actions.focusPrevOptionItem).toHaveBeenCalledTimes(1);
		expect(actions.focusNextOptionItem).toHaveBeenCalledTimes(1);
		expect(actions.focusPrevField).not.toHaveBeenCalled();
		expect(actions.focusNextField).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
	});

	it("left/right arrows continue to move between option fields", () => {
		const actions = makeActions();
		const exit = vi.fn();
		const state = makeState();
		handleKeyboardInput("", { leftArrow: true }, state, actions, exit);
		handleKeyboardInput("", { rightArrow: true }, state, actions, exit);

		expect(actions.focusPrevField).toHaveBeenCalledTimes(1);
		expect(actions.focusNextField).toHaveBeenCalledTimes(1);
		expect(actions.focusPrevOptionItem).not.toHaveBeenCalled();
		expect(actions.focusNextOptionItem).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
	});
});

describe("Keyboard input dispatch for expanded non-option fields", () => {
	it.each(["h", "j", "k", "l"]) (
		"routes typed %s to field navigation in expanded non-option mode",
		(input) => {
			const actions = makeActions();
			const exit = vi.fn();
			const state = makeState({
				fieldName: "description",
				optionColumnFilter: "filter",
			});
			handleKeyboardInput(input, {}, state, actions, exit);

			expect(actions.setOptionColumnFilter).not.toHaveBeenCalled();
			expect(actions.focusPrevField).toHaveBeenCalledTimes(input === "h" || input === "k" ? 1 : 0);
			expect(actions.focusNextField).toHaveBeenCalledTimes(input === "j" || input === "l" ? 1 : 0);
			expect(actions.focusPrevOptionItem).not.toHaveBeenCalled();
			expect(actions.focusNextOptionItem).not.toHaveBeenCalled();
			expect(exit).not.toHaveBeenCalled();
		},
	);
});
