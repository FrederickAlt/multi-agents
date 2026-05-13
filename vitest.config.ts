import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrc = fileURLToPath(new URL("../../pi-mono/packages/ai/src/index.ts", import.meta.url));
const aiOauthSrc = fileURLToPath(new URL("../../pi-mono/packages/ai/src/oauth.ts", import.meta.url));
const agentSrc = fileURLToPath(new URL("../../pi-mono/packages/agent/src/index.ts", import.meta.url));
const codingAgentSrc = fileURLToPath(new URL("../../pi-mono/packages/coding-agent/src/index.ts", import.meta.url));
const tuiSrc = fileURLToPath(new URL("../../pi-mono/packages/tui/src/index.ts", import.meta.url));

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
