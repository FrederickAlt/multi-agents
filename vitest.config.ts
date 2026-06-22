import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const piMonoRoot = (() => {
	for (const candidate of ["../pi-mono", "../../pi-mono"]) {
		const root = fileURLToPath(new URL(candidate, import.meta.url));
		if (existsSync(root)) return candidate;
	}
	return "../pi-mono";
})();

const aiSrc = fileURLToPath(new URL(`${piMonoRoot}/packages/ai/src/index.ts`, import.meta.url));
const aiOauthSrc = fileURLToPath(new URL(`${piMonoRoot}/packages/ai/src/oauth.ts`, import.meta.url));
const aiCompatSrc = fileURLToPath(new URL(`${piMonoRoot}/packages/ai/src/compat.ts`, import.meta.url));
const agentSrc = fileURLToPath(new URL(`${piMonoRoot}/packages/agent/src/index.ts`, import.meta.url));
const codingAgentSrc = fileURLToPath(new URL(`${piMonoRoot}/packages/coding-agent/src/index.ts`, import.meta.url));
const codingAgentHooksSrc = fileURLToPath(
	new URL(`${piMonoRoot}/packages/coding-agent/src/core/hooks/index.ts`, import.meta.url),
);
const tuiSrc = fileURLToPath(new URL(`${piMonoRoot}/packages/tui/src/index.ts`, import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		setupFiles: ["./test/setup.ts"],
	},
	resolve: {
		alias: [
			{ find: /^@(mariozechner|earendil-works)\/pi-ai\/oauth$/, replacement: aiOauthSrc },
			{ find: /^@(mariozechner|earendil-works)\/pi-ai\/compat$/, replacement: aiCompatSrc },
			{ find: /^@(mariozechner|earendil-works)\/pi-ai$/, replacement: aiSrc },
			{ find: /^@(mariozechner|earendil-works)\/pi-agent-core$/, replacement: agentSrc },
			{ find: /^@(mariozechner|earendil-works)\/pi-coding-agent\/hooks$/, replacement: codingAgentHooksSrc },
			{ find: /^@(mariozechner|earendil-works)\/pi-coding-agent$/, replacement: codingAgentSrc },
			{ find: /^@(mariozechner|earendil-works)\/pi-tui$/, replacement: tuiSrc },
		],
	},
});
