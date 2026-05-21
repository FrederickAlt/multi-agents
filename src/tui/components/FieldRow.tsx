import React from "react";
import { Box, Text } from "ink";
import type { AgentConfigState } from "../state/types.js";

interface FieldRowProps {
	agent: AgentConfigState;
	fieldName: string;
	isFocused: boolean;
}

const FIELD_LABELS: Record<string, string> = {
	tools: "tools",
	extensions: "extensions",
	model: "model",
	reasoning_effort: "reasoning",
	depth: "depth",
	can_spawn: "can_spawn",
	skills: "skills",
	prompt_parts: "prompt_parts",
};

export function FieldRow({ agent, fieldName, isFocused }: FieldRowProps) {
	const label = FIELD_LABELS[fieldName] ?? fieldName;
	const summary = getFieldSummary(agent, fieldName);

	return (
		<Box flexDirection="row" width={28}>
			<Text
				bold={isFocused}
				color={isFocused ? "cyan" : undefined}
				backgroundColor={isFocused ? "cyan" : undefined}
			>
				{isFocused ? "> " : "  "}
				{label.padEnd(12)}
				{summary}
			</Text>
		</Box>
	);
}

function getFieldSummary(agent: AgentConfigState, fieldName: string): string {
	const fm = agent.frontmatter;
	if (!fm) return "(error)";

	const raw = fm[fieldName];

	switch (fieldName) {
		case "tools":
		case "extensions":
		case "can_spawn":
		case "skills":
		case "prompt_parts": {
			if (raw === undefined) return "all (default)";
			if (!Array.isArray(raw)) return String(raw ?? "[]");
			if (raw.length === 0) return "none";
			return `${raw.length} selected`;
		}
		case "model":
		case "reasoning_effort":
			return raw !== undefined && raw !== null && raw !== ""
				? String(raw)
				: "(default)";
		case "depth":
			return raw !== undefined && raw !== null && raw !== ""
				? String(raw)
				: "0";
		default:
			return raw !== undefined ? String(raw) : "-";
	}
}
