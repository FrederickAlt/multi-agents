import { Box, Text } from "ink";

export function EmptyState() {
	return (
		<Box flexDirection="column" alignItems="center" justifyContent="center" height="100%">
			<Text dimColor>No agent definitions found in ~/.pi/agent/agents/</Text>
		</Box>
	);
}
