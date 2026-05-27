import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getAgentRowHeight,
	getMaxVisibleAgents,
	clampVerticalScrollOffset,
} from "../src/tui/layout.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalRowsDescriptor = Object.getOwnPropertyDescriptor(
	process.stdout,
	"rows",
);

function setTerminalRows(rows: number): void {
	Object.defineProperty(process.stdout, "rows", {
		value: rows,
		configurable: true,
	});
}

afterEach(() => {
	if (originalRowsDescriptor) {
		Object.defineProperty(process.stdout, "rows", originalRowsDescriptor);
	} else {
		delete (process.stdout as { rows?: number }).rows;
	}
});

// ---------------------------------------------------------------------------
// getAgentRowHeight
// ---------------------------------------------------------------------------

describe("getAgentRowHeight", () => {
	it("returns COMPACT_ROW_HEIGHT (3) when agent is not expanded", () => {
		expect(getAgentRowHeight(0, null)).toBe(3);
		expect(getAgentRowHeight(5, 2)).toBe(3);
		expect(getAgentRowHeight(3, null)).toBe(3);
	});

	it("returns EXPANDED_ROW_HEIGHT (15) when agent is expanded", () => {
		expect(getAgentRowHeight(0, 0)).toBe(15);
		expect(getAgentRowHeight(3, 3)).toBe(15);
	});
});

// ---------------------------------------------------------------------------
// getMaxVisibleAgents
// ---------------------------------------------------------------------------

describe("getMaxVisibleAgents", () => {
	it("fits 8 compact agents in a 24-line terminal", () => {
		// 24 / 3 = 8
		expect(getMaxVisibleAgents(24, null, 20)).toBe(8);
	});

	it("fits 3 compact agents in a 10-line terminal", () => {
		// 10 / 3 = 3 (with 1 line left that can't fit another)
		expect(getMaxVisibleAgents(10, null, 20)).toBe(3);
	});

	it("accounts for an expanded agent taking more space", () => {
		// Agent 0 expanded (15) + 3 compact (3×3=9) = 24, fits in 24
		// Agent 0 expanded (15) + 4 compact (3×4=12) = 27, doesn't fit in 24
		expect(getMaxVisibleAgents(24, 0, 10)).toBe(4);
	});

	it("returns at least 1 even if termHeight is tiny", () => {
		expect(getMaxVisibleAgents(1, null, 10)).toBe(1);
	});

	it("handles termHeight smaller than a compact row", () => {
		expect(getMaxVisibleAgents(2, null, 10)).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// clampVerticalScrollOffset
// ---------------------------------------------------------------------------

describe("clampVerticalScrollOffset", () => {
	describe("when focused agent is already visible", () => {
		it("returns the same scrollOffset", () => {
			setTerminalRows(24);
			// All compact: 8 agents visible from offset 0
			expect(clampVerticalScrollOffset(0, 5, 20, null)).toBe(0);
		});
	});

	describe("when focused agent is before the visible window", () => {
		it("scrolls up to the focused agent", () => {
			setTerminalRows(24);
			// Offset is 5, focused is 2 → should scroll to 2
			expect(clampVerticalScrollOffset(5, 2, 20, null)).toBe(2);
		});
	});

	describe("when focused agent is after the visible window", () => {
		it("scrolls down and fills space by walking back", () => {
			setTerminalRows(24);
			// 24-line terminal: 8 compact agents fit
			// Focused agent 9, offset 0 → agent 9 is beyond visible window (0-7)
			// Should walk back from 9, filling space: 2-9 (8 agents)
			expect(clampVerticalScrollOffset(0, 9, 20, null)).toBe(2);
		});
	});

	describe("the reproduced clamp bug (stale `used` value)", () => {
		it("walks back correctly from a deep focused agent in a small terminal", () => {
			setTerminalRows(10);
			// 10-line terminal: 3 compact agents fit
			// scrollOffset=0, focused=9, 10 agents, no expansion
			// With the stale `used` bug this returned 9.
			// After fix: walks back from 9: 9(3) + 8(3) + 7(3) = 9 → fits in 10,
			// but 6 would overflow (12 > 10), so offset should be 7.
			expect(clampVerticalScrollOffset(0, 9, 10, null)).toBe(7);
		});

		it("handles the case where focused agent fills almost the whole terminal", () => {
			setTerminalRows(12);
			// 12-line terminal: 4 compact agents fit
			// scrollOffset=0, focused=9, 10 agents, no expansion
			// Walks back: 9(3) + 8(3) + 7(3) + 6(3) = 12 → fits (offset 6)
			// 5 would overflow (15 > 12), so offset should be 6
			expect(clampVerticalScrollOffset(0, 9, 10, null)).toBe(6);
		});
	});

	describe("with an expanded row", () => {
		it("accounts for the expanded row in walk-back calculation", () => {
			setTerminalRows(24);
			// Agent 2 is expanded (15 lines), others compact (3)
			// scrollOffset=0, focused=6, 10 agents, expanded=2
			// Forward from 0 fits agents 0-3 (3+3+15+3=24), so focused=6 is beyond the window.
			// Walk-back from focused agent 6 fits compact agents 6,5,4,3 (12 lines),
			// but adding expanded agent 2 would overflow (27 > 24), so offset is 3.
			expect(clampVerticalScrollOffset(0, 6, 10, 2)).toBe(3);
		});

		it("does not walk back past expanded row if it doesn't fit", () => {
			setTerminalRows(15);
			// Agent 2 is expanded (15), focused=6
			// Forward from 0: 0(3)+1(3)+2(15)=21 > 15, break at 2 → visible=2
			// focused=6 >= 2 → enter walk-back
			// nextOffset=6, used=getAgentRowHeight(6,2)=3
			// Walk back: 5(3): 3+3=6 <=15, used=6, nextOffset=5
			// 4(3): 6+3=9 <=15, used=9, nextOffset=4
			// 3(3): 9+3=12 <=15, used=12, nextOffset=3
			// 2(15): 12+15=27 >15, break
			// Result: 3
			expect(clampVerticalScrollOffset(0, 6, 10, 2)).toBe(3);
		});
	});

	describe("edge cases", () => {
		it("returns 0 when there are no agents", () => {
			expect(clampVerticalScrollOffset(5, 0, 0, null)).toBe(0);
		});

		it("returns 0 for a single agent", () => {
			setTerminalRows(24);
			expect(clampVerticalScrollOffset(0, 0, 1, null)).toBe(0);
		});

		it("clamps to agentCount - 1 when focused is the last agent and fits alone", () => {
			setTerminalRows(6);
			// 6-line terminal: 2 compact agents (6 lines)
			// scrollOffset=0, focused=19, 20 agents
			// Forward: 0(3)+1(3)=6 breaks at 2 → visible=2
			// focused=19 >= 2 → walk back from 19
			// nextOffset=19, used=3
			// 18: h=3, 3+3=6 <=6, used=6, nextOffset=18
			// 17: h=3, 6+3=9 >6, break → result=18
			expect(clampVerticalScrollOffset(0, 19, 20, null)).toBe(18);
		});

		it("returns focusedAgentIndex when it fits with no room to walk back", () => {
			setTerminalRows(3);
			// Only 1 compact agent fits
			// scrollOffset=0, focused=5, 10 agents
			// Forward: 0(3) fits → used=3, visible=1
			// focused=5 >= 1 → walk back from 5
			// nextOffset=5, used=3
			// 4: h=3, 3+3=6 > 3, break → result=5
			expect(clampVerticalScrollOffset(0, 5, 10, null)).toBe(5);
		});
	});
});
