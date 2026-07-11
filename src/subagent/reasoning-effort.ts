export const PI_REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type PiReasoningEffort = (typeof PI_REASONING_EFFORTS)[number];

/**
 * Normalize agent frontmatter to Pi's current thinking-level vocabulary.
 * `maximum` was emitted by older versions of the config TUI and is retained
 * as a read-time compatibility alias.
 */
export function normalizeReasoningEffort(value: unknown): PiReasoningEffort | undefined {
	if (value === undefined || value === null) return undefined;
	const normalized = String(value).trim().toLowerCase();
	if (!normalized) return undefined;
	if (normalized === "maximum") return "max";
	return PI_REASONING_EFFORTS.find((effort) => effort === normalized);
}
