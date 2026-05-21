/**
 * CLI module for pi-agent-config.
 * Imports and renders the App component via Ink.
 */
import { render } from "ink";
import React from "react";
import { App } from "./app.js";

render(React.createElement(App), {
	exitOnCtrlC: true,
	patchConsole: false,
});
