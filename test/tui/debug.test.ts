import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	formatAgentConfigUsage,
	parseAgentConfigArgs,
	prepareDebugAgentDir,
} from "../../src/tui/debug.js";
import { writeFieldToFile } from "../../src/tui/file-io/write-agent.js";

let tempRoot: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	tempRoot = fs.mkdtempSync(path.join(tmpdir(), "pi-agent-config-debug-test-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true });
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

describe("agent config debug mode", () => {
	it("parses debug flags", () => {
		expect(parseAgentConfigArgs([])).toEqual({ debug: false, help: false });
		expect(parseAgentConfigArgs(["--debug"])).toEqual({ debug: true, help: false });
		expect(parseAgentConfigArgs(["--debug-dir", "/tmp/dummy"])).toEqual({
			debug: true,
			debugDir: "/tmp/dummy",
			help: false,
		});
		expect(parseAgentConfigArgs(["--debug-dir=/tmp/dummy"])).toEqual({
			debug: true,
			debugDir: "/tmp/dummy",
			help: false,
		});
		expect(parseAgentConfigArgs(["--help"])).toEqual({ debug: false, help: true });
		expect(formatAgentConfigUsage()).toContain("--debug");
	});

	it("rejects invalid arguments", () => {
		expect(() => parseAgentConfigArgs(["--debug-dir"])).toThrow("requires a path");
		expect(() => parseAgentConfigArgs(["--unknown"])).toThrow("Unknown argument");
	});

	it("rejects unsafe debug directories", () => {
		const sourceDir = path.join(tempRoot, "source-agent");
		fs.mkdirSync(sourceDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = sourceDir;

		expect(() => prepareDebugAgentDir({ debugDir: sourceDir })).toThrow("must be different");
		expect(() => prepareDebugAgentDir({ debugDir: path.join(sourceDir, "debug") })).toThrow("must not be inside");
	});

	it("copies the source agent config to a dummy path and redirects writes there", () => {
		const sourceDir = path.join(tempRoot, "source-agent");
		const debugDir = path.join(tempRoot, "dummy-agent");
		const sourceAgentsDir = path.join(sourceDir, "agents");
		fs.mkdirSync(sourceAgentsDir, { recursive: true });
		const sourceAgentFile = path.join(sourceAgentsDir, "coder.md");
		fs.writeFileSync(
			sourceAgentFile,
			"---\ndescription: Coder\nmodel: original-model\n---\n\nOriginal prompt.\n",
			"utf-8",
		);

		process.env.PI_CODING_AGENT_DIR = sourceDir;
		const info = prepareDebugAgentDir({ debugDir });

		expect(info).toEqual({
			sourceDir: path.resolve(sourceDir),
			debugDir: path.resolve(debugDir),
		});
		expect(process.env.PI_CODING_AGENT_DIR).toBe(path.resolve(debugDir));

		const debugAgentFile = path.join(debugDir, "agents", "coder.md");
		expect(fs.readFileSync(debugAgentFile, "utf-8")).toContain("original-model");

		const result = writeFieldToFile(debugAgentFile, "model", "debug-model");
		expect(result.success).toBe(true);

		expect(fs.readFileSync(debugAgentFile, "utf-8")).toContain("debug-model");
		expect(fs.readFileSync(sourceAgentFile, "utf-8")).toContain("original-model");
		expect(fs.readFileSync(sourceAgentFile, "utf-8")).not.toContain("debug-model");
	});

	it("dereferences symlinked prompt files before debug writes", () => {
		const sourceDir = path.join(tempRoot, "source-agent");
		const debugDir = path.join(tempRoot, "dummy-agent");
		const sourceAgentsDir = path.join(sourceDir, "agents");
		fs.mkdirSync(sourceAgentsDir, { recursive: true });
		const realPromptFile = path.join(tempRoot, "real-coder.md");
		fs.writeFileSync(
			realPromptFile,
			"---\ndescription: Linked\nmodel: original-model\n---\n\nLinked prompt.\n",
			"utf-8",
		);
		fs.symlinkSync(realPromptFile, path.join(sourceAgentsDir, "linked.md"));

		process.env.PI_CODING_AGENT_DIR = sourceDir;
		prepareDebugAgentDir({ debugDir });

		const debugAgentFile = path.join(debugDir, "agents", "linked.md");
		expect(fs.lstatSync(debugAgentFile).isSymbolicLink()).toBe(false);

		const result = writeFieldToFile(debugAgentFile, "model", "debug-model");
		expect(result.success).toBe(true);
		expect(fs.readFileSync(debugAgentFile, "utf-8")).toContain("debug-model");
		expect(fs.readFileSync(realPromptFile, "utf-8")).toContain("original-model");
		expect(fs.readFileSync(realPromptFile, "utf-8")).not.toContain("debug-model");
	});

	it("does not fail when the source config contains broken symlinks", () => {
		const sourceDir = path.join(tempRoot, "source-agent");
		const debugDir = path.join(tempRoot, "dummy-agent");
		const sourceExtensionsDir = path.join(sourceDir, "extensions");
		fs.mkdirSync(sourceExtensionsDir, { recursive: true });
		const brokenLink = path.join(sourceExtensionsDir, "missing-extension");
		fs.symlinkSync(path.join(tempRoot, "does-not-exist"), brokenLink);

		process.env.PI_CODING_AGENT_DIR = sourceDir;
		expect(() => prepareDebugAgentDir({ debugDir })).not.toThrow();
		expect(fs.existsSync(path.join(debugDir, "extensions", "missing-extension"))).toBe(false);
	});
});
