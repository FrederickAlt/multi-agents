export const PROTECTED_MULTI_AGENT_EXTENSION_NAMES = ["multi-agents", "persistent-task-subagents"] as const;

export function isProtectedMultiAgentExtensionName(value: string | undefined): boolean {
	if (!value) return false;
	return PROTECTED_MULTI_AGENT_EXTENSION_NAMES.some((name) => value === name);
}

export function matchesProtectedMultiAgentExtension(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.replace(/\\/g, "/").trim();
	if (!normalized) return false;
	const segments = normalized
		.split("/")
		.map((segment) => (segment.trim() ? segment.trim() : ""))
		.filter(Boolean);
	const normalizedName = process.platform === "win32" ? segments.map((segment) => segment.toLowerCase()) : segments;
	return PROTECTED_MULTI_AGENT_EXTENSION_NAMES.some((name) => normalizedName.some((segment) => segment === name));
}
