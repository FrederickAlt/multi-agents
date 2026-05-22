import { describe, expect, it, vi } from "vitest";
import { getFieldName } from "../../src/tui/state/option-columns.js";
import {
	handleExpandedEnterOrSpace,
	isInlineEditableField,
} from "../../src/tui/hooks/useKeyboard.js";

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
		expect(isInlineEditableField(getFieldName(2))).toBe(true); // model
		expect(isInlineEditableField(getFieldName(3))).toBe(true); // reasoning_effort
		expect(isInlineEditableField(getFieldName(4))).toBe(true); // depth
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
		};

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
		};

		handleExpandedEnterOrSpace(
			{ agentIndex: 0, fieldName: "display_name" },
			actions,
		);

		expect(actions.openOverlay).toHaveBeenCalledTimes(1);
		expect(actions.openOverlay).toHaveBeenCalledWith(0, "display_name");
		expect(actions.selectFocusedOption).not.toHaveBeenCalled();
	});
});
