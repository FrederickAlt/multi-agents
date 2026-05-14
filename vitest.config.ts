import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

function piMonoSourcePath(relativePath: string): string {
	const candidates = [
		new URL(`../pi-mono/${relativePath}`, import.meta.url),
		new URL(`../../pi-mono/${relativePath}`, import.meta.url),
	];
	const existing = candidates.find((candidate) => existsSync(fileURLToPath(candidate)));
	return fileURLToPath(existing ?? candidates[0]);
}

const aiSrc = piMonoSourcePath("packages/ai/src/index.ts");
const aiOauthSrc = piMonoSourcePath("packages/ai/src/oauth.ts");
const agentSrc = piMonoSourcePath("packages/agent/src/index.ts");
const codingAgentSrc = piMonoSourcePath("packages/coding-agent/src/index.ts");
const tuiSrc = piMonoSourcePath("packages/tui/src/index.ts");

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
	},
	resolve: {
		alias: [
			{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: aiOauthSrc },
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrc },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrc },
			{ find: /^@mariozechner\/pi-coding-agent$/, replacement: codingAgentSrc },
			{ find: /^@mariozechner\/pi-tui$/, replacement: tuiSrc },
		],
	},
});
