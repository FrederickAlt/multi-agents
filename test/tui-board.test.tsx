import React from "react";
import { describe, expect, it } from "vitest";
import { Board } from "../src/tui/components/Board.js";
import { AgentRow } from "../src/tui/components/AgentRow.js";
import { OptionColumn } from "../src/tui/components/OptionColumn.js";
import type { AgentConfigState, ConfigState, DiscoveredOptions } from "../src/tui/state/types.js";

const options: DiscoveredOptions = {
	tools: [],
	extensions: [],
	models: [],
	defaultModel: "",
	modelDiscovery: {
		status: "ready",
		error: null,
	},
	reasoningEfforts: [],
	depths: [],
	canSpawn: [],
	skills: [],
	promptParts: [],
};

function agent(name: string): AgentConfigState {
	return {
		name,
		description: `${name} description`,
		filePath: `/tmp/${name}.md`,
		frontmatter: {},
		body: "",
		error: null,
		staleItems: {},
	};
}

function state(overrides: Partial<ConfigState> = {}): ConfigState {
	return {
		agents: [agent("default"), agent("explorer"), agent("coder")],
		options,
		focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 0 },
		expandedAgentIndex: null,
		overlay: null,
		statuses: new Map(),
		scrollOffset: 0,
		optionColumnScrollOffset: 0,
		globalError: null,
		...overrides,
	};
}

function renderedChildren(element: React.ReactElement): React.ReactNode[] {
	return React.Children.toArray(element.props.children);
}

