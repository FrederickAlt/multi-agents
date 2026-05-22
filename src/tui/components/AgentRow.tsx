import React from "react";
import { Box, Text } from "ink";
import type { AgentConfigState, DiscoveredOptions, StatusInfo } from "../state/types.js";
import { FIELDS_ORDER } from "../state/types.js";
import { FieldRow } from "./FieldRow.js";
import { StatusLine } from "./StatusLine.js";
import { ErrorColumn } from "./ErrorColumn.js";

interface AgentRowProps {
	agent: AgentConfigState;
	options: DiscoveredOptions;
	isFocused: boolean;
	isExpanded: boolean;
	focusedField: number;
	status: StatusInfo | undefined;
}

export function AgentRow({
	agent,
	isFocused,
	isExpanded,
	focusedField,
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
		// Expanded row: 10 lines total
		return (
			<Box
				flexDirection="column"
				borderStyle={isFocused ? "bold" : "single"}
				borderColor={isFocused ? "cyan" : "gray"}
				paddingX={1}
				height={10}
				flexShrink={0}
			>
				{/* Header */}
				<Box flexDirection="row">
					<Text bold>{agent.name}</Text>
					{missingDescription && (
						<Text color="yellow"> ⚠ no description</Text>
					)}
				</Box>
				<Text dimColor>{descText}</Text>

				{/* Spacer */}
				<Box height={1} />

				{/* Field rows */}
				{FIELDS_ORDER.map((fieldName, idx) => (
					<Box key={fieldName} height={1}>
						<FieldRow
							agent={agent}
							fieldName={fieldName}
							isFocused={isFocused && focusedField === idx}
						/>
					</Box>
				))}
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
