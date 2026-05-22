/**
 * Shared output extraction — used by both blocking and async paths,
 * and by the session manager's kill/abort handlers, so output extraction
 * stays consistent regardless of outcome (success, crash, timeout, abort).
 *
 * Kept in a separate module to avoid circular imports between
 * TaskController and SubagentSessionManager.
 */

/**
 * Extract the last assistant text content from a message array.
 */
export function getFinalTextFromMessages(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		const content = Array.isArray(msg.content) ? msg.content : [];
		for (const part of content) {
			if (part?.type === "text" && typeof part.text === "string") return part.text;
		}
	}
	return "";
}

/**
 * Extract the best available output from a sub-agent session transcript,
 * regardless of outcome (success, crash, timeout, abort).
 *
 * 1. Last assistant text in messages → return it (partial output survives crash).
 * 2. No assistant text but error/abort diagnostic → return that.
 * 3. Neither → return empty string (caller supplies generic fallback).
 */
export function extractOutput(
	messages: any[],
	error?: string,
): { text: string; source: 'assistant' | 'diagnostic' | 'none' } {
	const assistantText = getFinalTextFromMessages(messages);
	if (assistantText) {
		return { text: assistantText, source: 'assistant' };
	}
	if (error) {
		return { text: error, source: 'diagnostic' };
	}
	return { text: '', source: 'none' };
}
