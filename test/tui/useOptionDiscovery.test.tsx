import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "ink";
import type { DiscoveredModelsResult } from "../../src/tui/discovery/options.js";
import { useOptionDiscovery } from "../../src/tui/hooks/useOptionDiscovery.js";

interface DeferredModelResult {
	resolve: (value: DiscoveredModelsResult) => void;
	reject: (reason?: unknown) => void;
}

const pendingModelDiscoveries = vi.hoisted(
	() => [] as DeferredModelResult[],
);

const discoverModelsMock = vi.hoisted(() =>
	vi.fn<(_agentDir: string) => Promise<DiscoveredModelsResult>>((_agentDir) => {
		return new Promise<DiscoveredModelsResult>((resolve, reject) => {
			pendingModelDiscoveries.push({ resolve, reject });
		});
	}),
);

vi.mock("../../src/tui/discovery/options.js", async () => {
	const actual = await vi.importActual<typeof import("../../src/tui/discovery/options.js")>(
		"../../src/tui/discovery/options.js",
	);
	return {
		...actual,
		discoverModels: discoverModelsMock,
	};
});

interface ProbeFrame {
	status: "loading" | "ready" | "degraded";
	models: string[];
	loading: boolean;
	error: string | null;
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
		discoverModelsMock.mockClear();
	});

	afterEach(() => {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		fs.rmSync(tempAgentDir, { recursive: true, force: true });
	});

	it("ignores stale model discovery results from overlapping scans", async () => {
		const frames: ProbeFrame[] = [];
		const stdout = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const app = render(
			<OptionDiscoveryProbe
				triggerRescan={false}
				onFrame={(frame) => frames.push({ ...frame })}
			/>,
			{
				stdout: stdout as unknown as NodeJS.WriteStream,
				patchConsole: false,
			},
		);

		// Allow initial scan to start and trigger first model lookup.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(pendingModelDiscoveries).toHaveLength(1);

		// Trigger a rescan while first model lookup is still pending.
		app.rerender(
			<OptionDiscoveryProbe
				triggerRescan={true}
				onFrame={(frame) => frames.push({ ...frame })}
			/>,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(pendingModelDiscoveries).toHaveLength(2);

		const freshResult: DiscoveredModelsResult = {
			models: [{ provider: "fresh", modelId: "fresh", displayName: "fresh", canonicalRef: "" }],
			defaultModelDisplayName: "fresh",
			status: "ready",
		};
		const staleResult: DiscoveredModelsResult = {
			models: [{ provider: "stale", modelId: "stale", displayName: "stale", canonicalRef: "" }],
			defaultModelDisplayName: "stale",
			status: "ready",
		};

		// Fresh completion should win; stale completion from the first request must be ignored.
		pendingModelDiscoveries[1]?.resolve(freshResult);
		await new Promise((resolve) => setTimeout(resolve, 0));
		pendingModelDiscoveries[0]?.resolve(staleResult);
		await new Promise((resolve) => setTimeout(resolve, 0));

		app.unmount();

		const finalFrame = frames.at(-1);
		expect(finalFrame).toBeDefined();
		expect(finalFrame?.status).toBe("ready");
		expect(finalFrame?.models).toEqual(["fresh"]);
		expect(finalFrame?.models).not.toContain("stale");
	});
});
