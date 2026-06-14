import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { render } from "ink";
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredModelsResult, PiRuntimeDiscovery } from "../../src/tui/discovery/options.js";
import { useOptionDiscovery } from "../../src/tui/hooks/useOptionDiscovery.js";
import type { ModelDiscoveryState } from "../../src/tui/state/types.js";

interface DeferredModelResult {
	resolve: (value: DiscoveredModelsResult) => void;
	reject: (reason?: unknown) => void;
}

interface DeferredRuntimeResult {
	resolve: (value: PiRuntimeDiscovery | undefined) => void;
	reject: (reason?: unknown) => void;
}

const pendingModelDiscoveries = vi.hoisted(() => [] as DeferredModelResult[]);
const pendingRuntimeDiscoveries = vi.hoisted(() => [] as DeferredRuntimeResult[]);

const discoverModelsMock = vi.hoisted(() =>
	vi.fn<(_agentDir: string) => Promise<DiscoveredModelsResult>>((_agentDir) => {
		return new Promise<DiscoveredModelsResult>((resolve, reject) => {
			pendingModelDiscoveries.push({ resolve, reject });
		});
	}),
);

const discoverPiRuntimeResourcesMock = vi.hoisted(() =>
	vi.fn<(_agentDir: string, _toolLists: string[][]) => Promise<PiRuntimeDiscovery | undefined>>(async () => undefined),
);

vi.mock("../../src/tui/discovery/options.js", async () => {
	const actual = await vi.importActual<typeof import("../../src/tui/discovery/options.js")>(
		"../../src/tui/discovery/options.js",
	);
	return {
		...actual,
		discoverModels: discoverModelsMock,
		discoverPiRuntimeResources: discoverPiRuntimeResourcesMock,
	};
});

interface ProbeFrame {
	status: ModelDiscoveryState["status"];
	models: string[];
	loading: boolean;
	error: string | null;
	tools: string[];
	staleTools: string[];
}

function OptionDiscoveryProbe({
	triggerRescan,
	onFrame,
}: {
	triggerRescan: boolean;
	onFrame: (frame: ProbeFrame) => void;
}) {
	const discovery = useOptionDiscovery();
	const didRescan = React.useRef(false);

	onFrame({
		status: discovery.options.modelDiscovery.status,
		models: discovery.options.models.map((model) => model.displayName),
		loading: discovery.loading,
		error: discovery.error,
		tools: discovery.options.tools,
		staleTools: discovery.agents[0]?.staleItems.tools ?? [],
	});

	React.useEffect(() => {
		if (triggerRescan && !didRescan.current) {
			didRescan.current = true;
			discovery.rescan();
		}
	}, [triggerRescan, discovery.rescan]);

	return null;
}

