import { describe, expect, it, vi } from "vitest";
import { getFieldName } from "../../src/tui/state/option-columns.js";
import {
	handleExpandedEnterOrSpace,
	isInlineEditableField,
} from "../../src/tui/hooks/useKeyboard.js";

describe("Keyboard editability mapping", () => {
	it("uses inline write path for reasoning_effort and depth only", () => {
		expect(isInlineEditableField("reasoning_effort")).toBe(true);
		expect(isInlineEditableField("depth")).toBe(true);
		expect(isInlineEditableField("model")).toBe(false);
		expect(isInlineEditableField("tools")).toBe(false);
		expect(isInlineEditableField("extensions")).toBe(false);
	});

	it("uses full field order indices for inline/non-inline behavior", () => {
		expect(isInlineEditableField(getFieldName(3))).toBe(true); // reasoning_effort
		expect(isInlineEditableField(getFieldName(4))).toBe(true); // depth
		expect(isInlineEditableField(getFieldName(5))).toBe(false); // can_spawn
		expect(isInlineEditableField(getFieldName(6))).toBe(false); // skills
	});
});

describe("Keyboard Enter/Space action routing", () => {
	it("routes inline Enter/Space to inline option selection", () => {
		const actions = {
			selectFocusedOption: vi.fn(),
			openOverlay: vi.fn(),
		};

		handleExpandedEnterOrSpace(
			{ agentIndex: 0, fieldName: getFieldName(3) },
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
			{ agentIndex: 0, fieldName: getFieldName(2) },
			actions,
		);

		expect(actions.openOverlay).toHaveBeenCalledTimes(1);
		expect(actions.openOverlay).toHaveBeenCalledWith(0, getFieldName(2));
		expect(actions.selectFocusedOption).not.toHaveBeenCalled();
	});
});
