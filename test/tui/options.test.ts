import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createTrustAwareDiscoverySettings,
	discoverAllAgentNames,
	discoverCachedPiRuntimeResources,
	discoverCanSpawn,
	discoverConfiguredExtensions,
	discoverExtensions,
	discoverModels,
	discoverModelsFromPiCli,
	discoverPromptParts,
	discoverSkills,
	discoverTools,
	mergePiRuntimeDiscoveries,
	parsePiListModelsOutput,
} from "../../src/tui/discovery/options.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(tmpdir(), "pi-agent-config-test-"));
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function mkdir(...segments: string[]): string {
	const p = path.join(tempDir, ...segments);
	fs.mkdirSync(p, { recursive: true });
	return p;
}

function writeFile(...segments: string[]): string {
	const p = path.join(tempDir, ...segments);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, "");
	return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTrustAwareDiscoverySettings", () => {
	it("starts untrusted and applies only a saved project decision", () => {
		const setProjectTrusted = vi.fn();
		const create = vi.fn(() => ({
			getDefaultProjectTrust: () => "ask" as const,
			setProjectTrusted,
		}));
		class TrustStore {
			get() {
				return true;
			}
		}

		createTrustAwareDiscoverySettings(
			{ SettingsManager: { create }, ProjectTrustStore: TrustStore } as any,
			"/project",
			"/agent",
		);

		expect(create).toHaveBeenCalledWith("/project", "/agent", { projectTrusted: false });
		expect(setProjectTrusted).toHaveBeenCalledWith(true);
	});

	it("fails closed when trust is undecided", () => {
		const setProjectTrusted = vi.fn();
		createTrustAwareDiscoverySettings(
			{
				SettingsManager: {
					create: () => ({ getDefaultProjectTrust: () => "ask", setProjectTrusted }),
				},
			} as any,
			"/project",
			"/agent",
		);

		expect(setProjectTrusted).toHaveBeenCalledWith(false);
	});
});

describe("discoverTools", () => {
	it("exposes both multi-agent coordination tools in fallback discovery", () => {
		expect(discoverTools(tempDir, [])).toEqual(expect.arrayContaining(["Task", "wait_for_agent"]));
	});

	it("returns built-in tools without treating agent-declared tools as available", () => {
		const agentToolLists = [["custom-tool", "bash"], ["another-tool"]];
		const tools = discoverTools(tempDir, agentToolLists);
		expect(tools).toContain("read");
		expect(tools).toContain("bash");
		expect(tools).not.toContain("custom-tool");
		expect(tools).not.toContain("another-tool");
	});

	it("returns built-in tools when no agent definitions", () => {
		const tools = discoverTools(tempDir, []);
		expect(tools).toContain("read");
		expect(tools).toContain("bash");
		expect(tools).toContain("edit");
	});

	it("deduplicates tools", () => {
		const tools = discoverTools(tempDir, [["read", "read"]]);
		const count = tools.filter((t) => t === "read").length;
		expect(count).toBe(1);
	});

	it("returns sorted array", () => {
		const tools = discoverTools(tempDir, [["z-tool", "a-tool"]]);
		const sorted = [...tools].sort();
		expect(tools).toEqual(sorted);
		expect(tools).not.toContain("a-tool");
		expect(tools).not.toContain("z-tool");
	});
});

describe("discoverExtensions", () => {
	it("returns empty array when extensions dir does not exist", () => {
		const exts = discoverExtensions(tempDir);
		expect(exts).toEqual([]);
	});

	it("returns directory names as extension names", () => {
		mkdir("extensions", "my-ext");
		mkdir("extensions", "another-ext");
		const exts = discoverExtensions(tempDir);
		expect(exts).toContain("my-ext");
		expect(exts).toContain("another-ext");
	});

	it("returns file names stripped of extension", () => {
		writeFile("extensions", "my-ext.js");
		writeFile("extensions", "another-ext.ts");
		const exts = discoverExtensions(tempDir);
		expect(exts).toContain("my-ext");
		expect(exts).toContain("another-ext");
	});

	it("returns sorted and deduplicated", () => {
		mkdir("extensions", "b-ext");
		mkdir("extensions", "a-ext");
		writeFile("extensions", "a-ext.js");
		const exts = discoverExtensions(tempDir);
		const aCount = exts.filter((e) => e === "a-ext").length;
		expect(aCount).toBe(1);
		expect(exts[0]).toBe("a-ext");
		expect(exts[1]).toBe("b-ext");
	});

	it("surfaces configured packages whose only extension is disabled", () => {
		const packageDir = mkdir("packages", "pdf-preview");
		fs.writeFileSync(
			path.join(packageDir, "package.json"),
			JSON.stringify({ name: "pdf-preview", pi: { extensions: ["./index.ts"] } }),
		);
		writeFile("packages", "pdf-preview", "index.ts");
		fs.writeFileSync(
			path.join(tempDir, "settings.json"),
			JSON.stringify({ packages: [{ source: "packages/pdf-preview", extensions: ["-index.ts"] }] }),
		);

		const discovered = discoverConfiguredExtensions(tempDir, tempDir);

		expect(discovered.extensions).toContain("pdf-preview");
		expect(discovered.disabledExtensions).toContain("pdf-preview");
		expect(discovered.extensionAliases["pdf-preview"]).toContain("packages/pdf-preview");
	});
});

