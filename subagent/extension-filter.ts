import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./agents.js";
import { matchesProtectedMultiAgentExtension } from "./protected-extension.js";

function canonicalExistingPath(p: string): string {
	if (!p || p.startsWith("<")) return p;
	const resolved = path.resolve(p);
	try {
		return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
	} catch {
		return resolved;
	}
}

function sameExtensionPath(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	if (a.startsWith("<") || b.startsWith("<")) return false;
	return canonicalExistingPath(a) === canonicalExistingPath(b);
}

export function filterExtensionsForAgent(agent: AgentConfig, selfPath: string): (base: any) => any {
	const canonicalSelfPath = canonicalExistingPath(selfPath);
	return (base: any) => {
		const allowed = agent.extensions;
		const filtered = base.extensions.filter((extension: any) => {
			const extensionPath = String(extension.path ?? "");
			const resolvedPath = String(extension.resolvedPath ?? "");
			const candidates = [
				extension.path,
				extension.resolvedPath,
				extension.sourceInfo?.source,
				path.basename(extension.path ?? ""),
				path.basename(extension.resolvedPath ?? ""),
				path.basename(path.dirname(extension.resolvedPath ?? "")),
			].filter(Boolean).map(String);
			// Keep this sub-agent's inline runtime extension. It installs the
			// before_agent_start hook that renders agent templates and prompt parts;
			// filtering it out makes children fall back to Pi's default prompt.
			if (extensionPath.startsWith("<inline:") || resolvedPath.startsWith("<inline:")) return true;
			// Keep the multi-agents extension itself loaded even when an agent's
			// extensions list is explicit. Otherwise a config can unload the extension
			// that enforces this policy and provides Task/wait_for_agent.
			if (
				sameExtensionPath(extensionPath, canonicalSelfPath) ||
				sameExtensionPath(resolvedPath, canonicalSelfPath) ||
				candidates.some(matchesProtectedMultiAgentExtension)
			) return true;
			if (!allowed) return true; // undefined → unrestricted
			if (allowed.length === 0) return false; // [] → none
			return allowed.some((name) => candidates.some((candidate) => candidate.includes(name)));
		});
		return { ...base, extensions: filtered };
	};
}
