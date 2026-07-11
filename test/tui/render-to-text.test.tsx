import { Writable } from "node:stream";
import { Box, render, Text } from "ink";
import type React from "react";
import { describe, expect, it } from "vitest";
import { Board } from "../../src/tui/components/Board.js";
import { HelpFooter } from "../../src/tui/components/HelpFooter.js";
import { StaleCleanupOverlay } from "../../src/tui/components/StaleCleanupOverlay.js";
import { renderToText } from "../../src/tui/dev/render-to-text.js";
import type { AgentConfigState, ConfigState, DiscoveredOptions } from "../../src/tui/state/types.js";

const options: DiscoveredOptions = {
	tools: ["read", "bash", "write", "edit", "grep", "find", "sed", "awk", "cat", "ls", "pwd"],
	extensions: [],
	models: [{ provider: "anthropic", modelId: "claude", displayName: "Claude", canonicalRef: "anthropic/claude" }],
	defaultModel: "Claude",
	modelDiscovery: {
		status: "ready" as const,
		error: null,
	},
	reasoningEfforts: ["low", "medium", "high", "maximum"],
	depths: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
	canSpawn: [],
	skills: [],
	promptParts: [],
};

function agent(name: string): AgentConfigState {
	return {
		name,
		description: `${name} description`,
		filePath: `/tmp/${name}.md`,
		frontmatter: {
			tools: ["read"],
			model: "anthropic/claude",
			depth: 0,
		},
		body: "",
		error: null,
		staleItems: {},
	};
}

function state(overrides: Partial<ConfigState> = {}): ConfigState {
	return {
		agents: [agent("default")],
		options,
		focus: { agentIndex: 0, fieldIndex: 0, optionItemIndex: 0 },
		expandedAgentIndex: 0,
		overlay: null,
		statuses: new Map(),
		scrollOffset: 0,
		optionColumnScrollOffset: 0,
		optionColumnItemOrder: null,
		optionColumnFilter: "",
		globalError: null,
		...overrides,
	};
}

class TtyCaptureStream extends Writable {
	columns: number;
	rows: number;
	isTTY = true;
	private readonly chunks: string[] = [];

	constructor({ columns, rows }: { columns: number; rows: number }) {
		super();
		this.columns = columns;
		this.rows = rows;
	}

	_write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
		this.chunks.push(String(chunk));
		callback();
	}

	toString() {
		return this.chunks.join("");
	}
}

function emulateTerminal(raw: string, rows: number, columns: number): string {
	let row = 0;
	let column = 0;
	let screen = Array.from({ length: rows }, () => Array(columns).fill(" "));

	const scroll = () => {
		screen.shift();
		screen.push(Array(columns).fill(" "));
		row = rows - 1;
	};
	const clearScreen = () => {
		screen = Array.from({ length: rows }, () => Array(columns).fill(" "));
	};
	const put = (char: string) => {
		if (char === "\r") {
			column = 0;
			return;
		}
		if (char === "\n") {
			column = 0;
			row++;
			if (row >= rows) scroll();
			return;
		}
		if (column >= columns) {
			column = 0;
			row++;
			if (row >= rows) scroll();
		}
		screen[row][column] = char;
		column++;
	};

	for (let i = 0; i < raw.length; i++) {
		const char = raw[i];
		if (char !== "\u001B") {
			put(char);
			continue;
		}
		if (raw[i + 1] !== "[") continue;

		let end = i + 2;
		while (end < raw.length && !/[A-Za-z~]/.test(raw[end])) end++;
		const final = raw[end];
		const params = raw.slice(i + 2, end);
		i = end;

		if (final === "m" || final === "h" || final === "l") continue;
		if (final === "H") {
			const [nextRow = 1, nextColumn = 1] = params.split(";").map((value) => Number(value) || 1);
			row = Math.max(0, Math.min(rows - 1, nextRow - 1));
			column = Math.max(0, Math.min(columns - 1, nextColumn - 1));
			continue;
		}
		if (final === "J") {
			if (params === "" || params === "2") clearScreen();
			continue;
		}
		if (final === "K") {
			const mode = params || "0";
			if (mode === "0") {
				for (let x = column; x < columns; x++) screen[row][x] = " ";
			} else if (mode === "2") {
				screen[row].fill(" ");
			}
			continue;
		}
		if (final === "G") {
			column = Math.max(0, Math.min(columns - 1, (Number(params) || 1) - 1));
			continue;
		}

		const amount = Number(params) || 1;
		if (final === "A") row = Math.max(0, row - amount);
		if (final === "B") row = Math.min(rows - 1, row + amount);
		if (final === "C") column = Math.min(columns - 1, column + amount);
		if (final === "D") column = Math.max(0, column - amount);
	}

	return screen
		.map((line) => line.join("").trimEnd())
		.join("\n")
		.trimEnd();
}

