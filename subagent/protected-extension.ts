export const PROTECTED_MULTI_AGENT_EXTENSION_NAMES = [
	"multi-agents",
	"persistent-task-subagents",
] as const;

export function isProtectedMultiAgentExtensionName(value: string | undefined): boolean {
	if (!value) return false;
	return PROTECTED_MULTI_AGENT_EXTENSION_NAMES.some((name) => value === name);
}

export function matchesProtectedMultiAgentExtension(value: string | undefined): boolean {
	if (!value) return false;
	return PROTECTED_MULTI_AGENT_EXTENSION_NAMES.some((name) => value.includes(name));
}
