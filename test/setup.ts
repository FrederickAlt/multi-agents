import { MULTI_AGENTS_LAUNCHER_ENV, MULTI_AGENTS_LAUNCHER_ENV_VALUE } from "../src/subagent/launcher-contract.js";

if (process.env[MULTI_AGENTS_LAUNCHER_ENV] === undefined) {
	process.env[MULTI_AGENTS_LAUNCHER_ENV] = MULTI_AGENTS_LAUNCHER_ENV_VALUE;
}