async function waitForInkRender(stdout: TtyCaptureStream, previousLength = 0): Promise<void> {
	if (process.env.CI) {
		await new Promise((resolve) => setTimeout(resolve, 30));
		return;
	}

	const deadline = Date.now() + 1000;
	while (Date.now() < deadline) {
		if (stdout.toString().length > previousLength) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function renderSequenceToTerminalText(
	elements: React.ReactNode[],
	{ columns, rows }: { columns: number; rows: number },
): Promise<string> {
	const stdout = new TtyCaptureStream({ columns, rows });
	const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
	const app = render(elements[0], {
		stdout: stdout as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});

	try {
		await waitForInkRender(stdout);
		for (const element of elements.slice(1)) {
			const previousLength = stdout.toString().length;
			app.rerender(element);
			await waitForInkRender(stdout, previousLength);
		}
		app.unmount();
		return emulateTerminal(stdout.toString().replace(/\n$/, ""), rows, columns);
	} finally {
		app.unmount();
		app.cleanup();
		if (rowsDescriptor) {
			Object.defineProperty(process.stdout, "rows", rowsDescriptor);
		} else {
			delete (process.stdout as { rows?: number }).rows;
		}
		if (columnsDescriptor) {
			Object.defineProperty(process.stdout, "columns", columnsDescriptor);
		} else {
			delete (process.stdout as { columns?: number }).columns;
		}
	}
}

describe("StaleCleanupOverlay", () => {
	it("renders stale cleanup confirmation prompt and missing values", async () => {
		const text = await renderToText(
			<Box width={80} height={12}>
				<StaleCleanupOverlay
					overlay={{
						type: "stale-cleanup",
						agentIndex: 0,
						agentName: "explorer",
						staleItems: {
							tools: ["deleted_tool"],
							extensions: ["missing-ext"],
							can_spawn: ["deleted-subagent"],
						},
					}}
				/>
			</Box>,
			{ columns: 80, rows: 12 },
		);

		expect(text).toContain("Stale config references found. Remove them?");
		expect(text).toContain("agent: explorer");
		expect(text).toContain("deleted_tool (missing)");
		expect(text).toContain("missing-ext (missing)");
		expect(text).toContain("subagents: deleted-subagent (missing)");
		expect(text).toContain("Enter/y: remove");
		expect(text).toContain("Esc/n: keep");
	});

	it("covers the board behind the centered confirmation popup", async () => {
		const text = await renderSequenceToTerminalText(
			[
				<Box key="board-with-stale-overlay" width={80} height={12}>
					<Board
						state={state({
							agents: [
								{
									...agent("default"),
									description: "default description",
								},
							],
						})}
						height={12}
					/>
					<StaleCleanupOverlay
						overlay={{
							type: "stale-cleanup",
							agentIndex: 0,
							agentName: "default",
							staleItems: {
								tools: ["deleted_tool"],
								extensions: ["missing-ext"],
								can_spawn: ["deleted-subagent"],
							},
						}}
					/>
				</Box>,
			],
			{ columns: 80, rows: 12 },
		);

		expect(text).toContain("Stale config references found. Remove them?");
		expect(text).toContain("┏");
		expect(text).toContain("☑ read");
		expect(text).not.toContain("Claude");
		const borderLine = text.split("\n").find((line) => line.includes("╔"));
		expect(borderLine?.indexOf("╔")).toBe(13);
	});
});

describe("renderToText", () => {
	it("captures Ink layout as plain text", async () => {
		const text = await renderToText(
			<Box borderStyle="single" paddingX={1}>
				<Text>Hello TUI</Text>
			</Box>,
			{ columns: 24, rows: 8 },
		);

		expect(text).toContain("Hello TUI");
		expect(text).toContain("┌");
		expect(text).not.toContain("\u001B[");
	});

	it("renders compact parse-error rows at board width", async () => {
		const brokenAgent = {
			...agent("broken"),
			error: "Invalid YAML: line: - 010-tools",
		};
		const text = await renderToText(
			<Board
				state={state({
					agents: [brokenAgent],
					expandedAgentIndex: null,
				})}
			/>,
			{ columns: 80, rows: 8 },
		);

		const nameLine = text.split("\n").find((line) => line.includes("broken"));
		expect(nameLine?.length).toBeGreaterThan(60);
		expect(text).toContain("Invalid YAML");
		expect(text).not.toContain("Edit the file manually");
	});

	it("captures expanded agent board columns for shell-visible diagnostics", async () => {
		const text = await renderToText(
			<Board
				state={state({
					focus: { agentIndex: 0, fieldIndex: 4, optionItemIndex: 10 },
					expandedAgentIndex: 0,
					optionColumnScrollOffset: 0,
				})}
			/>,
			{ columns: 120, rows: 30 },
		);

		expect(text).toContain("default — default description");
		expect(text).toContain("tools");
		expect(text).toContain("model");
		expect(text).toContain("←/→ columns");
	});

	it("keeps expanded-row save status and keyboard hint on one terminal line", async () => {
		const text = await renderToText(
			<Board
				state={state({
					agents: [
						{
							...agent("coder"),
							frontmatter: {
								...agent("coder").frontmatter,
								depth: 1,
								can_spawn: [],
							},
						},
						agent("explorer"),
					],
					options: {
						...options,
						canSpawn: ["coder", "explorer"],
					},
					focus: { agentIndex: 0, fieldIndex: 5, optionItemIndex: 0 },
					expandedAgentIndex: 0,
					optionColumnScrollOffset: 5,
					statuses: new Map([["/tmp/coder.md", { type: "saved", message: "Saved coder.md", timestamp: 1 }]]),
				})}
			/>,
			{ columns: 80, rows: 30 },
		);

		expect(text).toContain("Saved coder.md ·");
		expect(text).not.toMatch(/Saved\s*\n.*coder\.md/);
	});

	it("does not leave stale top rows after an expanded top agent frame redraws in a short terminal", async () => {
		const rows = 18;
		const columns = 80;
		const boardHeight = rows - 1; // HelpFooter occupies the final terminal row.
		const agents = ["coder", "explorer", "math", "planner", "reviewer"].map((name) => ({
			...agent(name),
			frontmatter: { depth: 1, can_spawn: ["explorer"] },
		}));
		const scenarioOptions = {
			...options,
			canSpawn: agents.map((candidate) => candidate.name),
		};
		const shell = (nextState: ConfigState) => (
			<Box flexDirection="column" height="100%" width="100%">
				<Box flexGrow={1} width="100%" overflow="hidden">
					<Board state={nextState} height={boardHeight} />
				</Box>
				<HelpFooter />
			</Box>
		);
		const makeState = (overrides: Partial<ConfigState>) =>
			state({
				agents,
				options: scenarioOptions,
				focus: { agentIndex: 0, fieldIndex: 2, optionItemIndex: 1 },
				expandedAgentIndex: null,
				optionColumnScrollOffset: 2,
				...overrides,
			});

		const finalScreen = await renderSequenceToTerminalText(
			[
				shell(makeState({ expandedAgentIndex: 0 })),
				shell(makeState({ expandedAgentIndex: null })),
				shell(
					makeState({
						focus: { agentIndex: 1, fieldIndex: 2, optionItemIndex: 1 },
						expandedAgentIndex: null,
					}),
				),
			],
			{ columns, rows },
		);

		expect(finalScreen).toContain("│ coder");
		expect(finalScreen).toContain("┃ explorer");
		expect(finalScreen).toContain("↑↓ nav agents");
		if (!process.env.CI) {
			expect(finalScreen.split("\n")[0]).toContain("┌");
		}
	});

	it("keeps long option names from wrapping over option-column headers", async () => {
		const text = await renderToText(
			<Board
				state={state({
					focus: { agentIndex: 0, fieldIndex: 7, optionItemIndex: 2 },
					expandedAgentIndex: 0,
					optionColumnScrollOffset: 5,
					agents: [
						{
							...agent("default"),
							frontmatter: {
								...agent("default").frontmatter,
								prompt_parts: ["010-tools", "020-runtime-context"],
							},
						},
					],
					options: {
						...options,
						canSpawn: ["explorer", "reviewer", "planner"],
						skills: ["typescript", "testing"],
						promptParts: ["010-tools", "020-runtime-context", "030-project-guidelines"],
					},
				})}
			/>,
			{ columns: 120, rows: 30 },
		);

		expect(text).toContain("prompt_parts");
		expect(text).toContain("030-project-guidelines");
	});

	it("keeps unfocused option-column item windows stable when focus moves to a far-away column item", async () => {
		const text = await renderToText(
			<Board
				state={state({
					focus: { agentIndex: 0, fieldIndex: 2, optionItemIndex: 10 },
					expandedAgentIndex: 0,
					optionColumnScrollOffset: 0,
					options: {
						...options,
						models: [
							{ provider: "p", modelId: "m0", displayName: "model-0", canonicalRef: "m0" },
							{ provider: "p", modelId: "m1", displayName: "model-1", canonicalRef: "m1" },
							{ provider: "p", modelId: "m2", displayName: "model-2", canonicalRef: "m2" },
							{ provider: "p", modelId: "m3", displayName: "model-3", canonicalRef: "m3" },
							{ provider: "p", modelId: "m4", displayName: "model-4", canonicalRef: "m4" },
							{ provider: "p", modelId: "m5", displayName: "model-5", canonicalRef: "m5" },
							{ provider: "p", modelId: "m6", displayName: "model-6", canonicalRef: "m6" },
							{ provider: "p", modelId: "m7", displayName: "model-7", canonicalRef: "m7" },
							{ provider: "p", modelId: "m8", displayName: "model-8", canonicalRef: "m8" },
							{ provider: "p", modelId: "m9", displayName: "model-9", canonicalRef: "m9" },
							{ provider: "p", modelId: "m10", displayName: "model-10", canonicalRef: "m10" },
						],
					},
				})}
			/>,
			{ columns: 120, rows: 30 },
		);

		expect(text).toContain("model-10");
		expect(text).toContain("☑ read");
		expect(text).toContain("☐ write");
		expect(text).not.toContain("☐ cat");
	});
});
