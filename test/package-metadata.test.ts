import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type PackageJson = {
	readonly bin?: Record<string, string>;
	readonly files?: readonly string[];
	readonly pi?: unknown;
	readonly scripts?: {
		readonly prepack?: string;
	};
};

type PackageFile = {
	readonly path: string;
};

type PackDryRunArtifact = {
	readonly files: readonly PackageFile[];
};

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const packageJson: PackageJson = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8"));

function runPackDryRun(): PackDryRunArtifact {
	const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: PROJECT_ROOT,
		encoding: "utf-8",
	});

	expect(result.status).toBe(0);
	expect(result.stdout).toBeTruthy();

	const stdout = result.stdout.trim();
	const payloadText = stdout.match(/\n(\[[\s\S]*\])\s*$/)?.[1] ?? stdout;
	const payload = JSON.parse(payloadText);
	expect(Array.isArray(payload)).toBe(true);

	const [firstArtifact] = payload;
	expect(firstArtifact).toBeDefined();

	return firstArtifact as PackDryRunArtifact;
}

describe("package metadata", () => {
	it("registers the pi-agents launcher and is no longer auto-registered as a normal extension", () => {
		expect(packageJson.bin?.["pi-agents"]).toBe("./dist/launcher/cli.js");
		expect(packageJson.bin?.["pi-agent-config"]).toBe("./dist/tui/cli.js");
		expect(packageJson.files).toContain("dist/**/*");
		expect(packageJson.pi).toBeUndefined();
	});

	it("defines a prepack hook that builds distributable artifacts", () => {
		expect(packageJson.scripts?.prepack).toBe("npm run build");
	});

	it("includes declared CLI bins in npm pack output", () => {
		const artifact = runPackDryRun();
		const packedFiles = new Set(artifact.files.map((file) => file.path));

		expect(packedFiles.has("dist/launcher/cli.js")).toBe(true);
		expect(packedFiles.has("dist/tui/cli.js")).toBe(true);
	});
});
