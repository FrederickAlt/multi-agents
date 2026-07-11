import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/subagent/agents.js";
import { resolveExtensionsForAgent } from "../src/subagent/extension-filter.js";
import {
	createTrustAwareSettings,
	resolveConfiguredExtensionCandidates,
} from "../src/subagent/extension-resolution.js";

function writeJson(filePath: string, value: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeExtension(filePath: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, "export default function () {}\n", "utf8");
}

function makeAgent(extensions?: string[]): AgentConfig {
	return {
		name: "test",
		description: "test",
		extensions,
		systemPrompt: "test",
		source: "user",
		filePath: "/tmp/test.md",
	};
}

describe("trust-aware extension resolution", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	let globalExtension: string;
	let projectExtension: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "multi-agent-extension-resolution-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		globalExtension = join(root, "global-extension.ts");
		projectExtension = join(cwd, ".pi", "project-extension.ts");
		writeExtension(globalExtension);
		writeExtension(projectExtension);
		writeJson(join(agentDir, "settings.json"), { extensions: [globalExtension] });
		writeJson(join(cwd, ".pi", "settings.json"), { extensions: ["./project-extension.ts"] });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("fails closed for project extensions without a saved trust decision", async () => {
		const { settingsManager, projectTrusted } = createTrustAwareSettings({ cwd, agentDir });
		const candidates = await resolveConfiguredExtensionCandidates({ cwd, agentDir, settingsManager });

		expect(projectTrusted).toBe(false);
		expect(candidates.map((candidate) => candidate.path)).toContain(globalExtension);
		expect(candidates.map((candidate) => candidate.path)).not.toContain(projectExtension);
	});

	it("matches Pi's automatic trust when the cwd has no gated project resources", () => {
		const emptyCwd = join(root, "empty-project");
		mkdirSync(emptyCwd, { recursive: true });

		expect(createTrustAwareSettings({ cwd: emptyCwd, agentDir }).projectTrusted).toBe(true);
		expect(createTrustAwareSettings({ cwd: emptyCwd, agentDir, projectTrustOverride: false }).projectTrusted).toBe(
			false,
		);
	});

	it("does not consult saved trust when an explicit override already decides it", () => {
		writeFileSync(join(agentDir, "trust.json"), "not-json\n", "utf8");

		expect(createTrustAwareSettings({ cwd, agentDir, projectTrustOverride: true }).projectTrusted).toBe(true);
		expect(createTrustAwareSettings({ cwd, agentDir, projectTrustOverride: false }).projectTrusted).toBe(false);
	});

	it("honors saved trust and explicit one-launch overrides", async () => {
		new ProjectTrustStore(agentDir).set(cwd, true);
		const trusted = createTrustAwareSettings({ cwd, agentDir });
		const trustedCandidates = await resolveConfiguredExtensionCandidates({
			cwd,
			agentDir,
			settingsManager: trusted.settingsManager,
		});

		expect(trusted.projectTrusted).toBe(true);
		expect(trustedCandidates.map((candidate) => candidate.path)).toContain(projectExtension);

		const denied = createTrustAwareSettings({ cwd, agentDir, projectTrustOverride: false });
		const deniedCandidates = await resolveConfiguredExtensionCandidates({
			cwd,
			agentDir,
			settingsManager: denied.settingsManager,
		});
		expect(denied.projectTrusted).toBe(false);
		expect(deniedCandidates.map((candidate) => candidate.path)).not.toContain(projectExtension);
	});

	it("never selects disabled Pi resources", () => {
		const selected = resolveExtensionsForAgent(makeAgent(["disabled"]), [
			{ path: "/tmp/disabled.ts", enabled: false },
			{ path: "/tmp/enabled.ts", enabled: true },
		]);

		expect(selected.paths).toEqual([]);
		expect(selected.warnings).toEqual([`No extension candidates matched selector "disabled".`]);
	});
});
