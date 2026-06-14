import { Box, Text } from "ink";
import type { OverlayState } from "../state/types.js";

interface StaleCleanupOverlayProps {
	overlay: Extract<OverlayState, { type: "stale-cleanup" }>;
}

export function StaleCleanupOverlay({ overlay }: StaleCleanupOverlayProps) {
	const terminalWidth = Math.max(1, process.stdout.columns ?? 80);
	const terminalHeight = Math.max(1, process.stdout.rows ?? 24);
	const popupWidth = Math.min(54, terminalWidth);
	const staleRows = Object.entries(overlay.staleItems).flatMap(([fieldName, items]) => {
		const label = fieldName === "can_spawn" ? "subagents" : fieldName;
		return items.map((item) => ({
			key: `${fieldName}:${item}`,
			text: `${label}: ${item} (missing)`,
		}));
	});
	const popupHeight = Math.min(staleRows.length + 7, 20, terminalHeight);
	const contentWidth = Math.max(0, popupWidth - 2);
	const padLine = (value: string) => {
		const paddedValue = ` ${value}`;
		return paddedValue.length > contentWidth
			? paddedValue.slice(0, contentWidth)
			: paddedValue.padEnd(contentWidth, " ");
	};
	const rows = [
		{ key: "title", text: "Stale config references found. Remove them?" },
		{ key: "agent", text: `agent: ${overlay.agentName}` },
		...staleRows,
		{ key: "spacer", text: "" },
		{ key: "help", text: "Enter/y: remove  Esc/n: keep" },
	];
	const helpRowIndex = rows.length - 1;
	while (rows.length < popupHeight - 2) rows.push({ key: `blank:${rows.length}`, text: "" });
	const overlayPosition = { position: "absolute" as const, top: 0, left: 0 };

	return (
		<Box
			{...overlayPosition}
			width={terminalWidth}
			height={terminalHeight}
			alignItems="center"
			justifyContent="center"
		>
			<Box flexDirection="column" borderStyle="double" borderColor="yellow" width={popupWidth} height={popupHeight}>
				{rows.slice(0, popupHeight - 2).map((row, index) => (
					<Text key={row.key} bold={index === 0} dimColor={index === helpRowIndex}>
						{padLine(row.text)}
					</Text>
				))}
			</Box>
		</Box>
	);
}
