import React from "react";
import { Box, Text } from "ink";

export function HelpFooter() {
	return (
		<Box flexDirection="row" justifyContent="center" paddingX={1}>
			<Text dimColor>
				↑↓ nav agents | Enter/Space expand | Esc collapse | r rescan | q quit
			</Text>
		</Box>
	);
}
