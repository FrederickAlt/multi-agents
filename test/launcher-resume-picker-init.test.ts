import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const pickerInitEvents: string[] = [];
let activeSelectorOnSelect: ((path: string) => void) | undefined;
let mockedSelectedPath = "";

const childProcessSpawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync: childProcessSpawnSyncMock,
}));

vi.mock("@mariozechner/pi-tui", async () => {
	const actual = await vi.importActual<typeof import("@mariozechner/pi-tui")>("@mariozechner/pi-tui");

	class MockTUI {
		constructor() {
			pickerInitEvents.push("tui:new");
		}

		addChild(): void {
			pickerInitEvents.push("tui:add-child");
		}

		setFocus(): void {
			pickerInitEvents.push("tui:set-focus");
		}

		setClearOnShrink(): void {
			pickerInitEvents.push("tui:set-clear-on-shrink");
		}

		requestRender(): void {
			pickerInitEvents.push("tui:request-render");
		}

		start(): void {
			pickerInitEvents.push("tui:start");
			if (activeSelectorOnSelect) {
				pickerInitEvents.push("picker:select-callback");
				activeSelectorOnSelect(mockedSelectedPath);
			}
		}

		stop(): void {
			pickerInitEvents.push("tui:stop");
		}
	}

	return {
		...(actual as object),
		getKeybindings: vi.fn(() => {
			pickerInitEvents.push("tui:get-keybindings");
			return actual.getKeybindings();
		}),
		setKeybindings: vi.fn(() => {
			pickerInitEvents.push("tui:set-keybindings");
		}),
		ProcessTerminal: actual.ProcessTerminal,
		TUI: MockTUI,
	};
});

vi.mock("@mariozechner/pi-coding-agent", async () => {
	const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
		"@mariozechner/pi-coding-agent",
	);

	class MockSessionSelectorComponent {
		constructor(
			_currentSessionsLoader: (...args: unknown[]) => unknown,
			_allSessionsLoader: (...args: unknown[]) => unknown,
			onSelect: (path: string) => void,
			_onCancel: () => void,
			_onExit: () => void,
			_onRenderRequest: () => void,
			_options?: { showRenameHint?: boolean },
		) {
			pickerInitEvents.push("picker:component:new");
			activeSelectorOnSelect = onSelect;
		}

		getSessionList(): string {
			pickerInitEvents.push("picker:get-session-list");
			return "session-list";
		}
	}

	return {
		...(actual as object),
		initTheme: vi.fn(() => {
			pickerInitEvents.push("init-theme");
		}),
		SessionSelectorComponent: MockSessionSelectorComponent,
	};
});

const toISOString = () => new Date().toISOString();

function createSessionFile(sessionDir: string, id: string): string {
	const path = join(sessionDir, `${id}.jsonl`);
	writeFileSync(
		path,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: toISOString(), cwd: "/tmp/project" })}\n`,
		"utf-8",
	);
	return path;
}

afterEach(() => {
	pickerInitEvents.length = 0;
	activeSelectorOnSelect = undefined;
	childProcessSpawnSyncMock.mockReset();
});

describe("launch resume picker initialization", () => {
	it("initializes theme and keybindings before starting the picker", async () => {
		const spawnSync = childProcessSpawnSyncMock;
		const root = mkdtempSync(join(tmpdir(), "pi-agents-launch-resume-picker-root-"));
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-agents-launch-resume-picker-sessions-"));
		mockedSelectedPath = createSessionFile(sessionDir, "resume-session");

		const originalStdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const originalStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		spawnSync.mockReset();
		spawnSync.mockReturnValue({ status: 0, signal: null, stdout: null, stderr: null, output: [], pid: 123 } as any);

		try {
			const { launchPi } = await import("../src/launcher/pi-agents.js");
			const result = await launchPi(["--resume", "--session-dir", sessionDir], {
				cwd: root,
			});

			expect(result).toBe(0);
			const initThemeIndex = pickerInitEvents.indexOf("init-theme");
			const setKeybindingsIndex = pickerInitEvents.indexOf("tui:set-keybindings");
			const selectorIndex = pickerInitEvents.indexOf("picker:component:new");
			const startIndex = pickerInitEvents.indexOf("tui:start");
			const pickCallbackIndex = pickerInitEvents.indexOf("picker:select-callback");
			const stopIndex = pickerInitEvents.indexOf("tui:stop");

			expect(initThemeIndex).toBeGreaterThan(-1);
			expect(setKeybindingsIndex).toBeGreaterThan(-1);
			expect(selectorIndex).toBeGreaterThan(-1);
			expect(startIndex).toBeGreaterThan(-1);
			expect(pickCallbackIndex).toBeGreaterThan(-1);
			expect(initThemeIndex).toBeLessThan(startIndex);
			expect(initThemeIndex).toBeLessThan(selectorIndex);
			expect(setKeybindingsIndex).toBeLessThan(startIndex);
			expect(pickCallbackIndex).toBeGreaterThan(startIndex);
			expect(stopIndex).toBeGreaterThan(pickCallbackIndex);
			expect(spawnSync).toHaveBeenCalled();
		} finally {
			if (originalStdinTty) {
				Object.defineProperty(process.stdin, "isTTY", originalStdinTty);
			} else {
				delete (process.stdin as { isTTY?: boolean }).isTTY;
			}
			if (originalStdoutTty) {
				Object.defineProperty(process.stdout, "isTTY", originalStdoutTty);
			} else {
				delete (process.stdout as { isTTY?: boolean }).isTTY;
			}
			rmSync(root, { recursive: true, force: true });
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});
});