function collectText(node: React.ReactNode): string {
	if (node === null || node === undefined || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(collectText).join("");
	if (React.isValidElement(node)) {
		if (typeof node.type === "function") {
			return collectText((node.type as (props: any) => React.ReactNode)(node.props));
		}
		return collectText(node.props.children);
	}
	return "";
}

describe("Board", () => {
	it("renders AgentRow components for all visible agents in vertical layout", () => {
		const result = Board({ state: state() }) as React.ReactElement;
		const children = renderedChildren(result);
		// The scroll indicators appear above/below the agent rows when scrolling.
		// With 0 scroll offset and all agents visible, no indicators.
		// AgentRow components have AgentRow as their type (function component).
		const agentNames = children
			.map((c: any) => c?.props?.agent?.name)
			.filter(Boolean);
		expect(agentNames).toEqual(["default", "explorer", "coder"]);
	});

	it("returns null when there are no agents", () => {
		expect(Board({ state: state({ agents: [] }) })).toBeNull();
	});

	it("never trims the focused agent when scroll indicators overflow", () => {
		// Patch process.stdout.rows to a tiny value so the trim logic activates.
		const origRows = (process.stdout as { rows?: number }).rows;
		Object.defineProperty(process.stdout, "rows", {
			value: 4,
			configurable: true,
		});
		try {
			// Only 4 rows available. Compact agent takes 3 lines.
			// Two agents: one visible (3 lines) + one overflow indicator (1 line) = 4.
			// Without protection, the trim loop would pop the focused agent.
			// With protections, the focused agent stays.
			const s = state({
				focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 0 },
				scrollOffset: 0,
			});
			const result = Board({ state: s }) as React.ReactElement;
			const children = renderedChildren(result);
			const agentNames = children
				.map((c: any) => c?.props?.agent?.name)
				.filter(Boolean);
			expect(agentNames).toContain("default");
		} finally {
			if (origRows !== undefined) {
				Object.defineProperty(process.stdout, "rows", {
					value: origRows,
					configurable: true,
				});
			} else {
				delete (process.stdout as { rows?: number }).rows;
			}
		}
	});

	it("passes inline Option column focus and horizontal scroll state to expanded rows", () => {
		const s = state({
			focus: { agentIndex: 0, fieldIndex: 1, optionItemIndex: 3 },
			expandedAgentIndex: 0,
			optionColumnScrollOffset: 1,
		});

		const result = Board({ state: s }) as React.ReactElement;
		const row = renderedChildren(result).find((c: any) => c?.props?.agent?.name === "default") as React.ReactElement;

		expect(row.props.focusedField).toBe(1);
		expect(row.props.focusedOptionItem).toBe(3);
		expect(row.props.optionColumnScrollOffset).toBe(1);
	});

	it("expanded AgentRow renders save status and scrolled Option columns", () => {
		const result = AgentRow({
			agent: agent("default"),
			isFocused: true,
			isExpanded: true,
			focusedField: 3,
			focusedOptionItem: 2,
			optionColumnScrollOffset: 1,
			options: {
				...options,
				reasoningEfforts: ["low", "medium", "high"],
				depths: [0, 1, 2],
			},
			status: { type: "saved", message: "Saved default.md", timestamp: 1 },
		}) as React.ReactElement;
		const children = renderedChildren(result);

		const text = collectText(result);
		expect(text).toContain("Saved default.md");
		expect(text).toContain("reasoning");
		expect(text).toContain("depth");
		expect(children.length).toBeGreaterThan(0);
	});

	it("shows focused non-inline field context in expanded rows", () => {
		const focusedAgent = {
			...agent("default"),
			frontmatter: {
				can_spawn: ["builder"],
			},
		};
		const result = AgentRow({
			agent: focusedAgent,
			isFocused: true,
			isExpanded: true,
			focusedField: 5,
			focusedOptionItem: 2,
			optionColumnScrollOffset: 0,
			options: {
				...options,
				reasoningEfforts: ["low", "medium", "high"],
				depths: [0, 1, 2],
				canSpawn: ["builder", "reviewer"],
			},
			status: undefined,
		}) as React.ReactElement;

		const text = collectText(result);
		expect(text).toContain("can_spawn");
		expect(text).toContain("1 selected");
		expect(text).toContain("Press Enter/Space to edit");
	});

	it("keeps non-inline context visible when status is present", () => {
		const focusedAgent = {
			...agent("default"),
			frontmatter: {
				can_spawn: ["builder"],
			},
		};
		const result = AgentRow({
			agent: focusedAgent,
			isFocused: true,
			isExpanded: true,
			focusedField: 5,
			focusedOptionItem: 2,
			optionColumnScrollOffset: 0,
			options: {
				...options,
				reasoningEfforts: ["low", "medium", "high"],
				depths: [0, 1, 2],
				canSpawn: ["builder", "reviewer"],
			},
			status: { type: "saved", message: "Saved default.md", timestamp: 1 },
		}) as React.ReactElement;

		const text = collectText(result);
		expect(text).toContain("Saved default.md");
		expect(text).toContain("Focus: can_spawn");
		expect(text).toContain("Press Enter/Space to edit");
	});

	it("marks stale inline checkbox entries as missing", () => {
		const staleAgent = {
			...agent("default"),
			frontmatter: {
				tools: ["read", "deleted_tool"],
			},
			staleItems: {
				tools: ["deleted_tool"],
			},
		};
		const result = AgentRow({
			agent: staleAgent,
			isFocused: true,
			isExpanded: true,
			focusedField: 0,
			focusedOptionItem: 1,
			optionColumnScrollOffset: 0,
			options: {
				...options,
				tools: ["read", "bash", "write"],
			},
			status: undefined,
		}) as React.ReactElement;

		const text = collectText(result);
		expect(text).toContain("deleted_tool");
		expect(text).toContain("(missing)");
	});

	it("keeps the focused last option item visible in expanded AgentRow rendering", () => {
		const s = state({
			focus: {
				agentIndex: 0,
				fieldIndex: 4,
				optionItemIndex: 10,
			},
			expandedAgentIndex: 0,
			optionColumnScrollOffset: 3,
			options: {
				...options,
				reasoningEfforts: ["low", "medium", "high", "maximum"],
				depths: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
			},
		});

		const result = Board({ state: s }) as React.ReactElement;
		const row = renderedChildren(result).find(
			(c: any) => c?.props?.agent?.name === "default",
		) as React.ReactElement;
		const text = collectText(row);

		expect(text).toContain("10");
		expect(text).not.toContain(" ○ 0");
	});

	it("keeps the focused option item visible when list scrolls vertically", () => {
		const result = OptionColumn({
			fieldName: "depth",
			items: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
			selectedValues: ["0"],
			focusedItemIndex: 8,
			isFocused: true,
			maxVisibleItems: 5,
		}) as React.ReactElement;
		const text = collectText(result);

		expect(text).toContain("8");
		expect(text).not.toMatch(/(?:^|\s)0(?:\s|$)/);
	});

	it("never trims the expanded agent when scroll indicators overflow", () => {
		const origRows = (process.stdout as { rows?: number }).rows;
		Object.defineProperty(process.stdout, "rows", {
			value: 10,
			configurable: true,
		});
		try {
			// 10 rows: expanded agent 0 (10 lines) + more-below indicator (1)
			// = 11 > 10 — trim would pop the expanded agent without protection.
			const s = state({
				focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 0 },
				expandedAgentIndex: 0,
				scrollOffset: 0,
			});
			const result = Board({ state: s }) as React.ReactElement;
			const children = renderedChildren(result);
			const agentNames = children
				.map((c: any) => c?.props?.agent?.name)
				.filter(Boolean);
			expect(agentNames).toContain("default");
		} finally {
			if (origRows !== undefined) {
				Object.defineProperty(process.stdout, "rows", {
					value: origRows,
					configurable: true,
				});
			} else {
				delete (process.stdout as { rows?: number }).rows;
			}
		}
	});
});
