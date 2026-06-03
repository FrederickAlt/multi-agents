/**
 * MetadataStore — owns the Metadata sidecar lifecycle.
 *
 * Responsibilities:
 * - Sidecar path calculation
 * - Load / save with fallback for missing or corrupt files
 * - Selected Root agent persistence
 * - Concurrent-safe Sub-agent record allocation (hex ID + human name)
 * - Timestamp persistence
 * - Cleanup of Sub-agent session files when the Root agent session is replaced
 *
 * The class is designed to be testable without live Pi sessions or an LLM.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { makeNoopDebugLogger, type DebugLogger } from "./debug-logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEX_ID_BYTES = 4;

const HUMAN_NAMES = [
	"Tom", "Ada", "Max", "Ivy", "Leo", "Nora", "Sam", "Mia", "Eli", "Zoe",
	"Kai", "Ava", "Ben", "Lia", "Gus", "Nia", "Ray", "Uma", "Jan", "Eva",
	"Sol", "Kim", "Ari", "Liv", "Cal", "Bea", "Ned", "Pia", "Ren", "Tess",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TerminalOutcome = "completed" | "crashed" | "timed_out" | "aborted" | "abort_request_failed";

export interface SubagentRecord {
	id: string;
	humanName: string;
	displayName: string;
	agentType: string;
	sessionFile: string;
	parentAgentId?: string;
	depth: number;
	createdAt: string;
	updatedAt: string;
	terminalOutcome?: TerminalOutcome;
	terminalError?: string;
	abortReason?: string;
	terminalAt?: string;
}

export interface MetadataFile {
	version: 1;
	mainSessionId: string;
	mainSessionFile?: string;
	selectedMainAgent?: string;
	records: SubagentRecord[];
}

export interface MetadataStoreContext {
	sessionDir: string;
	sessionId: string;
	sessionFile?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Generate an 8-character hex ID not present in `existing`.
 * Throws if 1000 attempts are exhausted (effectively impossible with 4-byte space).
 */
export function randomHexId(existing: Set<string>): string {
	for (let attempt = 0; attempt < 1000; attempt++) {
		const id = Array.from(randomBytes(HEX_ID_BYTES))
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		if (!existing.has(id)) return id;
	}
	throw new Error("Could not allocate a unique sub-agent ID.");
}

/**
 * Pick an unused human name from the built-in pool for a given agent type.
 * Falls back to numbered variants (Tom1, Tom2, …) when the pool is exhausted.
 */
export function pickHumanName(agentName: string, records: SubagentRecord[]): { humanName: string; displayName: string } {
	const used = new Set(records.map((r) => r.humanName));
	for (const name of HUMAN_NAMES) {
		if (!used.has(name)) return { humanName: name, displayName: `${agentName} ${name}` };
	}
	for (let i = 1; ; i++) {
		for (const base of HUMAN_NAMES) {
			const name = `${base}${i}`;
			if (!used.has(name)) return { humanName: name, displayName: `${agentName} ${name}` };
		}
	}
}

// ---------------------------------------------------------------------------
// MetadataStore
// ---------------------------------------------------------------------------

export class MetadataStore {
	private static pathLocks = new Map<string, Promise<void>>();
	private _metadata: MetadataFile | null = null;
	private readonly logger: DebugLogger;

	constructor(public readonly ctx: MetadataStoreContext, logger?: DebugLogger) {
		this.logger = logger ?? makeNoopDebugLogger();
	}

	private async withPathLock<T>(fn: () => T | Promise<T>): Promise<T> {
		const previous = MetadataStore.pathLocks.get(this.path) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
		const tail = previous.catch(() => undefined).then(() => current);
		MetadataStore.pathLocks.set(this.path, tail);
		await previous.catch(() => undefined);
		this.logger.debug("metadata_path_lock_acquired", { path: this.path });
		try {
			return await fn();
		} finally {
			release();
			if (MetadataStore.pathLocks.get(this.path) === tail) {
				MetadataStore.pathLocks.delete(this.path);
			}
			this.logger.debug("metadata_path_lock_released", { path: this.path });
		}
	}