describe("runtime tool-extension cache", () => {
	it("loads cached extension-provided tools for TUI discovery", () => {
		fs.writeFileSync(
			path.join(tempDir, "tool-extension-cache.json"),
			JSON.stringify({
				version: 1,
				tools: {
					config_tool: { extensions: ["config-ext", "../../extensions/config-ext"] },
				},
				extensions: ["config-ext"],
				extensionAliases: { "config-ext": ["config-ext", "../../extensions/config-ext"] },
			}),
		);

		const cached = discoverCachedPiRuntimeResources(tempDir);

		expect(cached.tools).toEqual(["config_tool"]);
		expect(cached.toolExtensionNames.config_tool).toEqual(["../../extensions/config-ext", "config-ext"]);
		expect(cached.extensions).toEqual(["../../extensions/config-ext", "config-ext"]);
		expect(cached.extensionAliases?.["config-ext"]).toEqual(["../../extensions/config-ext", "config-ext"]);
	});

	it("merges cached and fresh runtime tool-extension mappings", () => {
		const merged = mergePiRuntimeDiscoveries(
			{
				tools: ["cached_tool"],
				toolExtensionNames: { cached_tool: ["config-ext"] },
				extensions: ["config-ext"],
				extensionAliases: { "config-ext": ["config-ext"] },
				skills: [],
			},
			{
				tools: ["fresh_tool"],
				toolExtensionNames: { fresh_tool: ["config-ext"] },
				extensions: ["config-ext"],
				extensionAliases: { "config-ext": ["../../extensions/config-ext"] },
				skills: ["fresh-skill"],
			},
		);

		expect(merged?.tools).toEqual(["cached_tool", "fresh_tool"]);
		expect(merged?.toolExtensionNames).toEqual({ cached_tool: ["config-ext"], fresh_tool: ["config-ext"] });
		expect(merged?.extensionAliases?.["config-ext"]).toEqual(["config-ext", "../../extensions/config-ext"]);
		expect(merged?.skills).toEqual(["fresh-skill"]);
	});
});

describe("discoverCanSpawn", () => {
	it("includes self in spawnable agents", () => {
		writeFile("agents", "self.md");
		writeFile("agents", "other.md");
		const names = discoverCanSpawn(tempDir, "self");
		expect(names).toEqual(["other", "self"]);
	});

	it("returns self when only self exists", () => {
		writeFile("agents", "self.md");
		const names = discoverCanSpawn(tempDir, "self");
		expect(names).toEqual(["self"]);
	});

	it("skips hidden files", () => {
		writeFile("agents", ".hidden.md");
		writeFile("agents", "visible.md");
		const names = discoverCanSpawn(tempDir, "self");
		expect(names).toEqual(["visible"]);
	});

	it("returns sorted names", () => {
		writeFile("agents", "c-agent.md");
		writeFile("agents", "a-agent.md");
		writeFile("agents", "b-agent.md");
		const names = discoverCanSpawn(tempDir, "self");
		expect(names).toEqual(["a-agent", "b-agent", "c-agent"]);
	});
});

describe("discoverAllAgentNames", () => {
	it("returns all agent names including self", () => {
		writeFile("agents", "self.md");
		writeFile("agents", "other.md");
		const names = discoverAllAgentNames(tempDir);
		expect(names).toContain("self");
		expect(names).toContain("other");
	});
});

describe("discoverSkills", () => {
	it("returns skill names from directories with SKILL.md", () => {
		writeFile("skills", "my-skill", "SKILL.md");
		writeFile("skills", "another-skill", "SKILL.md");
		const skills = discoverSkills(tempDir);
		expect(skills).toContain("my-skill");
		expect(skills).toContain("another-skill");
	});

	it("ignores directories without SKILL.md", () => {
		mkdir("skills", "empty-skill");
		writeFile("skills", "valid-skill", "SKILL.md");
		const skills = discoverSkills(tempDir);
		expect(skills).toEqual(["valid-skill"]);
	});

	it("recursively returns skill names from nested skill.md files", () => {
		writeFile("skills", "category", "nested-skill", "skill.md");
		writeFile("skills", "other", "deep", "nested-again", "SKILL.md");
		const skills = discoverSkills(tempDir);
		expect(skills).toEqual(["nested-again", "nested-skill"]);
	});

	it("deduplicates skill names found in multiple nested directories", () => {
		writeFile("skills", "category-a", "shared", "SKILL.md");
		writeFile("skills", "category-b", "shared", "skill.md");
		const skills = discoverSkills(tempDir);
		expect(skills).toEqual(["shared"]);
	});

	it("returns empty when skills dir does not exist", () => {
		const skills = discoverSkills(tempDir);
		expect(skills).toEqual([]);
	});
});

