import * as fs from "node:fs";
import { parseFrontmatter } from "../pi-compat.js";

/**
 * Selective field write-back into an agent .md file.
 *
 * Strategy: text-level manipulation of the YAML frontmatter block to
 * preserve formatting and only touch the changed field. The markdown
 * body is never modified.
 */

export interface WriteResult {
	success: boolean;
	error?: string;
	/** The updated frontmatter object (after save) */
	frontmatter?: Record<string, unknown>;
}

/**
 * Write a single field value back to an agent markdown file.
 *
 * @param filePath - Absolute path to the agent .md file
 * @param fieldName - YAML field name (e.g., "tools", "model")
 * @param value - New value to write. undefined means remove the field.
 *                Empty array [] writes explicit empty list.
 */
export function writeFieldToFile(
	filePath: string,
	fieldName: string,
	value: string[] | string | number | undefined,
): WriteResult {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch (err) {
		return { success: false, error: `Cannot read file: ${(err as Error).message}` };
	}

	// Split into frontmatter + body
	const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

	let fmText: string;
	let body: string;

	if (!fmMatch) {
		// No frontmatter block — create one
		fmText = "";
		body = content;
	} else {
		fmText = fmMatch[1];
		body = fmMatch[2];
	}

	// Build the new field value in YAML text
	let newFmText: string;

	if (value === undefined) {
		// Remove the field entirely
		newFmText = removeFieldFromYamlText(fmText, fieldName);
	} else if (Array.isArray(value) && value.length === 0) {
		// Empty array: write `field: []`
		newFmText = setFieldInYamlText(fmText, fieldName, `${fieldName}: []`);
	} else if (Array.isArray(value)) {
		// YAML list
		const lines = [`${fieldName}:`];
		for (const item of value) {
			lines.push(`  - ${item}`);
		}
		newFmText = setFieldInYamlText(fmText, fieldName, lines.join("\n"));
	} else if (typeof value === "number") {
		newFmText = setFieldInYamlText(fmText, fieldName, `${fieldName}: ${value}`);
	} else {
		// Scalar string (may need quoting if contains special chars)
		const safe = yamlSafeString(value as string);
		newFmText = setFieldInYamlText(fmText, fieldName, `${fieldName}: ${safe}`);
	}

	// Reconstruct file
	const newContent = `---\n${newFmText}${newFmText ? "\n" : ""}---\n${body}`;

	try {
		fs.writeFileSync(filePath, newContent, "utf-8");
		// Parse the new content so callers can skip a separate re-read
		let frontmatter: Record<string, unknown> | undefined;
		try {
			const parsed = parseFrontmatter<Record<string, unknown>>(newContent);
			frontmatter = parsed.frontmatter;
		} catch {
			// Parse failure is non-fatal: the write succeeded.
		}
		return { success: true, frontmatter };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		const reason = (code === "EACCES" || code === "EPERM" || code === "EROFS")
			? `read-only: ${(err as Error).message}`
			: (err as Error).message;
		return {
			success: false,
			error: `Cannot write file: ${reason}`,
		};
	}
}

// ---------------------------------------------------------------------------
// YAML text manipulation helpers
// ---------------------------------------------------------------------------

/**
 * Set or replace a field in the frontmatter text.
 *
 * If the field already exists, its value is replaced.
 * If the field does not exist, it is appended to the end of the frontmatter.
 */
function setFieldInYamlText(fmText: string, fieldName: string, newValueLines: string): string {
	const lines = fmText.split("\n");

	// Find existing field index
	const fieldIdx = findFieldStart(lines, fieldName);

	if (fieldIdx === -1) {
		// Append to end
		const trimmed = fmText.trimEnd();
		const separator = trimmed.length > 0 ? "\n" : "";
		return trimmed + separator + newValueLines;
	}

	// Find the end of this field's value (next top-level key or EOF)
	const endIdx = findFieldEnd(lines, fieldIdx);

	// Replace the field lines with new value
	const before = lines.slice(0, fieldIdx);
	const after = lines.slice(endIdx);

	// Insert new value lines (split by newline)
	const newLines = newValueLines.split("\n");

	return [...before, ...newLines, ...after].join("\n");
}

/**
 * Remove a field from the frontmatter text.
 */
function removeFieldFromYamlText(fmText: string, fieldName: string): string {
	const lines = fmText.split("\n");

	const fieldIdx = findFieldStart(lines, fieldName);
	if (fieldIdx === -1) return fmText;

	const endIdx = findFieldEnd(lines, fieldIdx);

	// Remove the field lines
	const before = lines.slice(0, fieldIdx);
	let after = lines.slice(endIdx);

	// Clean up leading blank line if present
	if (after[0] === "") {
		after = after.slice(1);
	}

	return [...before, ...after].join("\n");
}

/**
 * Find the starting line index of a top-level YAML field.
 */
function findFieldStart(lines: string[], fieldName: string): number {
	// Match `fieldName:` at the start of a line (top-level key)
	const regex = new RegExp(`^${escapeRegex(fieldName)}:\\s?`);
	for (let i = 0; i < lines.length; i++) {
		if (regex.test(lines[i])) {
			return i;
		}
	}
	return -1;
}

/**
 * Find the end line index of a field value (exclusive).
 * For scalar values: endIdx = fieldIdx + 1
 * For list values: endIdx = index after last indented line + 1
 */
function findFieldEnd(lines: string[], fieldIdx: number): number {
	// If the field line has a value on the same line (scalar), just one line
	const fieldLine = lines[fieldIdx];
	if (!/:\s*$/.test(fieldLine)) {
		// Has inline value like `field: value` or `field: []`
		return fieldIdx + 1;
	}

	// The field starts a block (value is on subsequent indented lines)
	let end = fieldIdx + 1;
	while (end < lines.length && (lines[end].startsWith("  ") || lines[end].startsWith("\t") || lines[end] === "")) {
		// Allow one blank line within a field's value block
		if (lines[end] === "") {
			// Check if next line continues the block
			const next = end + 1;
			if (next < lines.length && (lines[next].startsWith("  ") || lines[next].startsWith("\t"))) {
				end++;
				continue;
			}
			break;
		}
		end++;
	}
	return end;
}

/**
 * Escape a string for safe YAML scalar value.
 * If the string contains characters that need quoting, wrap in double quotes.
 */
function yamlSafeString(value: string): string {
	// If value looks like a boolean/null/number, quote it
	if (/^(true|false|null|yes|no|on|off)$/i.test(value)) {
		return `"${value}"`;
	}
	// If contains special YAML characters, quote it
	if (/[#&*!|>'"%@`{}\[\],\n\r]/.test(value)) {
		return `"${value.replace(/"/g, '\\"')}"`;
	}
	// If empty, quote it
	if (value.length === 0) return '""';
	// Leading/trailing whitespace needs quoting
	if (value.trim() !== value) return `"${value}"`;
	return value;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
