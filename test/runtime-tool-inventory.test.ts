import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRuntimeToolInventory, recordRuntimeTools } from "../src/subagent/runtime-tool-inventory.js";
import { discoverCachedPiRuntimeResources } from "../src/tui/discovery/options.js";

const temporaryDirectories: string[] = [];

function temporaryAgentDir(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "runtime-tool-inventory-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("runtime tool inventory", () => {
	it("merges tools observed across real runtime sessions", () => {
		const agentDir = temporaryAgentDir();
		recordRuntimeTools(agentDir, ["read", "mcp_cached_tool"]);
		recordRuntimeTools(agentDir, ["another_runtime_tool", "mcp_cached_tool"]);

		expect(readRuntimeToolInventory(agentDir)).toEqual(["another_runtime_tool", "mcp_cached_tool", "read"]);
	});

	it("is included by cached TUI discovery without extension metadata", () => {
		const agentDir = temporaryAgentDir();
		recordRuntimeTools(agentDir, ["mcp_cached_tool"]);

		expect(discoverCachedPiRuntimeResources(agentDir).tools).toEqual(["mcp_cached_tool"]);
	});

	it("ignores malformed inventories", () => {
		const agentDir = temporaryAgentDir();
		writeFileSync(path.join(agentDir, "runtime-tools.json"), "not json");
		expect(readRuntimeToolInventory(agentDir)).toEqual([]);
	});
});
