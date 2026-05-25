/**
 * Shared output extraction — used by both blocking and async paths,
 * and by the session manager's kill/abort handlers, so output extraction
 * stays consistent regardless of outcome (success, crash, timeout, abort).
 *
 * Kept in a separate module to avoid circular imports between
 * TaskController and SubagentSessionManager.
 */

export const FINAL_RESPONSE_REQUIRED_MESSAGE = `[System] You stopped without returning a final message. If you intended to finish, emit a normal assistant message to the parent agent explaining your final result. If the token stream stopped unexpectedly, continue from where you left off and provide the final message now. Do not call tools unless they are required to produce that final message.`;
export const FINAL_RESPONSE_REQUIRED_MAX_ATTEMPTS = 3;

function textFromAssistantMessage(msg: any): string {
	const content = Array.isArray(msg?.content) ? msg.content : [];
	const text = content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("");
	return text.trim() ? text : "";
}

function textFromToolResultMessage(msg: any): string {
	if (typeof msg?.content === "string") return msg.content.trim();
	const content = Array.isArray(msg?.content) ? msg.content : [];
	const text = content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("");
	return text.trim() ? text : "";
}

function findMatchingToolCall(messages: any[], toolResultIndex: number): any | undefined {
	const toolCallId = messages[toolResultIndex]?.toolCallId;
	if (!toolCallId) return undefined;
	for (let i = toolResultIndex - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const toolCall = msg.content.find((part: any) => part?.type === "toolCall" && part.id === toolCallId);
		if (toolCall) return toolCall;
	}
	return undefined;
}

function getTerminalToolResultDiagnosticFromMessages(messages: any[]): string {
	const index = messages.length - 1;
	const msg = messages[index];
	if (msg?.role !== "toolResult" || msg.isError !== true) return "";
	const text = textFromToolResultMessage(msg);
	if (!text) return "";

	const toolCall = findMatchingToolCall(messages, index);
	const toolName = typeof msg.toolName === "string" ? msg.toolName : toolCall?.name;
	const prefix = toolName ? `${toolName} tool failed: ${text}` : text;
	const command = toolName === "bash" && typeof toolCall?.arguments?.command === "string"
		? toolCall.arguments.command.trim()
		: "";
	return command ? `${prefix}\nCommand: ${command}` : prefix;
}

/**
 * Extract the last assistant text content from a message array.
 */
export function getFinalTextFromMessages(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		const text = textFromAssistantMessage(msg);
		if (text) return text;
	}
	return "";
}

/**
 * Extract text only when the terminal transcript message is an assistant reply.
 */
export function getTerminalTextFromMessages(messages: any[]): string {
	const msg = messages[messages.length - 1];
	if (msg?.role !== "assistant") return "";
	return textFromAssistantMessage(msg);
}

export function getTerminalDiagnosticFromMessages(messages: any[]): string {
	const msg = messages[messages.length - 1];
	if (msg?.role === "assistant") {
		if ((msg.stopReason === "error" || msg.stopReason === "aborted") && typeof msg.errorMessage === "string") {
			return msg.errorMessage.trim() ? msg.errorMessage : "";
		}
		return "";
	}
	return getTerminalToolResultDiagnosticFromMessages(messages);
}

export function extractTerminalOutput(
	messages: any[],
): { text: string; source: 'assistant' | 'diagnostic' | 'none' } {
	const assistantText = getTerminalTextFromMessages(messages);
	if (assistantText) {
		return { text: assistantText, source: 'assistant' };
	}
	const diagnostic = getTerminalDiagnosticFromMessages(messages);
	if (diagnostic) {
		return { text: diagnostic, source: 'diagnostic' };
	}
	return { text: '', source: 'none' };
}

export function needsFinalResponsePrompt(messages: any[]): boolean {
	return extractTerminalOutput(messages).source === 'none';
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
	const terminalDiagnostic = getTerminalDiagnosticFromMessages(messages);
	if (terminalDiagnostic) {
		return { text: terminalDiagnostic, source: 'diagnostic' };
	}
	if (error) {
		return { text: error, source: 'diagnostic' };
	}
	return { text: '', source: 'none' };
}
