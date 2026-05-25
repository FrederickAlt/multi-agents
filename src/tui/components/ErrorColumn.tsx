import React from "react";
import { Box, Text } from "ink";
import type { AgentConfigState } from "../state/types.js";
import { COMPACT_ROW_HEIGHT, EXPANDED_ROW_HEIGHT } from "../state/types.js";

interface ErrorColumnProps {
	agent: AgentConfigState;
	isFocused: boolean;
	isExpanded: boolean;
}

export function ErrorColumn({ agent, isFocused, isExpanded }: ErrorColumnProps) {
	const error = agent.error ?? "Unknown error";

	if (!isExpanded) {
		return (
			<Box
				flexDirection="column"
				borderStyle={isFocused ? "bold" : "single"}
				borderColor={isFocused ? "cyan" : "gray"}
				paddingX={1}
				height={COMPACT_ROW_HEIGHT}
				flexShrink={0}
			>
				<Box flexDirection="row">
					<Text bold color="red" wrap="truncate">{agent.name}</Text>
				</Box>
				<Box flexDirection="row">
					<Text dimColor wrap="truncate">{error}</Text>
				</Box>
			</Box>
		);
	}

	return (
		<Box
			flexDirection="column"
			borderStyle={isFocused ? "bold" : "single"}
			borderColor={isFocused ? "cyan" : "gray"}
			paddingX={1}
			height={EXPANDED_ROW_HEIGHT}
			flexShrink={0}
		>
			<Text bold color="red" wrap="truncate">
				{agent.name}
			</Text>
			<Text dimColor wrap="truncate">{error}</Text>
			<Text dimColor wrap="truncate">Edit the file manually to fix.</Text>
		</Box>
	);
}
