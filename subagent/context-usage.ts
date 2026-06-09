export interface SubagentContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

interface ContextUsageProvider {
	getContextUsage?: () => unknown;
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

	const tokens = usage.tokens === null ? null : finiteNumber(usage.tokens) ?? null;
	const percent = usage.percent === null ? null : finiteNumber(usage.percent) ?? null;

	return { tokens, contextWindow, percent };
}

export function formatContextUsageLine(contextUsage: SubagentContextUsage | undefined): string {
	if (contextUsage?.percent == null) return "Context used: Unknown.";
	return `Context used: ${contextUsage.percent.toFixed(1)}%.`;
}