describe("useOptionDiscovery", () => {
	let originalAgentDir: string | undefined;
	let tempAgentDir: string;

	beforeEach(() => {
		tempAgentDir = fs.mkdtempSync(path.join(tmpdir(), "pi-agent-config-test-"));
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tempAgentDir;
		pendingModelDiscoveries.length = 0;
		pendingRuntimeDiscoveries.length = 0;
		discoverModelsMock.mockClear();
		discoverPiRuntimeResourcesMock.mockClear();
	});

	afterEach(() => {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		fs.rmSync(tempAgentDir, { recursive: true, force: true });
	});

	it("detects agent-declared tools that are not discovered as stale", async () => {
		fs.mkdirSync(path.join(tempAgentDir, "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(tempAgentDir, "agents", "coder.md"),
			["---", "description: coder", "tools:", "  - read", "  - deleted_tool", "---", "body"].join("\n"),
		);
		const frames: ProbeFrame[] = [];
		const stdout = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const flush = async () => {
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		};

		let app: ReturnType<typeof render> | null = null;
		try {
			app = render(<OptionDiscoveryProbe triggerRescan={false} onFrame={(frame) => frames.push({ ...frame })} />, {
				stdout: stdout as unknown as NodeJS.WriteStream,
				patchConsole: false,
			});
			await flush();
			await flush();

			const finalFrame = frames.at(-1);
			expect(finalFrame).toBeDefined();
			expect(finalFrame?.tools).toContain("read");
			expect(finalFrame?.tools).not.toContain("deleted_tool");
			expect(finalFrame?.staleTools).toEqual(["deleted_tool"]);
		} finally {
			app?.unmount();
		}
	});

	it("does not mark runtime-provided tools stale while runtime discovery is pending", async () => {
		discoverPiRuntimeResourcesMock.mockImplementationOnce(() => {
			return new Promise<PiRuntimeDiscovery | undefined>((resolve, reject) => {
				pendingRuntimeDiscoveries.push({ resolve, reject });
			});
		});
		fs.mkdirSync(path.join(tempAgentDir, "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(tempAgentDir, "agents", "coder.md"),
			["---", "description: coder", "tools:", "  - read", "  - runtime_tool", "---", "body"].join("\n"),
		);
		const frames: ProbeFrame[] = [];
		const stdout = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const flush = async () => {
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		};

		let app: ReturnType<typeof render> | null = null;
		try {
			app = render(<OptionDiscoveryProbe triggerRescan={false} onFrame={(frame) => frames.push({ ...frame })} />, {
				stdout: stdout as unknown as NodeJS.WriteStream,
				patchConsole: false,
			});
			await flush();

			const initialLoadedFrame = frames.find((frame) => !frame.loading);
			expect(initialLoadedFrame).toBeDefined();
			expect(initialLoadedFrame?.tools).not.toContain("runtime_tool");
			expect(initialLoadedFrame?.staleTools).toEqual([]);

			pendingRuntimeDiscoveries[0]?.resolve({
				tools: ["read", "runtime_tool"],
				toolExtensionNames: {},
				extensions: [],
				skills: [],
			});
			await flush();

			const finalFrame = frames.at(-1);
			expect(finalFrame?.tools).toContain("runtime_tool");
			expect(finalFrame?.staleTools).toEqual([]);
		} finally {
			app?.unmount();
		}
	});

	it("ignores stale model discovery results from overlapping scans", async () => {
		const frames: ProbeFrame[] = [];
		const stdout = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const flush = async () => {
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		};

		let app: ReturnType<typeof render> | null = null;
		try {
			app = render(<OptionDiscoveryProbe triggerRescan={false} onFrame={(frame) => frames.push({ ...frame })} />, {
				stdout: stdout as unknown as NodeJS.WriteStream,
				patchConsole: false,
			});

			// Allow initial scan to start and trigger first model lookup.
			await flush();
			expect(pendingModelDiscoveries).toHaveLength(1);

			// Trigger a rescan while first model lookup is still pending.
			app.rerender(<OptionDiscoveryProbe triggerRescan={true} onFrame={(frame) => frames.push({ ...frame })} />);
			await flush();
			expect(pendingModelDiscoveries).toHaveLength(2);

			const freshResult: DiscoveredModelsResult = {
				models: [{ provider: "fresh", modelId: "fresh", displayName: "fresh", canonicalRef: "" }],
				defaultModelDisplayName: "fresh",
				status: "ready" as const,
			};
			const staleResult: DiscoveredModelsResult = {
				models: [{ provider: "stale", modelId: "stale", displayName: "stale", canonicalRef: "" }],
				defaultModelDisplayName: "stale",
				status: "ready" as const,
			};

			// Fresh completion should win; stale completion from the first request must be ignored.
			pendingModelDiscoveries[1]?.resolve(freshResult);
			await flush();
			pendingModelDiscoveries[0]?.resolve(staleResult);
			await flush();

			const finalFrame = frames.at(-1);
			expect(finalFrame).toBeDefined();
			expect(finalFrame?.status).toBe("ready");
			expect(finalFrame?.models).toEqual(["fresh"]);
			expect(finalFrame?.models).not.toContain("stale");
		} finally {
			app?.unmount();
		}
	});
});
