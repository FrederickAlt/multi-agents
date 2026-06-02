import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export const MULTI_AGENTS_DEBUG_LOGGING_ENABLED = false;

export type DebugLogLevel = "debug" | "info" | "warn" | "error";

export interface DebugLogger {
	isEnabled: boolean;
	child(context: Record<string, unknown>): DebugLogger;
	log(level: DebugLogLevel, event: string, payload?: Record<string, unknown>): void;
	debug(event: string, payload?: Record<string, unknown>): void;
	info(event: string, payload?: Record<string, unknown>): void;
	warn(event: string, payload?: Record<string, unknown>): void;
	error(event: string, payload?: Record<string, unknown>): void;
}

export interface DebugLoggerOptions {
	enabled?: boolean;
	logPath: string;
	maxValueLength?: number;
	maxArrayLength?: number;
	maxDepth?: number;
	redactedKeys?: readonly string[];
}

interface LoggerState {
	seq: number;
}

const DEFAULT_MAX_VALUE_LENGTH = 2048;
const DEFAULT_MAX_ARRAY_LENGTH = 64;
const DEFAULT_MAX_DEPTH = 6;

const DEFAULT_REDACTED_KEYS = [
	"authorization",
	"bearer",
	"cookie",
	"password",
	"secret",
	"secret_key",
	"token",
	"apikey",
	"api_key",
	"access_token",
	"refresh_token",
	"path",
	"session_file",
	"session_dir",
	"prompt",
	"messages",
	"output",
	"content",
	"context_files",
	"context_file_contents",
	"tool_schema",
	"tool_schemas",
	"parameters",
];

const SUBSTRING_REDACTED_KEY_TOKENS = new Set([
	"authorization",
	"bearer",
	"cookie",
	"password",
	"secret",
	"secretkey",
	"token",
	"apikey",
	"accesstoken",
	"refreshtoken",
]);

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const NOOP_LOGGER: DebugLogger = {
	isEnabled: false,
	child: () => NOOP_LOGGER,
	log: () => void 0,
	debug: () => void 0,
	info: () => void 0,
	warn: () => void 0,
	error: () => void 0,
};

