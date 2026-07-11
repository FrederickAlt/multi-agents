/**
 * Unit tests for runtime model reference resolution and
 * model reference construction.
 *
 * Covers issue #30 acceptance criteria:
 *  - Unique bare IDs returned as-is
 *  - Ambiguous bare IDs returned as canonical provider/model-id
 *  - Slash-containing model IDs preserved (not split as provider/id)
 *  - Runtime resolution: exact canonical, exact bare (incl. slash),
 *    ambiguous bare rejected with warning/fallback
 */
import { describe, expect, it } from "vitest";
import { PiModelResolver } from "../src/subagent/session-manager.js";
import {
	computeCanonicalModelRefs,
	disambiguateModelDisplayNames,
	modelDisplayNameToCanonicalRef,
	orderModelsByProvider,
	resolveModelDisplayName,
} from "../src/tui/discovery/options.js";
import type { ModelOption } from "../src/tui/state/types.js";

// ---------------------------------------------------------------------------
// Model registry factory for tests
// ---------------------------------------------------------------------------

interface MockModel {
	id: string;
	provider: string;
	name: string;
}

function makeModel(
	provider: string,
	id: string,
	name?: string,
): MockModel & { provider: string; id: string; name: string } {
	return { provider, id, name: name ?? `${provider}/${id}` };
}

/**
 * Build a mock model registry compatible with PiModelResolver's interface.
 * @param models      - The full list of models (getAll)
 * @param authModels  - Subset of models whose provider has auth configured (hasConfiguredAuth)
 */
function makeRegistry(models: MockModel[], authModels: MockModel[] = models) {
	const authSet = new Set(authModels);
	return {
		getAll: () => [...models],
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id) ?? null,
		hasConfiguredAuth: (m: MockModel) => authSet.has(m),
	};
}

function makeResolver(models: MockModel[], authModels?: MockModel[]) {
	return new PiModelResolver(makeRegistry(models, authModels));
}

// ---------------------------------------------------------------------------
// PiModelResolver.resolve
// ---------------------------------------------------------------------------

