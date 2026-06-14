/**
 * Unit tests for MetadataStore.
 *
 * Tests the full MetadataStore interface directly, without needing live
 * Pi sessions or an LLM.
 *
 * Coverage:
 * - Sidecar path calculation
 * - Load / save with fallback for missing or corrupt files
 * - Selected Root agent persistence
 * - Concurrent Task allocation (record ID + human name under lock)
 * - Timestamp persistence (touchRecord, upsertRecord)
 * - Cleanup of Sub-agent session files
 * - Factory method (fromSessionManager)
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync as wfs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DebugLogger } from "../subagent/debug-logger.js";
import type { MetadataFile, MetadataStoreContext, SubagentRecord } from "../subagent/metadata.js";
import { MetadataStore } from "../subagent/metadata.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(dir: string, sessionId: string, sessionFile?: string): MetadataStoreContext {
	return {
		sessionDir: dir,
		sessionId,
		sessionFile: sessionFile ?? join(dir, `${sessionId}.jsonl`),
	};
}

function makeRecord(id: string, agentType: string = "scout"): SubagentRecord {
	return {
		id,
		humanName: "Tom",
		displayName: `scout Tom`,
		agentType,
		sessionFile: "/tmp/sub.jsonl",
		depth: 1,
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
	};
}

function makeSpyDebugLogger(sink: Array<{ event: string }>): DebugLogger {
	const create = (context: Record<string, unknown>): DebugLogger => ({
		isEnabled: true,
		child: (childContext) => create({ ...context, ...childContext }),
		log: (_level, event) => {
			sink.push({ event });
		},
		debug: (event) => create(context).log("debug", event),
		info: (event) => create(context).log("info", event),
		warn: (event) => create(context).log("warn", event),
		error: (event) => create(context).log("error", event),
	});

	return create({});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MetadataStore", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-metastore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});

	// ---- Path ----

	describe("path", () => {
		it("returns the correct sidecar path based on sessionId", () => {
			const store = new MetadataStore(makeCtx(tempDir, "abc123"));
			expect(store.path).toBe(join(tempDir, ".task-subagents-abc123.json"));
		});

		it("changes when sessionId changes", () => {
			const storeA = new MetadataStore(makeCtx(tempDir, "session-a"));
			const storeB = new MetadataStore(makeCtx(tempDir, "session-b"));
			expect(storeA.path).not.toBe(storeB.path);
			expect(storeA.path).toContain("session-a");
			expect(storeB.path).toContain("session-b");
		});
	});

	// ---- Load / Reload ----

	describe("load", () => {
		it("returns a clean MetadataFile when no file exists", () => {
			const store = new MetadataStore(makeCtx(tempDir, "fresh"));
			const meta = store.load();
			expect(meta.version).toBe(1);
			expect(meta.mainSessionId).toBe("fresh");
			expect(meta.records).toEqual([]);
		});

		it("reads back a previously saved file", () => {
			const store = new MetadataStore(makeCtx(tempDir, "saved"));
			const meta = store.load();
			meta.records.push(makeRecord("abcd1234"));
			store.save();

			const store2 = new MetadataStore(makeCtx(tempDir, "saved"));
			const meta2 = store2.load();
			expect(meta2.records).toHaveLength(1);
			expect(meta2.records[0].id).toBe("abcd1234");
		});

		it("returns cached metadata on repeated calls without re-reading", () => {
			const store = new MetadataStore(makeCtx(tempDir, "cached"));
			const meta1 = store.load();
			meta1.selectedMainAgent = "scout";

			// Modify on disk behind the store's back
			wfs(
				store.path,
				JSON.stringify({ version: 1, mainSessionId: "cached", records: [], selectedMainAgent: "worker" }),
				"utf-8",
			);

			// load() should still return cached copy (without selectedMainAgent)
			const meta2 = store.load();
			expect(meta2.selectedMainAgent).toBe("scout");
		});

		it("reload() ignores cache and re-reads from disk", () => {
			const store = new MetadataStore(makeCtx(tempDir, "reload-test"));
			const meta1 = store.load();
			meta1.selectedMainAgent = "scout";

			// Modify on disk
			wfs(
				store.path,
				JSON.stringify({ version: 1, mainSessionId: "reload-test", records: [], selectedMainAgent: "worker" }),
				"utf-8",
			);

			// reload() should re-read from disk
			const meta2 = store.reload();
			expect(meta2.selectedMainAgent).toBe("worker");
		});

		it("falls back to clean file for corrupt JSON", () => {
			const store = new MetadataStore(makeCtx(tempDir, "corrupt"));
			wfs(store.path, "not valid json {{{", "utf-8");
			const meta = store.load();
			expect(meta.version).toBe(1);
			expect(meta.records).toEqual([]);
		});

		it("falls back to clean file for wrong version", () => {
			const store = new MetadataStore(makeCtx(tempDir, "badver"));
			wfs(store.path, JSON.stringify({ version: 99, records: [] }), "utf-8");
			const meta = store.load();
			expect(meta.version).toBe(1);
			expect(meta.records).toEqual([]);
		});

		it("falls back to clean file for missing records array", () => {
			const store = new MetadataStore(makeCtx(tempDir, "norecs"));
			wfs(store.path, JSON.stringify({ version: 1 }), "utf-8");
			const meta = store.load();
			expect(meta.version).toBe(1);
			expect(meta.records).toEqual([]);
		});
	});

	// ---- Save ----

	describe("save", () => {
		it("writes pretty-printed JSON", () => {
			const store = new MetadataStore(makeCtx(tempDir, "pretty"));
			store.selectedMainAgent = "planner";
			const raw = readFileSync(store.path, "utf-8");
			expect(raw).toContain('"selectedMainAgent"');
			expect(raw).toContain('"planner"');
			expect(raw).toContain("\n  ");
		});

		it("save() writes mainSessionId and mainSessionFile from current context", () => {
			const ctx = makeCtx(tempDir, "my-session", join(tempDir, "my-session.jsonl"));
			const store = new MetadataStore(ctx);
			store.load();
			store.save();

			const raw = JSON.parse(readFileSync(store.path, "utf-8")) as MetadataFile;
			expect(raw.mainSessionId).toBe("my-session");
			expect(raw.mainSessionFile).toBe(join(tempDir, "my-session.jsonl"));
		});

		it("persists records so a new MetadataStore can read them", () => {
			const store1 = new MetadataStore(makeCtx(tempDir, "persist"));
			const meta1 = store1.load();
			meta1.records.push(makeRecord("11111111"));
			meta1.records.push(makeRecord("22222222"));
			store1.save();

			const store2 = new MetadataStore(makeCtx(tempDir, "persist"));
			const meta2 = store2.load();
			expect(meta2.records).toHaveLength(2);
			expect(meta2.records[0].id).toBe("11111111");
			expect(meta2.records[1].id).toBe("22222222");
		});

		it("round-trips terminal context usage", () => {
			const store1 = new MetadataStore(makeCtx(tempDir, "context-usage"));
			store1.upsertRecord({
				...makeRecord("ctx12345"),
				contextUsage: { tokens: 68234, contextWindow: 100000, percent: 68.234 },
			});

			const store2 = new MetadataStore(makeCtx(tempDir, "context-usage"));
			expect(store2.findRecord("ctx12345")?.contextUsage).toEqual({
				tokens: 68234,
				contextWindow: 100000,
				percent: 68.234,
			});
		});
	});

	// ---- Cleanup ----

	describe("cleanup", () => {
		it("deletes the metadata file and all sub-session files", () => {
			const subSessionFile = join(tempDir, "sub-agent.jsonl");
			const store = new MetadataStore(makeCtx(tempDir, "cleanme", join(tempDir, "main.jsonl")));
			const meta = store.load();
			meta.records.push({
				...makeRecord("aaaa0001"),
				sessionFile: subSessionFile,
			});
			store.save();

			// Create the sub-session file so cleanup can delete it
			wfs(subSessionFile, "[]", "utf-8");
			expect(existsSync(store.path)).toBe(true);
			expect(existsSync(subSessionFile)).toBe(true);

			store.cleanup();

			expect(existsSync(store.path)).toBe(false);
			expect(existsSync(subSessionFile)).toBe(false);
		});

		it("does not throw when no files exist", () => {
			const store = new MetadataStore(makeCtx(tempDir, "empty-clean"));
			expect(() => store.cleanup()).not.toThrow();
		});

		it("clears in-memory cache after cleanup", () => {
			const store = new MetadataStore(makeCtx(tempDir, "cache-clear"));
			store.load();
			store.selectedMainAgent = "reviewer";
			store.cleanup();

			// After cleanup, load should return a fresh empty file
			const meta = store.load();
			expect(meta.selectedMainAgent).toBeUndefined();
			expect(meta.records).toEqual([]);
		});

		it("survives when a sub-session file referenced in records doesn't exist", () => {
			const store = new MetadataStore(makeCtx(tempDir, "missing-subs"));
			const meta = store.load();
			meta.records.push({
				...makeRecord("deadbeef"),
				sessionFile: join(tempDir, "nonexistent.jsonl"),
			});
			store.save();

			expect(() => store.cleanup()).not.toThrow();
			expect(existsSync(store.path)).toBe(false);
		});
	});

	// ---- SelectedMainAgent ----

	describe("selectedMainAgent", () => {
		it("defaults to undefined", () => {
			const store = new MetadataStore(makeCtx(tempDir, "default-agent"));
			expect(store.selectedMainAgent).toBeUndefined();
		});

		it("persists the selected agent across store instances", () => {
			const store1 = new MetadataStore(makeCtx(tempDir, "agent-persist"));
			store1.selectedMainAgent = "scout";
			expect(store1.selectedMainAgent).toBe("scout");

			const store2 = new MetadataStore(makeCtx(tempDir, "agent-persist"));
			expect(store2.selectedMainAgent).toBe("scout");
		});

		it("can be set to undefined to clear selection", () => {
			const store = new MetadataStore(makeCtx(tempDir, "clear-agent"));
			store.selectedMainAgent = "planner";
			expect(store.selectedMainAgent).toBe("planner");

			store.selectedMainAgent = undefined;
			expect(store.selectedMainAgent).toBeUndefined();
		});

		it("auto-saves without needing an explicit save() call", () => {
			const store = new MetadataStore(makeCtx(tempDir, "auto-save"));
			store.selectedMainAgent = "worker";

			// Read the file directly
			const raw = JSON.parse(readFileSync(store.path, "utf-8")) as MetadataFile;
			expect(raw.selectedMainAgent).toBe("worker");
		});

		it("replaces previous value when set multiple times", () => {
			const store = new MetadataStore(makeCtx(tempDir, "replace-agent"));
			store.selectedMainAgent = "scout";
			store.selectedMainAgent = "planner";
			expect(store.selectedMainAgent).toBe("planner");

			const store2 = new MetadataStore(makeCtx(tempDir, "replace-agent"));
			expect(store2.selectedMainAgent).toBe("planner");
		});
	});

	// ---- Records ----

	describe("records", () => {
		it("returns the mutable records array", () => {
			const store = new MetadataStore(makeCtx(tempDir, "records-test"));
			expect(store.records).toEqual([]);
			store.load();
			store.records.push(makeRecord("00001111"));
			expect(store.records).toHaveLength(1);
		});

		it("findRecord finds record by ID", () => {
			const store = new MetadataStore(makeCtx(tempDir, "find-test"));
			const meta = store.load();
			meta.records.push(makeRecord("aaaa"));
			meta.records.push(makeRecord("bbbb"));
			store.save();

			expect(store.findRecord("aaaa")?.id).toBe("aaaa");
			expect(store.findRecord("bbbb")?.id).toBe("bbbb");
			expect(store.findRecord("cccc")).toBeUndefined();
		});
	});

	// ---- allocateRecord ----

	describe("allocateRecord", () => {
		it("returns a record with a unique 8-char hex ID", async () => {
			const store = new MetadataStore(makeCtx(tempDir, "alloc-id"));
			const record = await store.allocateRecord("scout");
			expect(record.id).toMatch(/^[0-9a-f]{8}$/);
		});

		it("returns a record with a human name from the pool", async () => {
			const store = new MetadataStore(makeCtx(tempDir, "alloc-name"));
			const record = await store.allocateRecord("scout");
			expect(record.humanName).toBe("Tom");
			expect(record.displayName).toBe("scout Tom");
		});

		it("persists the allocated record to disk immediately", async () => {
			const store = new MetadataStore(makeCtx(tempDir, "alloc-persist"));
			const record = await store.allocateRecord("worker");

			const store2 = new MetadataStore(makeCtx(tempDir, "alloc-persist"));
			expect(store2.records).toHaveLength(1);
			expect(store2.records[0].id).toBe(record.id);
		});

		it("sets correct depth and parentAgentId", async () => {
			const store = new MetadataStore(makeCtx(tempDir, "alloc-depth"));
			const record = await store.allocateRecord("planner", "parent-abc", 3);
			expect(record.depth).toBe(3);
			expect(record.parentAgentId).toBe("parent-abc");
			expect(record.agentType).toBe("planner");
		});

		it("defaults depth to 1 when not provided", async () => {
			const store = new MetadataStore(makeCtx(tempDir, "alloc-default-depth"));
			const record = await store.allocateRecord("reviewer");
			expect(record.depth).toBe(1);
		});

		it("sets timestamps on the allocated record", async () => {
			const store = new MetadataStore(makeCtx(tempDir, "alloc-ts"));
			const record = await store.allocateRecord("scout");
			expect(record.createdAt).toBeTruthy();
			expect(record.updatedAt).toBe(record.createdAt);
			const ts = new Date(record.createdAt).getTime();
			expect(ts).toBeGreaterThan(0);
		});

		it("allocates unique hex IDs across multiple calls", async () => {
			const store = new MetadataStore(makeCtx(tempDir, "alloc-unique"));
			const ids = new Set<string>();
			for (let i = 0; i < 20; i++) {
				const record = await store.allocateRecord("scout");
				expect(ids.has(record.id)).toBe(false);
				ids.add(record.id);
			}
			expect(ids.size).toBe(20);
		});

		it("allocates unique human names across multiple calls", async () => {
			const store = new MetadataStore(makeCtx(tempDir, "alloc-names"));
			const names = new Set<string>();
			for (let i = 0; i < 5; i++) {
				const record = await store.allocateRecord("scout");
				expect(names.has(record.humanName)).toBe(false);
				names.add(record.humanName);
			}
			// First 5 names from the pool: Tom, Ada, Max, Ivy, Leo
			expect(names.has("Tom")).toBe(true);
			expect(names.has("Ada")).toBe(true);
			expect(names.has("Max")).toBe(true);
		});

		it("serialises concurrent allocations without ID collision", async () => {
			// This is the core concurrent-safety test.
			// Multiple promises racing on allocateRecord must all get
			// unique IDs and names without duplicate-detection errors.
			const store = new MetadataStore(makeCtx(tempDir, "alloc-concurrent"));
			const allocs = Array.from({ length: 30 }, () => store.allocateRecord("scout"));
			const records = await Promise.all(allocs);

			const ids = new Set(records.map((r) => r.id));
			const names = new Set(records.map((r) => r.humanName));
			expect(ids.size).toBe(30);
			expect(names.size).toBe(30);
		});

		it("serialises concurrent allocations across the full name pool then falls back to numbered names", async () => {
			const store = new MetadataStore(makeCtx(tempDir, "alloc-full-pool"));
			// Allocate 31 items: 30 fill the pool, 1 overflows
			const allocs = Array.from({ length: 31 }, (_, i) => store.allocateRecord(i % 2 === 0 ? "scout" : "worker"));
			const records = await Promise.all(allocs);

			const ids = new Set(records.map((r) => r.id));
			const _names = new Set(records.map((r) => r.humanName));
			expect(ids.size).toBe(31);
			// Pool has 30 names; after exhausting pool, the 31st gets "Tom1"
			const tom1 = records.find((r) => r.humanName === "Tom1");
			expect(tom1).toBeDefined();
			expect(tom1!.displayName).toMatch(/^(scout|worker) Tom1$/);
		});
	});

	// ---- upsertRecord ----

	describe("upsertRecord", () => {
		it("adds a new record when it doesn't exist", () => {
			const store = new MetadataStore(makeCtx(tempDir, "upsert-add"));
			const record = makeRecord("new-id");
			store.upsertRecord(record);
			expect(store.records).toHaveLength(1);
			expect(store.records[0].id).toBe("new-id");
		});

		it("updates an existing record and preserves createdAt", () => {
			const store = new MetadataStore(makeCtx(tempDir, "upsert-update"));
			store.load();
			const original = makeRecord("existing-id");
			original.createdAt = "2023-01-01T00:00:00.000Z";
			original.sessionFile = "/old/path.jsonl";
			store.records.push(original);
			store.save();

			const updated: SubagentRecord = {
				...original,
				sessionFile: "/new/path.jsonl",
				updatedAt: "2024-06-01T00:00:00.000Z",
			};
			store.upsertRecord(updated);

			const stored = store.records[0];
			expect(stored.id).toBe("existing-id");
			expect(stored.sessionFile).toBe("/new/path.jsonl");
			// createdAt must never be overwritten
			expect(stored.createdAt).toBe("2023-01-01T00:00:00.000Z");
			expect(stored.updatedAt).toBe("2024-06-01T00:00:00.000Z");
		});

		it("persists changes immediately to disk", () => {
			const store = new MetadataStore(makeCtx(tempDir, "upsert-persist"));
			store.upsertRecord(makeRecord("immediate-persist"));

			const store2 = new MetadataStore(makeCtx(tempDir, "upsert-persist"));
			expect(store2.records).toHaveLength(1);
			expect(store2.records[0].id).toBe("immediate-persist");
		});
	});

	// ---- touchRecord ----

	describe("touchRecord", () => {
		it("updates updatedAt for an existing record", async () => {
			const store = new MetadataStore(makeCtx(tempDir, "touch-existing"));
			const record = await store.allocateRecord("scout");
			const originalTs = record.updatedAt;

			// Wait a tick so the new timestamp differs
			await new Promise((r) => setTimeout(r, 10));
			store.touchRecord(record.id);

			expect(record.updatedAt).not.toBe(originalTs);
			const newTs = new Date(record.updatedAt).getTime();
			expect(newTs).toBeGreaterThan(new Date(originalTs).getTime());
		});

		it("does nothing when the record ID doesn't exist", () => {
			const store = new MetadataStore(makeCtx(tempDir, "touch-missing"));
			expect(() => store.touchRecord("nonexistent")).not.toThrow();
		});

		it("persists the timestamp change to disk", async () => {
			const store = new MetadataStore(makeCtx(tempDir, "touch-persist"));
			const record = await store.allocateRecord("worker");
			await new Promise((r) => setTimeout(r, 10));
			store.touchRecord(record.id);

			const store2 = new MetadataStore(makeCtx(tempDir, "touch-persist"));
			const loaded = store2.findRecord(record.id)!;
			expect(loaded.updatedAt).toBe(record.updatedAt);
			expect(loaded.updatedAt).not.toBe(loaded.createdAt);
		});
	});

	// ---- fromSessionManager ----

	describe("fromSessionManager", () => {
		it("creates a MetadataStore from a session-manager-like object", () => {
			const sm = {
				getSessionDir: () => tempDir,
				getSessionId: () => "sm-test",
				getSessionFile: () => join(tempDir, "sm-test.jsonl"),
			};
			const store = MetadataStore.fromSessionManager(sm);
			expect(store.ctx.sessionDir).toBe(tempDir);
			expect(store.ctx.sessionId).toBe("sm-test");
			expect(store.ctx.sessionFile).toBe(join(tempDir, "sm-test.jsonl"));
		});

		it("accepts logger and emits debug breadcrumbs", async () => {
			const events: Array<{ event: string }> = [];
			const logger = makeSpyDebugLogger(events);
			const sm = {
				getSessionDir: () => tempDir,
				getSessionId: () => "sm-with-logger",
				getSessionFile: () => join(tempDir, "sm-with-logger.jsonl"),
			};
			const store = MetadataStore.fromSessionManager(sm, logger);
			store.load();
			const record = await store.allocateRecord("worker");
			store.touchRecord(record.id);
			expect(events.some((entry) => entry.event === "metadata_reload_start")).toBe(true);
			expect(events.some((entry) => entry.event === "metadata_allocate_start")).toBe(true);
			expect(events.some((entry) => entry.event === "metadata_allocate_done")).toBe(true);
			expect(events.some((entry) => entry.event === "metadata_record_touched")).toBe(true);
		});

		it("creates a working store that can load and save", () => {
			const sm = {
				getSessionDir: () => tempDir,
				getSessionId: () => "sm-working",
				getSessionFile: () => join(tempDir, "sm-working.jsonl"),
			};
			const store = MetadataStore.fromSessionManager(sm);
			store.selectedMainAgent = "scout";

			const store2 = MetadataStore.fromSessionManager(sm);
			expect(store2.selectedMainAgent).toBe("scout");
		});

		it("handles undefined sessionFile gracefully", () => {
			const sm = {
				getSessionDir: () => tempDir,
				getSessionId: () => "sm-no-file",
				getSessionFile: () => undefined,
			};
			const store = MetadataStore.fromSessionManager(sm);
			expect(store.ctx.sessionFile).toBeUndefined();
			// Should not throw on save
			store.selectedMainAgent = "reviewer";
			expect(existsSync(store.path)).toBe(true);
		});
	});
});
