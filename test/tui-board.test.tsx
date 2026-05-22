import React from "react";
import { describe, expect, it } from "vitest";
import { Board } from "../src/tui/components/Board.js";
import type { AgentConfigState, ConfigState, DiscoveredOptions } from "../src/tui/state/types.js";

const options: DiscoveredOptions = {
	tools: [],
	extensions: [],
	models: [],
	defaultModel: "",
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
		focus: { agentIndex: 0, fieldIndex: 0 },
		expandedAgentIndex: null,
		overlay: null,
		statuses: new Map(),
		scrollOffset: 0,
		globalError: null,
		...overrides,
	};
}

function renderedChildren(element: React.ReactElement): React.ReactNode[] {
	return React.Children.toArray(element.props.children);
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
				focus: { agentIndex: 0, fieldIndex: 0 },
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
				focus: { agentIndex: 0, fieldIndex: 0 },
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
