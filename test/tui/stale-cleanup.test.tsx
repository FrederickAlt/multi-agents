import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { render } from "ink";
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConfig } from "../../src/tui/hooks/useConfig.js";
import type { AgentConfigState, DiscoveredOptions } from "../../src/tui/state/types.js";

const discoveryMock = vi.hoisted(() => ({
	agents: [] as AgentConfigState[],
	options: null as DiscoveredOptions | null,
	loading: false,
	error: null as string | null,
	rescan: vi.fn(async () => undefined),
}));

vi.mock("../../src/tui/hooks/useOptionDiscovery.js", () => ({
	useOptionDiscovery: () => ({
		agents: discoveryMock.agents,
		options: discoveryMock.options,
		loading: discoveryMock.loading,
		error: discoveryMock.error,
		rescan: discoveryMock.rescan,
	}),
}));

type ConfigHandle = ReturnType<typeof useConfig>;

function makeOptions(overrides: Partial<DiscoveredOptions> = {}): DiscoveredOptions {
	return {
		tools: ["read", "bash"],
		toolExtensionNames: {},
		extensions: ["ext-a"],
		models: [],
		defaultModel: "",
		modelDiscovery: { status: "ready" as const, error: null },
		reasoningEfforts: ["low", "medium", "high", "maximum"],
		depths: [0, 1, 2, 3, 4, 5],
		canSpawn: ["helper", "agent"],
		skills: [],
		promptParts: [],
		...overrides,
	};
}

function ConfigProbe({ onFrame }: { onFrame: (config: ConfigHandle) => void }) {
	const config = useConfig();
	React.useEffect(() => {
		onFrame(config);
	});
	return null;
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("stale cleanup confirmation", () => {
	let tempDir: string;
	let app: ReturnType<typeof render> | null;
	let latest: ConfigHandle | null;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(tmpdir(), "pi-stale-cleanup-test-"));
		app = null;
		latest = null;
		discoveryMock.options = makeOptions();
		discoveryMock.loading = false;
		discoveryMock.error = null;
		discoveryMock.rescan.mockClear();
	});

	afterEach(() => {
		app?.unmount();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeAgent(): string {
		const filePath = path.join(tempDir, "agent.md");
		fs.writeFileSync(
			filePath,
			[
				"---",
				"description: test",
				"tools:",
				"  - read",
				"  - deleted_tool",
				"extensions:",
				"  - ext-a",
				"  - missing-ext",
				"can_spawn:",
				"  - helper",
				"  - deleted-agent",
				"---",
				"body",
			].join("\n"),
		);
		return filePath;
	}

	async function renderConfig(agent: AgentConfigState) {
		discoveryMock.agents = [agent];
		const stdout = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		app = render(
			<ConfigProbe
				onFrame={(config) => {
					latest = config;
				}}
			/>,
			{
				stdout: stdout as unknown as NodeJS.WriteStream,
				patchConsole: false,
			},
		);
		await flush();
	}

	function makeStaleAgent(filePath: string): AgentConfigState {
		return {
			name: "agent",
			description: "test",
			filePath,
			frontmatter: {
				description: "test",
				tools: ["read", "deleted_tool"],
				extensions: ["ext-a", "missing-ext"],
				can_spawn: ["helper", "deleted-agent"],
			},
			body: "body",
			error: null,
			staleItems: {
				tools: ["deleted_tool"],
				extensions: ["missing-ext"],
				can_spawn: ["deleted-agent"],
			},
		};
	}

	it("updates local stale items when discovery finishes after initial render", async () => {
		const filePath = writeAgent();
		await renderConfig({ ...makeStaleAgent(filePath), staleItems: {} });
		expect(latest!.state.agents[0].staleItems).toEqual({});

		discoveryMock.agents = [makeStaleAgent(filePath)];
		act(() => {
			app!.rerender(
				<ConfigProbe
					onFrame={(config) => {
						latest = config;
					}}
				/>,
			);
		});
		await flush();
		await flush();

		expect(latest!.state.agents[0].staleItems.tools).toEqual(["deleted_tool"]);
		expect(latest!.state.agents[0].staleItems.extensions).toEqual(["missing-ext"]);
		expect(latest!.state.agents[0].staleItems.can_spawn).toEqual(["deleted-agent"]);
	});

	it("confirming stale cleanup removes stale tools, extensions, and can_spawn values, saves, and expands", async () => {
		const filePath = writeAgent();
		await renderConfig(makeStaleAgent(filePath));

		act(() => latest!.expand());
		expect(latest!.state.overlay?.type).toBe("stale-cleanup");

		act(() => latest!.confirmStaleCleanup());
		await flush();

		const content = fs.readFileSync(filePath, "utf-8");
		expect(content).toContain("  - read");
		expect(content).toContain("  - ext-a");
		expect(content).toContain("  - helper");
		expect(content).not.toContain("deleted_tool");
		expect(content).not.toContain("missing-ext");
		expect(content).not.toContain("deleted-agent");
		expect(latest!.state.expandedAgentIndex).toBe(0);
		expect(latest!.state.agents[0].staleItems.tools).toBeUndefined();
		expect(latest!.state.agents[0].staleItems.extensions).toBeUndefined();
		expect(latest!.state.agents[0].staleItems.can_spawn).toBeUndefined();
	});

	it("declining stale cleanup leaves the file unchanged and still expands", async () => {
		const filePath = writeAgent();
		const original = fs.readFileSync(filePath, "utf-8");
		await renderConfig(makeStaleAgent(filePath));

		act(() => latest!.expand());
		expect(latest!.state.overlay?.type).toBe("stale-cleanup");

		act(() => latest!.skipStaleCleanup());
		await flush();

		expect(fs.readFileSync(filePath, "utf-8")).toBe(original);
		expect(latest!.state.expandedAgentIndex).toBe(0);
		expect(latest!.state.agents[0].staleItems.tools).toEqual(["deleted_tool"]);
		expect(latest!.state.agents[0].staleItems.extensions).toEqual(["missing-ext"]);
		expect(latest!.state.agents[0].staleItems.can_spawn).toEqual(["deleted-agent"]);
	});
});
