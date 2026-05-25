import { Writable } from "node:stream";
import { render } from "ink";
import type React from "react";

export interface RenderToTextOptions {
	columns?: number;
	rows?: number;
	waitMs?: number;
}

class CaptureStream extends Writable {
	columns: number;
	rows: number;
	// Keep this false so Ink doesn't register restore-cursor hooks that
	// write escape codes to the real process stderr on exit.
	isTTY = false;
	private readonly chunks: string[] = [];

	constructor({ columns, rows }: { columns: number; rows: number }) {
		super();
		this.columns = columns;
		this.rows = rows;
	}

	_write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
		this.chunks.push(String(chunk));
		callback();
	}

	toString() {
		return this.chunks.join("");
	}
}

function patchStdoutDimension(name: "columns" | "rows", value: number): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(process.stdout, name);
	Object.defineProperty(process.stdout, name, {
		value,
		configurable: true,
	});

	return () => {
		if (descriptor) {
			Object.defineProperty(process.stdout, name, descriptor);
		} else {
			delete (process.stdout as { columns?: number; rows?: number })[name];
		}
	};
}

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(value: string): string {
	return value.replace(ANSI_RE, "");
}

function trimLineEndings(value: string): string {
	return value
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trimEnd();
}

function collapseRepeatedFrame(value: string): string {
	let text = value;
	while (text.length % 2 === 0) {
		const half = text.length / 2;
		const first = text.slice(0, half);
		const second = text.slice(half);
		if (first !== second) break;
		text = first;
	}
	return text;
}

/**
 * Render an Ink element into a deterministic fake TTY and return the visible
 * terminal frame as plain text. Useful for inspecting layout regressions from
 * tests, scripts, or an automated coding agent's shell output.
 */
export async function renderToText(
	element: React.ReactNode,
	options: RenderToTextOptions = {},
): Promise<string> {
	const columns = options.columns ?? 120;
	const rows = options.rows ?? 30;
	const waitMs = options.waitMs ?? 30;
	const stdout = new CaptureStream({ columns, rows });
	const restoreColumns = patchStdoutDimension("columns", columns);
	const restoreRows = patchStdoutDimension("rows", rows);

	const app = render(element, {
		stdout: stdout as NodeJS.WriteStream,
		debug: true,
		exitOnCtrlC: false,
		patchConsole: false,
	});

	try {
		await new Promise((resolve) => setTimeout(resolve, waitMs));
		app.unmount();
		return collapseRepeatedFrame(trimLineEndings(stripAnsi(stdout.toString())));
	} finally {
		app.cleanup();
		restoreRows();
		restoreColumns();
	}
}
