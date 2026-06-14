/**
 * CLI module for pi-agent-config.
 * Imports and renders the App component via Ink.
 */
import { render } from "ink";
import React from "react";
import { App } from "./app.js";
import type { AgentConfigDebugInfo } from "./debug.js";
import { formatAgentConfigUsage, parseAgentConfigArgs, prepareDebugAgentDir } from "./debug.js";

let debugInfo: AgentConfigDebugInfo | undefined;
try {
	const cliOptions = parseAgentConfigArgs(process.argv.slice(2));
	if (cliOptions.help) {
		console.log(formatAgentConfigUsage());
		process.exit(0);
	}
	if (cliOptions.debug) {
		debugInfo = prepareDebugAgentDir({ debugDir: cliOptions.debugDir });
	}
} catch (err) {
	console.error((err as Error).message);
	console.error(formatAgentConfigUsage());
	process.exit(1);
}

render(React.createElement(App as React.ComponentType<{ debugInfo?: AgentConfigDebugInfo }>, { debugInfo }), {
	exitOnCtrlC: true,
	patchConsole: false,
});
