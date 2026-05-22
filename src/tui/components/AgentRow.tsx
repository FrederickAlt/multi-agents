import React from "react";
import { Box, Text } from "ink";
import type { AgentConfigState, DiscoveredOptions, StatusInfo } from "../state/types.js";
import { OPTION_COLUMN_FIELDS } from "../state/types.js";
import { getMaxVisibleOptionColumns } from "../layout.js";
import {
	getFieldName,
	isCheckboxOptionColumnField,
	isOptionColumnField,
	getOptionColumnItems,
	getOptionColumnSelectedValues,
} from "../state/option-columns.js";
import { OptionColumn } from "./OptionColumn.js";
import { StatusLine } from "./StatusLine.js";
import { ErrorColumn } from "./ErrorColumn.js";

interface AgentRowProps {
	agent: AgentConfigState;
	isFocused: boolean;
	isExpanded: boolean;
	focusedField: number;
	focusedOptionItem: number;
	optionColumnScrollOffset: number;
	options: DiscoveredOptions;
	status: StatusInfo | undefined;
	optionColumnFilter?: string;
}

const INLINE_FIELD_LABELS: Record<string, string> = {
	tools: "tools",
	extensions: "extensions",
	model: "model",
	can_spawn: "can_spawn",
	skills: "skills",
	prompt_parts: "prompt_parts",
};

const MAX_VISIBLE_OPTION_ITEMS_IN_EXPANDED_ROW = 3;

function getFocusedNonInlineSummary(agent: AgentConfigState, fieldName: string): string {
	const fm = agent.frontmatter ?? {};
	const raw = fm[fieldName];

	switch (fieldName) {
		case "tools":
		case "extensions":
		case "can_spawn":
		case "skills":
		case "prompt_parts": {
			if (raw === undefined) return "all (default)";
			if (!Array.isArray(raw)) return String(raw);
			if (raw.length === 0) return "none";
			return `${raw.length} selected`;
		}
		case "model":
			return raw !== undefined && raw !== null && raw !== "" ? String(raw) : "(default)";
		default:
			return raw !== undefined ? String(raw) : "-";
	}
}

export function AgentRow({
	agent,
	isFocused,
	isExpanded,
	focusedField,
	focusedOptionItem,
	optionColumnScrollOffset,
	options,
	status,
	optionColumnFilter = "",
}: AgentRowProps) {
	if (agent.error) {
		return <ErrorColumn agent={agent} isFocused={isFocused} />;
	}

	const missingDescription = !agent.description || agent.description.trim().length === 0;
	const descText = missingDescription
		? "(no description)"
		: agent.description.length > 60
			? agent.description.slice(0, 60) + "..."
			: agent.description;

	if (isExpanded) {
		const focusedFieldName = getFieldName(focusedField);
		const isFocusedFieldInline = isOptionColumnField(focusedFieldName);
		const focusedFieldHint = isFocusedFieldInline ? (
			<Text dimColor>↑/↓ fields · h/l columns · j/k items · Enter/Space open/edit</Text>
		) : (
			<Text dimColor>
				Focus: {INLINE_FIELD_LABELS[focusedFieldName] ?? focusedFieldName} = {
					getFocusedNonInlineSummary(agent, focusedFieldName)
				}
				 · Press Enter/Space to edit
			</Text>
		);
		const visibleCount = getMaxVisibleOptionColumns(undefined, OPTION_COLUMN_FIELDS.length);
		const visibleFields = OPTION_COLUMN_FIELDS.slice(
			optionColumnScrollOffset,
			optionColumnScrollOffset + visibleCount,
		);
		const hasMoreLeft = optionColumnScrollOffset > 0;
		const hasMoreRight = optionColumnScrollOffset + visibleFields.length < OPTION_COLUMN_FIELDS.length;

		return (
			<Box
				flexDirection="column"
				borderStyle={isFocused ? "bold" : "single"}
				borderColor={isFocused ? "cyan" : "gray"}
				paddingX={1}
				height={10}
				flexShrink={0}
			>
				<Box flexDirection="row">
					<Text bold>{agent.name}</Text>
					<Text dimColor> — {descText}</Text>
					{missingDescription && (
						<Text color="yellow"> ⚠ no description</Text>
					)}
				</Box>
				<Box flexDirection="row">
					{status && <StatusLine status={status} />}
					{status && <Text dimColor> · </Text>}
					{focusedFieldHint}
				</Box>
				<Box flexDirection="row" height={6} overflow="hidden">
					{hasMoreLeft && <Text dimColor>◀ </Text>}
					{visibleFields.map((fieldName) => {
						const isFocusedField = isFocused && getFieldName(focusedField) === fieldName;
						const isInlineCheckbox = isCheckboxOptionColumnField(fieldName);
						const selectedValues = getOptionColumnSelectedValues(
							agent,
							options,
							fieldName,
							agent.name,
						);
						const items = getOptionColumnItems(
							agent,
							options,
							fieldName,
							agent.name,
							isFocusedField ? optionColumnFilter : "",
						);
						return (
							<OptionColumn
								key={fieldName}
								fieldName={fieldName}
								items={items}
								selectedValues={selectedValues}
								focusedItemIndex={focusedOptionItem}
								isFocused={isFocusedField}
								filterText={isFocusedField ? optionColumnFilter : undefined}
								isCheckbox={isInlineCheckbox}
								staleItems={agent.staleItems[fieldName] ?? []}
								maxVisibleItems={MAX_VISIBLE_OPTION_ITEMS_IN_EXPANDED_ROW}
							/>
						);
					})}
					{hasMoreRight && <Text dimColor> ▶</Text>}
				</Box>
			</Box>
		);
	}

	// Compact row: 3 lines total
	return (
		<Box
			flexDirection="column"
			borderStyle={isFocused ? "bold" : "single"}
			borderColor={isFocused ? "cyan" : "gray"}
			paddingX={1}
			height={3}
			flexShrink={0}
		>
			{/* Name line */}
			<Box flexDirection="row">
				<Text bold color={isFocused ? "cyan" : undefined}>
					{agent.name}
				</Text>
				{missingDescription && (
					<Text color="yellow"> ⚠ no description</Text>
				)}
			</Box>

			{/* Description / status line */}
			<Box flexDirection="row">
				<Text dimColor>{descText}</Text>
				{status && (
					<Box marginLeft={1}>
						<StatusLine status={status} />
					</Box>
				)}
			</Box>
		</Box>
	);
}
