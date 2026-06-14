import { Box, Text } from "ink";

interface HelpFooterProps {
	filteringInlineOptions?: boolean;
}

export function HelpFooter({ filteringInlineOptions = false }: HelpFooterProps) {
	return (
		<Box flexDirection="row" justifyContent="center" paddingX={1}>
			<Text dimColor>
				{filteringInlineOptions
					? "↑↓ items | ←/→ columns | type to filter | Enter/Space select | Esc clear/collapse"
					: "↑↓ nav agents | Enter/Space expand | Esc collapse/quit | r rescan"}
			</Text>
		</Box>
	);
}