function isSensitiveKey(key: string, redactedKeys: readonly string[]): boolean {
	const normalized = normalizeKey(key);
	return redactedKeys.some((redacted) => {
		const target = normalizeKey(redacted);
		if (normalized === target) return true;
		if (target === "path") return normalized.endsWith("path");
		return SUBSTRING_REDACTED_KEY_TOKENS.has(target) && normalized.includes(target);
	});
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength)}…(+${value.length - maxLength} chars)`;
}

function serializePrimitive(value: unknown, maxLength: number): unknown {
	if (typeof value === "string") return truncate(value, maxLength);
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "symbol") return value.toString();
	if (typeof value === "undefined") return "[undefined]";
	if (typeof value === "function") {
		return `[function ${value.name || "anonymous"}]`;
	}
	if (value === null) return null;
	return value;
}

function serializeForLog(
	input: unknown,
	depth: number,
	options: { maxValueLength: number; maxArrayLength: number; maxDepth: number; redactedKeys: readonly string[] },
	seen: Set<object>,
	path = "",
): unknown {
	if (depth > options.maxDepth) return "[max-depth-reached]";
	const primitive = serializePrimitive(input, options.maxValueLength);
	if (typeof primitive !== "object" || typeof input === "function" || typeof input === "undefined") {
		return primitive;
	}

	if (input instanceof Date) {
		return input.toISOString();
	}

	if (input instanceof Error) {
		return {
			type: input.name || "Error",
			message: truncate(input.message, options.maxValueLength),
			stack: input.stack ? truncate(input.stack, options.maxValueLength) : undefined,
			cause: input.cause ? serializeForLog(input.cause, depth + 1, options, seen, `${path}.cause`) : undefined,
		};
	}

	if (typeof input === "object") {
		if (seen.has(input)) return "[Circular]";
		seen.add(input);
	}
	try {
		if (Array.isArray(input)) {
			const arrayLength = input.length;
			const values = input.slice(0, options.maxArrayLength).map((value, index) =>
				serializeForLog(value, depth + 1, options, seen, path ? `${path}[${index}]` : `${index}`),
			);
			if (arrayLength > options.maxArrayLength) {
				values.push({ _omitted: arrayLength - options.maxArrayLength });
			}
			return values;
		}

		if (input instanceof Map) {
			const rawEntries = Array.from(input.entries()).map(([key, value]) => [
				serializeForLog(key, depth + 1, options, seen, `${path}.map.key`),
				serializeForLog(value, depth + 1, options, seen, `${path}.map.value`),
			]);
			const entries = rawEntries.slice(0, options.maxArrayLength);
			if (rawEntries.length > options.maxArrayLength) {
				entries.push([`_omitted`, rawEntries.length - options.maxArrayLength]);
			}
			return { __type: "Map", entries };
		}

		if (input instanceof Set) {
			const rawValues = Array.from(input.values()).map((value, index) =>
				serializeForLog(value, depth + 1, options, seen, `${path}[${index}]`),
			);
			const values = rawValues.slice(0, options.maxArrayLength);
			if (rawValues.length > options.maxArrayLength) {
				values.push({ _omitted: rawValues.length - options.maxArrayLength });
			}
			return { __type: "Set", values };
		}

		const output: Record<string, unknown> = {};
		for (const [rawKey, rawValue] of Object.entries(input)) {
			if (isSensitiveKey(rawKey, options.redactedKeys)) {
				output[rawKey] = "[redacted]";
				continue;
			}
			try {
				output[rawKey] = serializeForLog(
					rawValue,
					depth + 1,
					options,
					seen,
					path ? `${path}.${rawKey}` : rawKey,
				);
			} catch {
				output[rawKey] = "[unserializable]";
			}
		}
		return output;
	} finally {
		if (typeof input === "object" && input !== null) {
			seen.delete(input);
		}
	}
}

class JsonlDebugLogger implements DebugLogger {
	private readonly state: LoggerState;

	constructor(
		private readonly logPath: string,
		private readonly context: Record<string, unknown>,
		private readonly enabled: boolean,
		private readonly maxValueLength: number,
		private readonly maxArrayLength: number,
		private readonly maxDepth: number,
		private readonly redactedKeys: readonly string[],
		state?: LoggerState,
	) {
		this.state = state ?? { seq: 0 };
	}

	child(context: Record<string, unknown>): DebugLogger {
		return new JsonlDebugLogger(
			this.logPath,
			{ ...this.context, ...context },
			this.enabled,
			this.maxValueLength,
			this.maxArrayLength,
			this.maxDepth,
			this.redactedKeys,
			this.state,
		);
	}

	get isEnabled() {
		return this.enabled;
	}

	log(level: DebugLogLevel, event: string, payload: Record<string, unknown> = {}): void {
		if (!this.enabled) return;

		try {
			mkdirSync(dirname(this.logPath), { recursive: true });
			const nextSeq = ++this.state.seq;
			const sanitized = serializeForLog(
				{
					seq: nextSeq,
					ts: new Date().toISOString(),
					level,
					event,
					...this.context,
					...payload,
				},
				0,
				{
					maxValueLength: this.maxValueLength,
					maxArrayLength: this.maxArrayLength,
					maxDepth: this.maxDepth,
					redactedKeys: this.redactedKeys,
				},
				new Set<object>(),
			);
			appendFileSync(this.logPath, `${JSON.stringify(sanitized)}\n`, "utf-8");
		} catch {
			// Logging must never affect runtime behavior.
		}
	}

	debug(event: string, payload?: Record<string, unknown>): void {
		this.log("debug", event, payload);
	}
	info(event: string, payload?: Record<string, unknown>): void {
		this.log("info", event, payload);
	}
	warn(event: string, payload?: Record<string, unknown>): void {
		this.log("warn", event, payload);
	}
	error(event: string, payload?: Record<string, unknown>): void {
		this.log("error", event, payload);
	}
}

export function makeNoopDebugLogger(): DebugLogger {
	return NOOP_LOGGER;
}

export function makeDebugLogger(options: DebugLoggerOptions): DebugLogger {
	if (!options.enabled) return NOOP_LOGGER;
	return new JsonlDebugLogger(
		options.logPath,
		{},
		true,
		options.maxValueLength ?? DEFAULT_MAX_VALUE_LENGTH,
		options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH,
		options.maxDepth ?? DEFAULT_MAX_DEPTH,
		options.redactedKeys ?? DEFAULT_REDACTED_KEYS,
	);
}

export function makeSessionDebugLogPath(sessionDir: string, sessionId: string): string {
	return join(sessionDir, `.task-subagents-${sessionId}.debug.jsonl`);
}

export function makeSessionDebugLogger(
	context: { getSessionDir(): string; getSessionId(): string },
	options?: Pick<DebugLoggerOptions, "maxValueLength" | "maxArrayLength" | "maxDepth" | "redactedKeys"> & { enabled?: boolean },
): DebugLogger {
	const enabled = options?.enabled ?? MULTI_AGENTS_DEBUG_LOGGING_ENABLED;
	return makeDebugLogger({
		enabled,
		logPath: makeSessionDebugLogPath(context.getSessionDir(), context.getSessionId()),
		maxValueLength: options?.maxValueLength,
		maxArrayLength: options?.maxArrayLength,
		maxDepth: options?.maxDepth,
		redactedKeys: options?.redactedKeys,
	});
}

export function createRunCorrelationId(prefix = "task-run"): string {
	const now = Date.now().toString(36);
	const suffix = randomBytes(4).toString("hex");
	return `${prefix}-${now}-${suffix}`;
}