	// ---- Path ----

	/** Absolute path to the metadata sidecar JSON file. */
	get path(): string {
		return path.join(this.ctx.sessionDir, `.task-subagents-${this.ctx.sessionId}.json`);
	}

	// ---- Load / Save / Reload ----

	/**
	 * Return the cached metadata, loading from disk on first access.
	 * Falls back to a clean MetadataFile if the file is missing or corrupt.
	 */
	load(): MetadataFile {
		if (this._metadata) return this._metadata;
		return this.reload();
	}

	/**
	 * Force a re-read from disk, ignoring the in-memory cache.
	 * Returns a clean MetadataFile if the file is missing or corrupt.
	 */
	reload(): MetadataFile {
		const filePath = this.path;
		this.logger.debug("metadata_reload_start", { filePath });
		if (fs.existsSync(filePath)) {
			try {
				const raw = fs.readFileSync(filePath, "utf-8");
				const parsed = JSON.parse(raw) as MetadataFile;
				if (parsed.version === 1 && Array.isArray(parsed.records)) {
					this._metadata = parsed;
					this.logger.debug("metadata_reload_ok", { recordCount: parsed.records.length });
					return parsed;
				}
			} catch (error) {
				this.logger.warn("metadata_reload_failed", {
					filePath,
					error: error instanceof Error ? error.message : String(error),
				});
				// Malformed JSON or wrong shape; fall through to a clean file.
			}
		}
		this.logger.info("metadata_reload_defaulted", { filePath });
		this._metadata = {
			version: 1,
			mainSessionId: this.ctx.sessionId,
			mainSessionFile: this.ctx.sessionFile,
			records: [],
		};
		return this._metadata;
	}

