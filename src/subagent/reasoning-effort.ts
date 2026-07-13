export const PI_REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type PiReasoningEffort = (typeof PI_REASONING_EFFORTS)[number];

export interface ModelThinkingMetadata {
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<PiReasoningEffort, string | null>>;
}

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

/** Match Pi's model-specific thinking-level support rules. */
export function getSupportedReasoningEfforts(model: ModelThinkingMetadata): PiReasoningEffort[] | undefined {
	if (model.reasoning === undefined && model.thinkingLevelMap === undefined) return undefined;
	if (model.reasoning === false) return ["off"];

	return PI_REASONING_EFFORTS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** Clamp a normalized effort using Pi's high-then-low fallback order. */
export function clampReasoningEffort(
	effort: PiReasoningEffort,
	supportedEfforts: readonly PiReasoningEffort[] | undefined,
): PiReasoningEffort {
	if (!supportedEfforts || supportedEfforts.includes(effort)) return effort;

	const requestedIndex = PI_REASONING_EFFORTS.indexOf(effort);
	for (let i = requestedIndex; i < PI_REASONING_EFFORTS.length; i += 1) {
		if (supportedEfforts.includes(PI_REASONING_EFFORTS[i])) return PI_REASONING_EFFORTS[i];
	}
	for (let i = requestedIndex - 1; i >= 0; i -= 1) {
		if (supportedEfforts.includes(PI_REASONING_EFFORTS[i])) return PI_REASONING_EFFORTS[i];
	}
	return supportedEfforts[0] ?? "off";
}
