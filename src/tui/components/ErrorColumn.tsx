import React from "react";
import { Box, Text } from "ink";
import type { AgentConfigState } from "../state/types.js";

interface ErrorColumnProps {
	agent: AgentConfigState;
	isFocused: boolean;
}

export function ErrorColumn({ agent, isFocused }: ErrorColumnProps) {
	return (
		<Box
			flexDirection="column"
			borderStyle={isFocused ? "bold" : "single"}
			borderColor={isFocused ? "cyan" : "gray"}
			paddingX={1}
			width={30}
			minHeight={10}
		>
			<Text bold color="red">
				{agent.name}
			</Text>
			<Text dimColor>{agent.error ?? "Unknown error"}</Text>
			<Text dimColor>Edit the file manually to fix.</Text>
		</Box>
	);
}
