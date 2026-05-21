import React from "react";
import { Text } from "ink";
import type { StatusInfo } from "../state/types.js";

interface StatusLineProps {
	status: StatusInfo | undefined;
}

export function StatusLine({ status }: StatusLineProps) {
	if (!status) return null;

	const color =
		status.type === "saved"
			? "green"
			: status.type === "error"
				? "red"
				: "yellow";

	return (
		<Text color={color} dimColor={status.type === "saving"}>
			{status.message}
		</Text>
	);
}