describe("models discovery", () => {
	it("parses the provider/model table from pi --list-models", () => {
		const models =
			parsePiListModelsOutput(`provider            model                 context  max-out  thinking  images
local-llama-server  llama-3.1-8b          8.2K     4.1K     no        no
openrouter          openai/gpt-5.2        400K     128K     yes       yes
`);

		expect(models).toEqual([
			{ provider: "local-llama-server", modelId: "llama-3.1-8b", displayName: "llama-3.1-8b", canonicalRef: "" },
			{ provider: "openrouter", modelId: "openai/gpt-5.2", displayName: "openai/gpt-5.2", canonicalRef: "" },
		]);
	});

	it("disambiguates duplicate model names from different providers", () => {
		const fakePi = path.join(tempDir, "pi");
		fs.writeFileSync(
			fakePi,
			`#!/usr/bin/env bash
if [[ "$1" != "--list-models" ]]; then exit 2; fi
printf 'provider            model                 context  max-out  thinking  images\\n'
printf 'local-a             llama-3.1-8b          8.2K     4.1K     no        no\\n'
printf 'local-b             llama-3.1-8b          8.2K     4.1K     no        no\\n'
`,
		);
		fs.chmodSync(fakePi, 0o755);

		const result = discoverModelsFromPiCli(tempDir, fakePi);

		expect(result.models.map((m) => m.displayName)).toEqual(["llama-3.1-8b (local-a)", "llama-3.1-8b (local-b)"]);
		expect(result.models.map((m) => m.canonicalRef)).toEqual(["local-a/llama-3.1-8b", "local-b/llama-3.1-8b"]);
	});

	it("uses runtime model metadata to expose supported thinking levels", () => {
		const fakePi = path.join(tempDir, "pi");
		fs.writeFileSync(
			fakePi,
			`#!/usr/bin/env bash
		if [[ "$1" != "--list-models" ]]; then exit 2; fi
		printf 'provider            model                 context  max-out  thinking  images\\n'
		printf 'openai              gpt-5.4-mini          400K     128K     yes       yes\\n'
		`,
		);
		fs.chmodSync(fakePi, 0o755);

		const result = discoverModelsFromPiCli(tempDir, fakePi, [
			{
				provider: "openai",
				modelId: "gpt-5.4-mini",
				supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
			},
		]);

		expect(result.models[0]?.supportedThinkingLevels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
	});

	it("canonicalizes visible models against hidden runtime registry duplicates", () => {
		const fakePi = path.join(tempDir, "pi");
		fs.writeFileSync(
			fakePi,
			`#!/usr/bin/env bash
if [[ "$1" != "--list-models" ]]; then exit 2; fi
printf 'provider            model                 context  max-out  thinking  images\\n'
printf 'uni-muenster        gpt-oss-120b          131.1K   12.3K    no        no\\n'
`,
		);
		fs.chmodSync(fakePi, 0o755);

		const result = discoverModelsFromPiCli(tempDir, fakePi, [
			{ provider: "cerebras", modelId: "gpt-oss-120b" },
			{ provider: "uni-muenster", modelId: "gpt-oss-120b" },
		]);

		expect(result.models[0]).toMatchObject({
			displayName: "gpt-oss-120b (uni-muenster)",
			canonicalRef: "uni-muenster/gpt-oss-120b",
		});
	});

	it("uses only the installed pi model list", async () => {
		const fakePi = path.join(tempDir, "pi");
		fs.writeFileSync(
			fakePi,
			`#!/usr/bin/env bash
if [[ "$1" != "--list-models" ]]; then exit 2; fi
printf 'provider            model                 context  max-out  thinking  images\\n'
printf 'openai-codex        gpt-5.6-sol           372K     128K     yes       yes\\n'
printf 'local-llama-server  llama-3.1-8b          8.2K     4.1K     no        no\\n'
`,
		);
		fs.chmodSync(fakePi, 0o755);

		const result = await discoverModels(tempDir, fakePi);

		expect(result.status).toBe("ready");
		expect(result.models.map((m) => `${m.provider}/${m.modelId}`)).toEqual([
			"local-llama-server/llama-3.1-8b",
			"openai-codex/gpt-5.6-sol",
		]);
		expect(result.defaultModelDisplayName).toBe("llama-3.1-8b");
	});

	it("does not substitute stale built-in models when pi discovery fails", async () => {
		const result = await discoverModels(tempDir, path.join(tempDir, "missing-pi"));

		expect(result.status).toBe("degraded");
		expect(result.models).toEqual([]);
		expect(result.error).toContain("pi --list-models failed");
	});
});

describe("discoverPromptParts", () => {
	it("returns prompt part names from .md files", () => {
		writeFile("prompt-parts", "010-tools.md");
		writeFile("prompt-parts", "020-context.md");
		const parts = discoverPromptParts(tempDir);
		expect(parts).toContain("010-tools");
		expect(parts).toContain("020-context");
	});

	it("skips hidden files", () => {
		writeFile("prompt-parts", ".hidden.md");
		writeFile("prompt-parts", "010-tools.md");
		const parts = discoverPromptParts(tempDir);
		expect(parts).toEqual(["010-tools"]);
	});

	it("returns empty when prompt-parts dir does not exist", () => {
		const parts = discoverPromptParts(tempDir);
		expect(parts).toEqual([]);
	});
});
