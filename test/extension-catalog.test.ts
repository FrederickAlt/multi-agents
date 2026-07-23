import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildExtensionCatalog,
	readExtensionCatalog,
	writeExtensionCatalog,
} from "../src/subagent/extension-catalog.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "extension-catalog-"));
	temporaryDirectories.push(directory);
	return directory;
}

function packageExtension(root: string, directory: string, packageName: string) {
	const packageRoot = path.join(root, directory);
	const entry = path.join(packageRoot, "dist", "index.js");
	mkdirSync(path.dirname(entry), { recursive: true });
	writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: packageName }));
	writeFileSync(entry, "");
	return {
		path: entry,
		resolvedPath: entry,
		sourceInfo: { source: `npm:${packageName}`, baseDir: packageRoot, origin: "package" },
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("authoritative extension catalog", () => {
	it("deduplicates aliases of one resolved extension and uses its package name", () => {
		const root = temporaryDirectory();
		const candidate = packageExtension(root, "adapter", "pi-mcp-adapter");
		const catalog = buildExtensionCatalog([candidate, { ...candidate, path: path.join(root, "adapter") }]);

		expect(catalog).toHaveLength(1);
		expect(catalog[0]?.selector).toBe("pi-mcp-adapter");
		expect(catalog[0]?.aliases).toContain(candidate.resolvedPath);
	});

	it("replaces a project snapshot while retaining other project snapshots", () => {
		const root = temporaryDirectory();
		const agentDir = path.join(root, "agent");
		const firstProject = path.join(root, "first-project");
		const secondProject = path.join(root, "second-project");
		mkdirSync(firstProject);
		mkdirSync(secondProject);
		const first = packageExtension(root, "first-extension", "first-extension");
		const replacement = packageExtension(root, "replacement", "replacement");
		const second = packageExtension(root, "second-extension", "second-extension");

		writeExtensionCatalog(agentDir, firstProject, [first]);
		writeExtensionCatalog(agentDir, secondProject, [second]);
		writeExtensionCatalog(agentDir, firstProject, [replacement]);

		expect(readExtensionCatalog(agentDir, firstProject)?.map((entry) => entry.selector)).toEqual(["replacement"]);
		expect(readExtensionCatalog(agentDir, secondProject)?.map((entry) => entry.selector)).toEqual([
			"second-extension",
		]);
	});

	it("omits the protected multi-agents extension", () => {
		const root = temporaryDirectory();
		const protectedExtension = packageExtension(root, "persistent-task-subagents", "persistent-task-subagents");
		expect(buildExtensionCatalog([protectedExtension])).toEqual([]);
	});
});
