import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type PackageJson = {
	readonly bin?: Record<string, string>;
	readonly pi?: unknown;
};

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const packageJson: PackageJson = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8"));

describe("package metadata", () => {
	it("registers the pi-agents launcher and is no longer auto-registered as a normal extension", () => {
		expect(packageJson.bin?.["pi-agents"]).toBe("./src/launcher/cli.ts");
		expect(packageJson.pi).toBeUndefined();
	});
});