	/**
	 * Persist the in-memory metadata to disk.
	 * Updates mainSessionId and mainSessionFile from the current context before writing.
	 */
	save(): void {
		const metadata = this.load();
		metadata.mainSessionId = this.ctx.sessionId;
		metadata.mainSessionFile = this.ctx.sessionFile;
		const filePath = this.path;
		this.logger.debug("metadata_save_start", {
			recordCount: metadata.records.length,
			filePath,
		});
		try {
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
			this.logger.debug("metadata_save_done", { filePath });
		} catch (error) {
			this.logger.error("metadata_save_failed", {
				filePath,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	// ---- Cleanup ----

	/**
	 * Delete the metadata sidecar file and every sub-agent session file
	 * referenced in the records. Resets the in-memory cache to null.
	 */
	cleanup(): void {
		const logger = this.logger.child({ component: "metadata" });
		const metadata = this.reload();
		logger.info("metadata_cleanup_start", { recordCount: metadata.records.length });
		for (const record of metadata.records) {
			if (!record.sessionFile) {
				continue;
			}
			try {
				fs.unlinkSync(record.sessionFile);
				logger.debug("metadata_cleanup_file_deleted", { filePath: record.sessionFile });
			} catch (error) {
				logger.warn("metadata_cleanup_file_failed", {
					filePath: record.sessionFile,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		try {
			fs.unlinkSync(this.path);
		} catch (error) {
			logger.warn("metadata_cleanup_main_failed", {
				error: error instanceof Error ? error.message : String(error),
				filePath: this.path,
			});
		}
		this._metadata = null;
		logger.info("metadata_cleanup_done");
	}

	// ---- Selected Root agent ----

	/** The name of the currently selected Root (main) agent, or undefined. */
	get selectedMainAgent(): string | undefined {
		return this.load().selectedMainAgent;
	}

	set selectedMainAgent(name: string | undefined) {
		const metadata = this.load();
		metadata.selectedMainAgent = name ?? undefined;
		this.save();
	}

	// ---- Record access ----

	/** Direct reference to the mutable records array. */
	get records(): SubagentRecord[] {
		return this.load().records;
	}

	/** Find a record by its hex ID. */
	findRecord(id: string): SubagentRecord | undefined {
		return this.load().records.find((r) => r.id === id);
	}

	// ---- Record allocation (concurrent-safe) ----

	/**
	 * Allocate a new SubagentRecord with a unique hex ID and human name.
	 *
	 * Allocation is serialised via an internal promise-based lock so that
	 * concurrent callers never race on the same hex ID or human name.
	 *
	 * @param agentName  The agent type name (e.g. "explorer", "coder").
	 * @param parentAgentId  Optional ID of the parent agent.
	 * @param depth  Nesting depth for the new sub-agent (default 1).
	 */
	async allocateRecord(
		agentName: string,
		parentAgentId?: string,
		depth: number = 1,
	): Promise<SubagentRecord> {
		const logger = this.logger.child({ component: "metadata", agentName, parentAgentId, depth });
		logger.debug("metadata_allocate_start");
		return this.withPathLock(() => {
			const metadata = this.reload();
			const id = randomHexId(new Set(metadata.records.map((r) => r.id)));
			logger.debug("metadata_allocate_lock_acquired", { existingCount: metadata.records.length });
			const { humanName, displayName } = pickHumanName(agentName, metadata.records);
			const now = new Date().toISOString();
			const record: SubagentRecord = {
				id,
				humanName,
				displayName,
				agentType: agentName,
				sessionFile: "",
				parentAgentId,
				depth,
				createdAt: now,
				updatedAt: now,
			};
			metadata.records.push(record);
			this.save();
			logger.info("metadata_allocate_done", { recordId: id, displayName: record.displayName });
			return record;
		});
	}

	// ---- Record mutation ----

	/**
	 * Persist updates to an existing record (merges fields, preserves createdAt).
	 * If the record doesn't exist yet it is appended.
	 */
	upsertRecord(record: SubagentRecord): void {
		const logger = this.logger.child({ component: "metadata", recordId: record.id });
		const metadata = this.load();
		const idx = metadata.records.findIndex((r) => r.id === record.id);
		if (idx >= 0) {
			metadata.records[idx] = {
				...metadata.records[idx],
				...record,
				createdAt: metadata.records[idx].createdAt, // never overwrite original
			};
			logger.debug("metadata_record_updated", { agentType: record.agentType });
		} else {
			metadata.records.push(record);
			logger.debug("metadata_record_inserted", { agentType: record.agentType, parentAgentId: record.parentAgentId });
		}
		this.save();
	}

	/**
	 * Update the updatedAt timestamp for a given record ID and persist.
	 * No-op if the ID is not found.
	 */
	touchRecord(id: string): void {
		const logger = this.logger.child({ component: "metadata", recordId: id });
		const metadata = this.load();
		const record = metadata.records.find((r) => r.id === id);
		if (record) {
			record.updatedAt = new Date().toISOString();
			this.save();
			logger.debug("metadata_record_touched");
		}
	}

	// ---- Factory ----

	/**
	 * Create a MetadataStore from a Pi session-manager-like shape.
	 *
	 * @param sm  An object with getSessionDir, getSessionId, getSessionFile methods.
	 */
	static fromSessionManager(sm: {
		getSessionDir(): string;
		getSessionId(): string;
		getSessionFile(): string | undefined;
	}, logger?: DebugLogger): MetadataStore {
		return new MetadataStore({
			sessionDir: sm.getSessionDir(),
			sessionId: sm.getSessionId(),
			sessionFile: sm.getSessionFile(),
		}, logger);
	}

	// ---- Legacy-compatible static wrappers (for existing tests) ----

	/** @deprecated Use `new MetadataStore(ctx).path` instead. */
	static metadataPath(ctx: MetadataStoreContext): string {
		return path.join(ctx.sessionDir, `.task-subagents-${ctx.sessionId}.json`);
	}

	/** @deprecated Use `new MetadataStore(ctx).load()` instead. */
	static loadStatic(ctx: MetadataStoreContext): MetadataFile {
		return new MetadataStore(ctx).load();
	}

	/** @deprecated Use `new MetadataStore(ctx).save()` instead. */
	static saveStatic(ctx: MetadataStoreContext, metadata: MetadataFile): void {
		const store = new MetadataStore(ctx);
		store._metadata = metadata;
		store.save();
	}
}
