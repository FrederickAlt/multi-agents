import React from "react";
import { Box, Text } from "ink";
import type { AgentConfigState, DiscoveredOptions, StatusInfo } from "../state/types.js";
import { FIELDS_ORDER } from "../state/types.js";
import { FieldRow } from "./FieldRow.js";
import { StatusLine } from "./StatusLine.js";
import { ErrorColumn } from "./ErrorColumn.js";

interface AgentColumnProps {
	agent: AgentConfigState;
	options: DiscoveredOptions;
	isFocused: boolean;
	focusedField: number;
	status: StatusInfo | undefined;
}

export function AgentColumn({
	agent,
	isFocused,
	focusedField,
	status,
}: AgentColumnProps) {
	if (agent.error) {
		return <ErrorColumn agent={agent} isFocused={isFocused} />;
	}

	const missingDescription = !agent.description || agent.description.trim().length === 0;

	return (
		<Box
			flexDirection="column"
			borderStyle={isFocused ? "bold" : "single"}
			borderColor={isFocused ? "cyan" : "gray"}
			paddingX={1}
			width={30}
			minHeight={14}
			flexShrink={0}
		>
			{/* Header */}
			<Box flexDirection="row">
				<Text bold>{agent.name}</Text>
				{missingDescription && (
					<Text color="yellow"> ⚠ no description</Text>
				)}
			</Box>
			<Text dimColor>
				{missingDescription
					? "(no description)"
					: agent.description.length > 26
						? agent.description.slice(0, 26) + "..."
						: agent.description}
			</Text>

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

			{/* Spacer */}
			<Box height={1} />

			{/* Status line */}
			<Box height={1}>
				<StatusLine status={status} />
			</Box>
		</Box>
	);
}
