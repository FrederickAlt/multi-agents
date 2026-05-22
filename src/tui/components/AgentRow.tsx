import React from "react";
import { Box, Text } from "ink";
import type { AgentConfigState, DiscoveredOptions, StatusInfo } from "../state/types.js";
import { OPTION_COLUMN_FIELDS } from "../state/types.js";
import { getMaxVisibleOptionColumns } from "../layout.js";
import {
	getOptionColumnItems,
	getOptionColumnSelectedValue,
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
					{status ? (
						<StatusLine status={status} />
					) : (
						<Text dimColor>←/→ columns · ↑/↓ items · Enter/Space select</Text>
					)}
				</Box>
				<Box flexDirection="row" height={6} overflow="hidden">
					{hasMoreLeft && <Text dimColor>◀ </Text>}
					{visibleFields.map((fieldName) => {
						const globalIndex = OPTION_COLUMN_FIELDS.indexOf(fieldName);
						return (
							<OptionColumn
								key={fieldName}
								fieldName={fieldName}
								items={getOptionColumnItems(agent, options, fieldName)}
								selectedValue={getOptionColumnSelectedValue(agent, fieldName)}
								focusedItemIndex={focusedOptionItem}
								isFocused={isFocused && focusedField === globalIndex}
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
