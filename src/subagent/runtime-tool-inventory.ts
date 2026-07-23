import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const RUNTIME_TOOL_INVENTORY_FILE = "runtime-tools.json";
const RUNTIME_TOOL_INVENTORY_VERSION = 1;

interface RuntimeToolInventoryFile {
	version?: number;
	updatedAt?: string;
	tools?: Record<string, { lastSeen?: unknown }>;
}

function inventoryPath(agentDir: string): string {
	return path.join(agentDir, RUNTIME_TOOL_INVENTORY_FILE);
}

/** Read tool names observed in a real Pi runtime. Invalid or missing inventories are ignored. */
export function readRuntimeToolInventory(agentDir: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(inventoryPath(agentDir), "utf8")) as RuntimeToolInventoryFile;
		if (parsed?.version !== RUNTIME_TOOL_INVENTORY_VERSION || !parsed.tools || typeof parsed.tools !== "object") {
			return [];
		}
		return Object.keys(parsed.tools).filter(Boolean).sort();
	} catch {
		return [];
	}
}

/**
 * Merge tools observed by an actual Pi session into the persistent inventory.
 * Writes are best-effort because failure to cache discovery must not affect a run.
 */
export function recordRuntimeTools(agentDir: string, toolNames: Iterable<string>): void {
	const observed = [...new Set([...toolNames].map((name) => name.trim()).filter(Boolean))];
	if (observed.length === 0) return;

	const now = new Date().toISOString();
	const tools: Record<string, { lastSeen: string }> = {};
	for (const name of readRuntimeToolInventory(agentDir)) tools[name] = { lastSeen: now };
	for (const name of observed) tools[name] = { lastSeen: now };

	const target = inventoryPath(agentDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			temporary,
			`${JSON.stringify({ version: RUNTIME_TOOL_INVENTORY_VERSION, updatedAt: now, tools }, null, 2)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		renameSync(temporary, target);
	} catch {
		try {
			unlinkSync(temporary);
		} catch {
			// Best-effort cleanup.
		}
	}
}
