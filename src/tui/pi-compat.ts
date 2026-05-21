import * as path from "node:path";
import { homedir } from "node:os";

/**
 * Minimal standalone replacements for the Pi helpers used by the TUI.
 *
 * The config TUI is runnable outside Pi's extension host, where
 * @mariozechner/pi-coding-agent is not necessarily installed in this package's
 * node_modules. Keep this module dependency-free so `npx tsx pi-agent-config.ts`
 * can start from a fresh checkout.
 */
export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
}

export interface ParsedFrontmatter<T extends Record<string, unknown>> {
	frontmatter: T;
	body: string;
}

export function parseFrontmatter<T extends Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) {
		return { frontmatter: {} as T, body: content };
	}

	return {
		frontmatter: parseYamlObject(match[1]) as T,
		body: match[2].replace(/^\r?\n/, ""),
	};
}

function parseYamlObject(yaml: string): Record<string, unknown> {
	const lines = yaml.replace(/\r\n?/g, "\n").split("\n");
	const result: Record<string, unknown> = {};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

		if (trimmed === "" || trimmed.startsWith("#")) {
			i++;
			continue;
		}

		if (/^\s/.test(line)) {
			throw new Error(`Unexpected indented line: ${line}`);
		}

		const field = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
		if (!field) {
			throw new Error(`Invalid YAML line: ${line}`);
		}

		const key = field[1];
		const rawValue = field[2] ?? "";

		if (rawValue.trim() !== "") {
			result[key] = parseYamlScalar(rawValue);
			i++;
			continue;
		}

		const block = parseIndentedBlock(lines, i + 1);
		result[key] = block.value;
		i = block.nextIndex;
	}

	return result;
}

function parseIndentedBlock(
	lines: string[],
	startIndex: number,
): { value: unknown; nextIndex: number } {
	const list: unknown[] = [];
	const object: Record<string, unknown> = {};
	let mode: "none" | "list" | "object" = "none";
	let i = startIndex;

	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

		if (trimmed === "" || trimmed.startsWith("#")) {
			i++;
			continue;
		}

		if (!/^\s/.test(line)) break;

		const listItem = line.match(/^\s*-\s*(.*)$/);
		if (listItem) {
			if (mode === "object") {
				throw new Error(`Mixed YAML block styles near: ${line}`);
			}
			mode = "list";
			list.push(parseYamlScalar(listItem[1]));
			i++;
			continue;
		}

		const objectItem = line.match(/^\s+([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
		if (objectItem) {
			if (mode === "list") {
				throw new Error(`Mixed YAML block styles near: ${line}`);
			}
			mode = "object";
			object[objectItem[1]] = parseYamlScalar(objectItem[2] ?? "");
			i++;
			continue;
		}

		throw new Error(`Unsupported YAML block line: ${line}`);
	}

	if (mode === "list") return { value: list, nextIndex: i };
	if (mode === "object") return { value: object, nextIndex: i };
	return { value: null, nextIndex: i };
}

function parseYamlScalar(raw: string): unknown {
	const value = stripYamlComment(raw).trim();

	if (value === "" || value === "null" || value === "~") return null;
	if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
	if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);

	if (value.startsWith("[")) {
		if (!value.endsWith("]")) {
			throw new Error(`Invalid inline YAML list: ${raw}`);
		}
		const inner = value.slice(1, -1).trim();
		if (inner === "") return [];
		return splitInlineList(inner).map(parseYamlScalar);
	}

	if (value.startsWith('"')) return parseDoubleQuoted(value, raw);
	if (value.startsWith("'")) return parseSingleQuoted(value, raw);

	return value;
}

function stripYamlComment(raw: string): string {
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (quote === '"' && ch === "\\" && !escaped) {
			escaped = true;
			continue;
		}
		if (!escaped && (ch === '"' || ch === "'")) {
			quote = quote === ch ? null : quote ?? ch;
		}
		if (!quote && ch === "#" && (i === 0 || /\s/.test(raw[i - 1]))) {
			return raw.slice(0, i);
		}
		escaped = false;
	}

	return raw;
}

function parseDoubleQuoted(value: string, raw: string): string {
	if (!value.endsWith('"') || value.length === 1) {
		throw new Error(`Invalid quoted YAML string: ${raw}`);
	}
	return value
		.slice(1, -1)
		.replace(/\\"/g, '"')
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\\\/g, "\\");
}

function parseSingleQuoted(value: string, raw: string): string {
	if (!value.endsWith("'") || value.length === 1) {
		throw new Error(`Invalid quoted YAML string: ${raw}`);
	}
	return value.slice(1, -1).replace(/''/g, "'");
}

function splitInlineList(inner: string): string[] {
	const items: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (const ch of inner) {
		if (quote === '"' && ch === "\\" && !escaped) {
			current += ch;
			escaped = true;
			continue;
		}
		if (!escaped && (ch === '"' || ch === "'")) {
			quote = quote === ch ? null : quote ?? ch;
		}
		if (!quote && ch === ",") {
			items.push(current.trim());
			current = "";
		} else {
			current += ch;
		}
		escaped = false;
	}

	if (quote) throw new Error(`Invalid inline YAML list: ${inner}`);
	items.push(current.trim());
	return items;
}
