import { readFileSync } from "node:fs";
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

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const packageJson: PackageJson = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8"));

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
});
