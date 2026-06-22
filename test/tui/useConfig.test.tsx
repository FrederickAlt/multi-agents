import { render } from "ink";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { computeInlineCheckboxSaveValue, useConfig } from "../../src/tui/hooks/useConfig.js";
import type { AgentConfigState, DiscoveredOptions } from "../../src/tui/state/types.js";

const writeFieldToFileMock = vi.hoisted(() => vi.fn());
const useOptionDiscoveryMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/tui/file-io/write-agent.js", () => ({
	writeFieldToFile: writeFieldToFileMock,
}));

vi.mock("../../src/tui/hooks/useOptionDiscovery.js", () => ({
	useOptionDiscovery: useOptionDiscoveryMock,
}));

function makeAgent(overrides: Partial<AgentConfigState> = {}): AgentConfigState {
	return {
		name: "agent-a",
		description: "A test agent",
		filePath: "/tmp/agent-a.md",
		frontmatter: { description: "A test agent" },
		body: "",
		error: null,
		staleItems: {},
		...overrides,
	};
}

function makeOptions(overrides: Partial<DiscoveredOptions> = {}): DiscoveredOptions {
	return {
		tools: ["read", "bash", "write"],
		extensions: [],
		models: [],
		defaultModel: "",
		modelDiscovery: { status: "ready" as const, error: null },
		reasoningEfforts: ["low", "medium", "high", "maximum"],
		depths: [0, 1, 2, 3, 4, 5],
		canSpawn: ["agent-a", "agent-b", "agent-c"],
		skills: [],
		promptParts: [],
		...overrides,
	};
}

function flush(): Promise<void> {
	return act(async () => {
		await Promise.resolve();
	});
}

describe("computeInlineCheckboxSaveValue", () => {
	it("includes current agent when saving inline can_spawn values", () => {
		const options = makeOptions();
		const agent = makeAgent({
			name: "agent-a",
			frontmatter: { description: "A test agent", depth: 1 },
		});

		const result = computeInlineCheckboxSaveValue(options, agent, "can_spawn", "agent-b");

		// Missing can_spawn is implicit (all available, including self), then toggling
		// removes agent-b and keeps an explicit save value.
		expect(result).toEqual(["agent-a", "agent-c"]);
	});

	it("keeps explicit stale checkbox values when toggling inline can_spawn selections", () => {
		const options = makeOptions();
		const agent = makeAgent({
			name: "agent-a",
			frontmatter: {
				description: "A test agent",
				depth: 1,
				can_spawn: ["agent-b", "legacy-agent"],
			},
		});

		const result = computeInlineCheckboxSaveValue(options, agent, "can_spawn", "agent-c");

		expect(result).toEqual(["agent-b", "legacy-agent", "agent-c"]);
	});

	it("keeps self in explicit can_spawn selections when computing save value", () => {
		const options = makeOptions();
		const agent = makeAgent({
			name: "agent-a",
			frontmatter: {
				description: "A test agent",
				depth: 1,
				can_spawn: ["agent-a", "agent-b"],
			},
		});

		const result = computeInlineCheckboxSaveValue(options, agent, "can_spawn", "agent-b");

		expect(result).toEqual(["agent-a"]);
	});
});

describe("useConfig", () => {
	it("preserves implicit extension overlay save as undefined", async () => {
		writeFieldToFileMock.mockReset();
		writeFieldToFileMock.mockReturnValue({ success: true });

		useOptionDiscoveryMock.mockReturnValue({
			options: makeOptions({
				extensions: ["summarize"],
				extensionAliases: {
					summarize: ["/tmp/extensions/summarize/dist/index.ts", "dist", "index.ts", "summarize"],
				},
			}),
			agents: [makeAgent({ frontmatter: { description: "A test agent" } })],
			loading: false,
			error: null,
			rescan: async () => undefined,
		});

		const apiRef = { current: undefined as ReturnType<typeof useConfig> | undefined };
		const Probe = () => {
			const api = useConfig();
			apiRef.current = api;
			return null;
		};

		const app = render(<Probe />, { patchConsole: false });
		await flush();

		await act(async () => {
			apiRef.current?.openOverlay(0, "extensions");
		});
		await flush();

		// Toggle off and back on to move implicit->explicit-empty->implicit.
		await act(async () => {
			apiRef.current?.instantSaveCheckbox("summarize");
		});
		await flush();
		await act(async () => {
			apiRef.current?.instantSaveCheckbox("summarize");
		});
		await flush();

		app.unmount();

		expect(writeFieldToFileMock).toHaveBeenCalledTimes(2);
		expect(writeFieldToFileMock.mock.calls[0]?.[1]).toBe("extensions");
		expect(writeFieldToFileMock.mock.calls[0]?.[2]).toEqual([]);
		expect(writeFieldToFileMock.mock.calls[1]?.[1]).toBe("extensions");
		expect(writeFieldToFileMock.mock.calls[1]?.[2]).toBeUndefined();
	});

	it("maps legacy extension selectors when opening overlay and writes deduped values on toggle", async () => {
		writeFieldToFileMock.mockReset();
		writeFieldToFileMock.mockReturnValue({ success: true });

		useOptionDiscoveryMock.mockReturnValue({
			options: makeOptions({
				extensions: ["summarize"],
				extensionAliases: {
					summarize: [
						"/tmp/extensions/summarize/dist/index.ts",
						"dist",
						"pi-tool-summarize-replacement",
						"summarize",
					],
				},
			}),
			agents: [
				makeAgent({
					frontmatter: {
						description: "A test agent",
						extensions: ["pi-tool-summarize-replacement"],
					},
				}),
			],
			loading: false,
			error: null,
			rescan: async () => undefined,
		});

		const apiRef = { current: undefined as ReturnType<typeof useConfig> | undefined };
		const Probe = () => {
			const api = useConfig();
			apiRef.current = api;
			return null;
		};

		const app = render(<Probe />, { patchConsole: false });
		await flush();

		await act(async () => {
			apiRef.current?.openOverlay(0, "extensions");
		});
		await flush();

		const overlay = apiRef.current?.state.overlay;
		if (!overlay || overlay.type !== "checkbox") {
			throw new Error("Expected checkbox overlay");
		}
		expect(overlay.type).toBe("checkbox");
		expect(overlay.wasImplicit).toBe(false);
		expect(overlay.localSelection).toEqual(["summarize"]);

		await act(async () => {
			apiRef.current?.instantSaveCheckbox("summarize");
		});
		await flush();
		await act(async () => {
			apiRef.current?.instantSaveCheckbox("summarize");
		});
		await flush();

		app.unmount();

		expect(writeFieldToFileMock).toHaveBeenCalledTimes(2);
		expect(writeFieldToFileMock.mock.calls[0]?.[2]).toEqual([]);
		expect(writeFieldToFileMock.mock.calls[1]?.[2]).toBeUndefined();
	});
});
