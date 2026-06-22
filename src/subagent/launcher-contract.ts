export const MULTI_AGENTS_LAUNCHER_ENV = "PI_MULTI_AGENTS_LAUNCHER";
export const MULTI_AGENTS_LAUNCHER_ENV_VALUE = "1";
export const MULTI_AGENTS_RESTART_REQUEST_FILE_ENV = "PI_MULTI_AGENTS_RESTART_FILE";
export const MULTI_AGENTS_LAUNCHER_CLI = "pi-agents";

export const MULTI_AGENTS_LAUNCHER_ERROR = [
	"The multi-agents extension is launcher-managed and cannot be loaded via normal auto-discovery.",
	`Use ${MULTI_AGENTS_LAUNCHER_CLI} to run Pi with multi-agents support.`,
	`Expected environment contract: ${MULTI_AGENTS_LAUNCHER_ENV}=${MULTI_AGENTS_LAUNCHER_ENV_VALUE}.`,
	`Expected restart request path env: ${MULTI_AGENTS_RESTART_REQUEST_FILE_ENV}.`,
	"Loading this extension without the launcher is not supported.",
].join(" ");

export function ensureMultiAgentsLauncherContext(): void {
	if (process.env[MULTI_AGENTS_LAUNCHER_ENV] !== MULTI_AGENTS_LAUNCHER_ENV_VALUE) {
		throw new Error(MULTI_AGENTS_LAUNCHER_ERROR);
	}
}
