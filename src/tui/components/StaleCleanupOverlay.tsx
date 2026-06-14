import React from "react";
import { Box, Text } from "ink";
import type { OverlayState } from "../state/types.js";

interface StaleCleanupOverlayProps {
	overlay: Extract<OverlayState, { type: "stale-cleanup" }>;
}

export function StaleCleanupOverlay({ overlay }: StaleCleanupOverlayProps) {
	const tools = overlay.staleItems.tools ?? [];
	const extensions = overlay.staleItems.extensions ?? [];
	const terminalWidth = Math.max(1, process.stdout.columns ?? 80);
	const terminalHeight = Math.max(1, process.stdout.rows ?? 24);
	const popupWidth = Math.min(54, terminalWidth);
	const popupHeight = Math.min(tools.length + extensions.length + 7, 20, terminalHeight);
	const contentWidth = Math.max(0, popupWidth - 2);
	const padLine = (value: string) => {
		const paddedValue = ` ${value}`;
		return paddedValue.length > contentWidth
			? paddedValue.slice(0, contentWidth)
			: paddedValue.padEnd(contentWidth, " ");
	};
	const rows = [
		"Stale tools/extensions found. Remove them?",
		`agent: ${overlay.agentName}`,
		...tools.map((item) => `tools: ${item} (missing)`),
		...extensions.map((item) => `extensions: ${item} (missing)`),
		"",
		"Enter/y: remove  Esc/n: keep",
	];
	const helpRowIndex = rows.length - 1;
	while (rows.length < popupHeight - 2) rows.push("");

	return (
		<Box
			position="absolute"
			top={0}
			left={0}
			width={terminalWidth}
			height={terminalHeight}
			alignItems="center"
			justifyContent="center"
		>
			<Box
				flexDirection="column"
				borderStyle="double"
				borderColor="yellow"
				width={popupWidth}
				height={popupHeight}
			>
				{rows.slice(0, popupHeight - 2).map((row, index) => (
					<Text key={index} bold={index === 0} dimColor={index === helpRowIndex}>
						{padLine(row)}
					</Text>
				))}
			</Box>
		</Box>
	);
}
