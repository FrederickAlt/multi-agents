export interface SubagentContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export const SUBAGENT_CONTEXT_FINISH_THRESHOLD_PERCENT = 60;
export const SUBAGENT_CONTEXT_FINISH_MESSAGE =
	"[System] Your context usage has reached 60%. Finish the current task now. Do not start new work. Provide a concise final report covering what you completed, tests/results, current state, and any remaining work to continue when resumed.";

interface ContextUsageProvider {
	getContextUsage?: () => unknown;
}

interface ContextUsageEventSource {
	subscribe?: (listener: (event: unknown) => void) => () => void;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readSubagentContextUsage(session: unknown): SubagentContextUsage | undefined {
	const provider = session as ContextUsageProvider | undefined;
	if (typeof provider?.getContextUsage !== "function") return undefined;

	let raw: unknown;
	try {
		raw = provider.getContextUsage();
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== "object") return undefined;

	const usage = raw as { tokens?: unknown; contextWindow?: unknown; percent?: unknown };
	const contextWindow = finiteNumber(usage.contextWindow);
	if (contextWindow === undefined) return undefined;

	const tokens = usage.tokens === null ? null : (finiteNumber(usage.tokens) ?? null);
	const percent = usage.percent === null ? null : (finiteNumber(usage.percent) ?? null);

	return { tokens, contextWindow, percent };
}

export function subscribeToSubagentContextThreshold(
	session: unknown,
	onThreshold: (contextUsage: SubagentContextUsage) => void,
	thresholdPercent = SUBAGENT_CONTEXT_FINISH_THRESHOLD_PERCENT,
): () => void {
	const source = session as ContextUsageEventSource | undefined;
	if (typeof source?.subscribe !== "function") return () => {};

	let thresholdReached = false;
	const unsubscribe = source.subscribe((event) => {
		if (thresholdReached) return;
		if (
			event &&
			typeof event === "object" &&
			((event as { type?: unknown }).type === "agent_end" || (event as { type?: unknown }).type === "agent_settled")
		) {
			return;
		}

		const contextUsage = readSubagentContextUsage(session);
		if (contextUsage?.percent == null || contextUsage.percent < thresholdPercent) return;
		thresholdReached = true;
		onThreshold(contextUsage);
	});

	return unsubscribe;
}

export function formatContextUsageLine(contextUsage: SubagentContextUsage | undefined): string {
	if (contextUsage?.percent == null) return "Context used: Unknown.";
	return `Context used: ${contextUsage.percent.toFixed(1)}%.`;
}