describe("PiModelResolver.resolve", () => {
	// ---- Exact canonical references ----

	it("resolves an exact canonical provider/model-id reference", () => {
		const resolver = makeResolver([makeModel("anthropic", "claude-sonnet"), makeModel("openai", "gpt-5")]);
		const warnings: string[] = [];

		const result = resolver.resolve("anthropic/claude-sonnet", undefined, warnings);

		expect(result).toBeDefined();
		expect(result?.provider).toBe("anthropic");
		expect(result?.id).toBe("claude-sonnet");
		expect(warnings).toHaveLength(0);
	});

	it("resolves a canonical reference when model ID contains a slash", () => {
		const resolver = makeResolver([makeModel("acme", "some/weird-id")]);
		const warnings: string[] = [];

		const result = resolver.resolve("acme/some/weird-id", undefined, warnings);

		// Step 1 checks exact ID match: "acme/some/weird-id" === "some/weird-id"? No.
		// Step 2: split on "/" → provider="acme", id="some/weird-id"
		expect(result).toBeDefined();
		expect(result?.provider).toBe("acme");
		expect(result?.id).toBe("some/weird-id");
		expect(warnings).toHaveLength(0);
	});

	// ---- Exact bare model IDs ----

	it("resolves a unique bare model ID by exact match", () => {
		const resolver = makeResolver([makeModel("anthropic", "claude-sonnet-4-20250514"), makeModel("openai", "gpt-5")]);
		const warnings: string[] = [];

		const result = resolver.resolve("claude-sonnet-4-20250514", undefined, warnings);

		expect(result).toBeDefined();
		expect(result?.provider).toBe("anthropic");
		expect(result?.id).toBe("claude-sonnet-4-20250514");
		expect(warnings).toHaveLength(0);
	});

	it("resolves a slash-containing bare model ID by exact match", () => {
		const resolver = makeResolver([makeModel("acme", "models/with/slashes"), makeModel("openai", "gpt-5")]);
		const warnings: string[] = [];

		const result = resolver.resolve("models/with/slashes", undefined, warnings);

		// Step 1: exact ID match against "models/with/slashes" → found
		expect(result).toBeDefined();
		expect(result?.provider).toBe("acme");
		expect(result?.id).toBe("models/with/slashes");
		expect(warnings).toHaveLength(0);
	});

	it("prefers exact ID match over canonical parsing for slash-containing IDs", () => {
		// A model with ID "acme/gpt" exists, and there's also an "acme" provider
		// with a "gpt" model. The exact ID match should win.
		const resolver = makeResolver([makeModel("weird", "acme/gpt"), makeModel("acme", "gpt")]);
		const warnings: string[] = [];

		const result = resolver.resolve("acme/gpt", undefined, warnings);

		// Step 1: exact ID match → "weird" provider with id "acme/gpt"
		expect(result).toBeDefined();
		expect(result?.provider).toBe("weird");
		expect(result?.id).toBe("acme/gpt");
		expect(warnings).toHaveLength(0);
	});

	// ---- Ambiguous bare IDs ----

	it("rejects an ambiguous bare model ID with a warning", () => {
		const resolver = makeResolver([
			makeModel("deepseek", "deepseek-v4-flash"),
			makeModel("opencode-go", "deepseek-v4-flash"),
		]);
		const fallback = makeModel("anthropic", "claude-sonnet");
		const warnings: string[] = [];

		const result = resolver.resolve("deepseek-v4-flash", fallback, warnings);

		expect(result).toBe(fallback);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("ambiguous");
	});

	it("rejects ambiguous bare ID even when only one provider is authenticated", () => {
		const deepseekModel = makeModel("deepseek", "deepseek-v4-flash");
		const opencodeModel = makeModel("opencode-go", "deepseek-v4-flash");
		// Only deepseek has auth configured
		const resolver = makeResolver([deepseekModel, opencodeModel], [deepseekModel]);
		const fallback = makeModel("anthropic", "claude-sonnet");
		const warnings: string[] = [];

		const result = resolver.resolve("deepseek-v4-flash", fallback, warnings);

		// Ambiguity is about the ID itself, not auth status — reject
		expect(result).toBe(fallback);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("ambiguous");
	});

	// ---- Missing models ----

	it("warns and falls back when model is not found (bare ID)", () => {
		const resolver = makeResolver([makeModel("anthropic", "claude-sonnet")]);
		const fallback = makeModel("openai", "gpt-5");
		const warnings: string[] = [];

		const result = resolver.resolve("nonexistent-model", fallback, warnings);

		expect(result).toBe(fallback);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("not found");
	});

	it("warns and falls back when canonical reference provider is not found", () => {
		const resolver = makeResolver([makeModel("anthropic", "claude-sonnet")]);
		const fallback = makeModel("openai", "gpt-5");
		const warnings: string[] = [];

		const result = resolver.resolve("unknown/gpt-5", fallback, warnings);

		expect(result).toBe(fallback);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("not found");
	});

	it("warns and falls back when canonical reference model ID is not found under provider", () => {
		const resolver = makeResolver([makeModel("openai", "gpt-5")]);
		const fallback = makeModel("anthropic", "claude-sonnet");
		const warnings: string[] = [];

		const result = resolver.resolve("openai/gpt-4", fallback, warnings);

		expect(result).toBe(fallback);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("not found");
	});

	// ---- Unauthenticated models ----

	it("warns and falls back when exact bare ID model is not authenticated", () => {
		const claudeSonnet = makeModel("anthropic", "claude-sonnet-4");
		const resolver = makeResolver([claudeSonnet], []);
		const fallback = makeModel("openai", "gpt-5");
		const warnings: string[] = [];

		const result = resolver.resolve("claude-sonnet-4", fallback, warnings);

		expect(result).toBe(fallback);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("not authenticated");
	});

	it("warns and falls back when canonical reference model is not authenticated", () => {
		const model = makeModel("anthropic", "claude-sonnet-4");
		const resolver = makeResolver([model], []);
		const fallback = makeModel("openai", "gpt-5");
		const warnings: string[] = [];

		const result = resolver.resolve("anthropic/claude-sonnet-4", fallback, warnings);

		// Step 1: exact ID match → "anthropic/claude-sonnet-4" ≠ "claude-sonnet-4" → no
		// Step 2: provider/id split → found under anthropic → but not authenticated
		expect(result).toBe(fallback);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("not authenticated");
	});

	// ---- Edge cases ----

	it("returns undefined when modelName is undefined", () => {
		const resolver = makeResolver([makeModel("a", "b")]);
		const warnings: string[] = [];

		expect(resolver.resolve(undefined, undefined, warnings)).toBeUndefined();
		expect(warnings).toHaveLength(0);
	});

	it("handles empty model list gracefully", () => {
		const resolver = makeResolver([]);
		const fallback = makeModel("a", "b");
		const warnings: string[] = [];

		const result = resolver.resolve("anything", fallback, warnings);

		expect(result).toBe(fallback);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("not found");
	});

	it("returns authenticated exact match for slash-containing ID when auth is configured", () => {
		const model = makeModel("acme", "nested/model/id");
		const resolver = makeResolver([model], [model]);
		const warnings: string[] = [];

		const result = resolver.resolve("nested/model/id", undefined, warnings);

		expect(result).toBeDefined();
		expect(result?.provider).toBe("acme");
		expect(result?.id).toBe("nested/model/id");
		expect(warnings).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// computeCanonicalModelRefs
// ---------------------------------------------------------------------------

describe("computeCanonicalModelRefs", () => {
	function mo(provider: string, modelId: string, displayName?: string): ModelOption {
		return {
			provider,
			modelId,
			displayName: displayName ?? `${provider}/${modelId}`,
			canonicalRef: "", // will be set by computeCanonicalModelRefs
		};
	}

	it("uses bare modelId for unique model IDs", () => {
		const models = [mo("anthropic", "claude-sonnet"), mo("openai", "gpt-5")];
		computeCanonicalModelRefs(models);

		expect(models[0].canonicalRef).toBe("claude-sonnet");
		expect(models[1].canonicalRef).toBe("gpt-5");
	});

	it("uses provider/modelId for ambiguous (duplicate) model IDs", () => {
		const models = [mo("deepseek", "deepseek-v4"), mo("opencode-go", "deepseek-v4")];
		computeCanonicalModelRefs(models);

		expect(models[0].canonicalRef).toBe("deepseek/deepseek-v4");
		expect(models[1].canonicalRef).toBe("opencode-go/deepseek-v4");
	});

	it("uses provider/modelId when a hidden runtime provider shares a visible model ID", () => {
		const models = [mo("uni-muenster", "gpt-oss-120b")];
		computeCanonicalModelRefs(models, [
			{ provider: "cerebras", modelId: "gpt-oss-120b" },
			{ provider: "uni-muenster", modelId: "gpt-oss-120b" },
		]);

		expect(models[0].canonicalRef).toBe("uni-muenster/gpt-oss-120b");
	});

	it("handles mix of unique and duplicate IDs", () => {
		const models = [
			mo("anthropic", "claude-sonnet"),
			mo("deepseek", "deepseek-v4"),
			mo("opencode-go", "deepseek-v4"),
			mo("openai", "gpt-5"),
		];
		computeCanonicalModelRefs(models);

		expect(models[0].canonicalRef).toBe("claude-sonnet");
		expect(models[1].canonicalRef).toBe("deepseek/deepseek-v4");
		expect(models[2].canonicalRef).toBe("opencode-go/deepseek-v4");
		expect(models[3].canonicalRef).toBe("gpt-5");
	});

	it("handles slash-containing model IDs (unique)", () => {
		const models = [mo("acme", "models/with/slashes"), mo("openai", "gpt-5")];
		computeCanonicalModelRefs(models);

		expect(models[0].canonicalRef).toBe("models/with/slashes");
		expect(models[1].canonicalRef).toBe("gpt-5");
	});

	it("uses canonical ref for duplicate slash-containing IDs", () => {
		const models = [mo("acme", "shared/slash-id"), mo("other", "shared/slash-id")];
		computeCanonicalModelRefs(models);

		expect(models[0].canonicalRef).toBe("acme/shared/slash-id");
		expect(models[1].canonicalRef).toBe("other/shared/slash-id");
	});
});

// ---------------------------------------------------------------------------
// disambiguateModelDisplayNames
// ---------------------------------------------------------------------------

describe("disambiguateModelDisplayNames", () => {
	it("adds provider qualifiers to duplicate model names", () => {
		const models: ModelOption[] = [
			{ provider: "openai", modelId: "gpt-5", displayName: "GPT-5", canonicalRef: "gpt-5" },
			{ provider: "openrouter", modelId: "openai/gpt-5", displayName: "GPT-5", canonicalRef: "openai/gpt-5" },
			{
				provider: "anthropic",
				modelId: "claude-sonnet",
				displayName: "Claude Sonnet",
				canonicalRef: "claude-sonnet",
			},
		];

		disambiguateModelDisplayNames(models);

		expect(models.map((m) => m.displayName)).toEqual(["GPT-5 (openai)", "GPT-5 (openrouter)", "Claude Sonnet"]);
	});

	it("falls back to provider/modelId when provider-only labels are still ambiguous", () => {
		const models: ModelOption[] = [
			{ provider: "local", modelId: "a", displayName: "llama", canonicalRef: "a" },
			{ provider: "local", modelId: "b", displayName: "llama", canonicalRef: "b" },
		];

		disambiguateModelDisplayNames(models);

		expect(models.map((m) => m.displayName)).toEqual(["llama (local/a)", "llama (local/b)"]);
	});
});

// ---------------------------------------------------------------------------
// orderModelsByProvider
// ---------------------------------------------------------------------------

describe("orderModelsByProvider", () => {
	it("groups models by provider, then model label", () => {
		const models: ModelOption[] = [
			{ provider: "openrouter", modelId: "z", displayName: "Zed", canonicalRef: "z" },
			{ provider: "anthropic", modelId: "sonnet", displayName: "Sonnet", canonicalRef: "sonnet" },
			{ provider: "openrouter", modelId: "a", displayName: "Alpha", canonicalRef: "a" },
		];

		orderModelsByProvider(models);

		expect(models.map((m) => `${m.provider}/${m.displayName}`)).toEqual([
			"anthropic/Sonnet",
			"openrouter/Alpha",
			"openrouter/Zed",
		]);
	});
});

// ---------------------------------------------------------------------------
// resolveModelDisplayName
// ---------------------------------------------------------------------------

describe("resolveModelDisplayName", () => {
	const models: ModelOption[] = [
		{
			provider: "anthropic",
			modelId: "claude-sonnet-4",
			displayName: "Claude Sonnet 4",
			canonicalRef: "claude-sonnet-4",
		},
		{
			provider: "deepseek",
			modelId: "deepseek-v4",
			displayName: "DeepSeek V4",
			canonicalRef: "deepseek/deepseek-v4",
		},
		{
			provider: "opencode-go",
			modelId: "deepseek-v4",
			displayName: "DeepSeek V4 (opencode)",
			canonicalRef: "opencode-go/deepseek-v4",
		},
	];

	it("resolves canonicalRef to display name", () => {
		expect(resolveModelDisplayName("claude-sonnet-4", models)).toBe("Claude Sonnet 4");
		expect(resolveModelDisplayName("deepseek/deepseek-v4", models)).toBe("DeepSeek V4");
		expect(resolveModelDisplayName("opencode-go/deepseek-v4", models)).toBe("DeepSeek V4 (opencode)");
	});

	it("resolves bare modelId to display name", () => {
		expect(resolveModelDisplayName("claude-sonnet-4", models)).toBe("Claude Sonnet 4");
	});

	it("does not resolve ambiguous bare modelId to an arbitrary provider", () => {
		expect(resolveModelDisplayName("deepseek-v4", models)).toBeUndefined();
	});

	it("resolves explicit provider/modelId string to display name", () => {
		expect(resolveModelDisplayName("deepseek/deepseek-v4", models)).toBe("DeepSeek V4");
	});

	it("resolves display name to itself (passthrough)", () => {
		expect(resolveModelDisplayName("Claude Sonnet 4", models)).toBe("Claude Sonnet 4");
	});

	it("returns undefined for unmatched value", () => {
		expect(resolveModelDisplayName("nonexistent", models)).toBeUndefined();
	});

	it("returns undefined for undefined input", () => {
		expect(resolveModelDisplayName(undefined, models)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// modelDisplayNameToCanonicalRef
// ---------------------------------------------------------------------------

describe("modelDisplayNameToCanonicalRef", () => {
	const models: ModelOption[] = [
		{
			provider: "anthropic",
			modelId: "claude-sonnet-4",
			displayName: "Claude Sonnet 4",
			canonicalRef: "claude-sonnet-4",
		},
		{
			provider: "deepseek",
			modelId: "deepseek-v4",
			displayName: "DeepSeek V4",
			canonicalRef: "deepseek/deepseek-v4",
		},
	];

	it("maps display name to canonical reference", () => {
		expect(modelDisplayNameToCanonicalRef("Claude Sonnet 4", models)).toBe("claude-sonnet-4");
		expect(modelDisplayNameToCanonicalRef("DeepSeek V4", models)).toBe("deepseek/deepseek-v4");
	});

	it("resolves slash-containing and ambiguous model display names to canonical refs", () => {
		const slashAndDuplicateModels: ModelOption[] = [
			{ provider: "acme", modelId: "shared/model", displayName: "Acme Shared", canonicalRef: "shared/model" },
			{
				provider: "other",
				modelId: "shared/model",
				displayName: "Other Shared",
				canonicalRef: "other/shared/model",
			},
			{ provider: "openai", modelId: "gpt-5", displayName: "GPT-5", canonicalRef: "gpt-5" },
		];

		expect(modelDisplayNameToCanonicalRef("Acme Shared", slashAndDuplicateModels)).toBe("shared/model");
		expect(modelDisplayNameToCanonicalRef("Other Shared", slashAndDuplicateModels)).toBe("other/shared/model");
	});

	it("returns undefined for duplicate display names", () => {
		const duplicateModels: ModelOption[] = [
			{ provider: "a", modelId: "shared", displayName: "Shared", canonicalRef: "a/shared" },
			{ provider: "b", modelId: "shared", displayName: "Shared", canonicalRef: "b/shared" },
		];

		expect(modelDisplayNameToCanonicalRef("Shared", duplicateModels)).toBeUndefined();
	});

	it("returns undefined for unmatched display name", () => {
		expect(modelDisplayNameToCanonicalRef("Nonexistent", models)).toBeUndefined();
	});
});
