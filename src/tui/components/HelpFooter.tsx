import React from "react";
import { Box, Text } from "ink";

export function HelpFooter() {
	return (
		<Box flexDirection="row" justifyContent="center" paddingX={1}>
			<Text dimColor>
				←→ nav | ↑↓ field | Enter edit | Esc close | Space toggle | r rescan | q quit | Click: select
			</Text>
		</Box>
	);
}
