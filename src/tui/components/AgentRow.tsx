import { Box, Text } from "ink";
import { getMaxVisibleOptionColumns } from "../layout.js";
import { getOptionColumnWidth } from "../option-column-layout.js";
import {
	applyOptionColumnItemOrder,
	getFieldName,
	getModeSelection,
	getOptionColumnDisabledItems,
	getOptionColumnItemIndex,
	getOptionColumnItems,
	getOptionColumnSelectedValues,
	isCheckboxOptionColumnField,
	isOptionColumnDisabledForAgent,
	isOptionColumnField,
	isSmartModeLinked,
} from "../state/option-columns.js";
import type { AgentConfigState, DiscoveredOptions, OptionColumnItemOrder, StatusInfo } from "../state/types.js";
import { EXPANDED_ROW_HEIGHT, OPTION_COLUMN_FIELDS } from "../state/types.js";
import { ErrorColumn } from "./ErrorColumn.js";
import { OptionColumn } from "./OptionColumn.js";
import { StatusLine } from "./StatusLine.js";

interface AgentRowProps {
	agent: AgentConfigState;
	isFocused: boolean;
	isExpanded: boolean;
	focusedField: number;
	focusedOptionItem: number;
	optionColumnScrollOffset: number;
	options: DiscoveredOptions;
	status: StatusInfo | undefined;
	optionColumnFilter?: string;
	optionColumnItemOrder?: OptionColumnItemOrder | null;
	smartModelPickerOpen?: boolean;
	agentIndex?: number;
}

const INLINE_FIELD_LABELS: Record<string, string> = {
	tools: "tools",
	extensions: "extensions",
	model: "model",
	can_spawn: "can_spawn",
	skills: "skills",
	prompt_parts: "prompt_parts",
};

const EXPANDED_ROW_CHROME_LINES = 2;
const EXPANDED_ROW_HEADER_LINES = 2;
const OPTION_COLUMN_CHROME_LINES = 2;
const OPTION_COLUMN_LABEL_LINES = 1;
const EXPANDED_COLUMNS_HEIGHT = EXPANDED_ROW_HEIGHT - EXPANDED_ROW_CHROME_LINES - EXPANDED_ROW_HEADER_LINES;
const MAX_VISIBLE_OPTION_ITEMS_IN_EXPANDED_ROW = Math.max(
	1,
	EXPANDED_COLUMNS_HEIGHT - OPTION_COLUMN_CHROME_LINES - OPTION_COLUMN_LABEL_LINES,
);
// Fast and Smart always reserve a second row for their model summary or link state.
const MAX_VISIBLE_MODEL_ITEMS_IN_EXPANDED_ROW = Math.max(1, MAX_VISIBLE_OPTION_ITEMS_IN_EXPANDED_ROW - 1);

function getFocusedNonInlineSummary(agent: AgentConfigState, fieldName: string): string {
	const fm = agent.frontmatter ?? {};
	const raw = fm[fieldName];

	switch (fieldName) {
		case "tools":
		case "extensions":
		case "can_spawn":
		case "skills":
		case "prompt_parts": {
			if (raw === undefined) return "all (default)";
			if (!Array.isArray(raw)) return String(raw);
			if (raw.length === 0) return "none";
			return `${raw.length} selected`;
		}
		case "model":
			return raw !== undefined && raw !== null && raw !== "" ? String(raw) : "(default)";
		default:
			return raw !== undefined ? String(raw) : "-";
	}
}

export function AgentRow({
	agent,
	isFocused,
	isExpanded,
	focusedField,
	focusedOptionItem,
	optionColumnScrollOffset,
	options,
	status,
	optionColumnFilter = "",
	optionColumnItemOrder = null,
	smartModelPickerOpen = false,
	agentIndex = 0,
}: AgentRowProps) {
	if (agent.error) {
		return <ErrorColumn agent={agent} isFocused={isFocused} isExpanded={isExpanded} />;
	}

	const missingDescription = !agent.description || agent.description.trim().length === 0;
	const descText = missingDescription
		? "(no description)"
		: agent.description.length > 60
			? `${agent.description.slice(0, 60)}...`
			: agent.description;

	if (isExpanded) {
		const focusedFieldName = getFieldName(focusedField);
		const isFocusedFieldInline = isOptionColumnField(focusedFieldName);
		const focusedFieldHint = isFocusedFieldInline ? (
			<Text dimColor wrap="truncate">
				←/→ columns · Tab next column · ↑/↓ items · type to filter · Enter/Space select · Esc clear/collapse
			</Text>
		) : (
			<Text dimColor wrap="truncate">
				Focus: {INLINE_FIELD_LABELS[focusedFieldName] ?? focusedFieldName} ={" "}
				{getFocusedNonInlineSummary(agent, focusedFieldName)}· Press Enter/Space to edit
			</Text>
		);
		const smartModeLinked = isSmartModeLinked(agent);
		const columnData = OPTION_COLUMN_FIELDS.map((fieldName) => {
			const isDisabled = isOptionColumnDisabledForAgent(agent, fieldName);
			const isFocusedField = !isDisabled && isFocused && getFieldName(focusedField) === fieldName;
			const isInlineCheckbox = isCheckboxOptionColumnField(fieldName);
			const mode = fieldName === "smart_model" ? "smart" : "fast";
			const selectedValues = getOptionColumnSelectedValues(agent, options, fieldName, agent.name, mode);
			const columnFilter = isFocusedField ? optionColumnFilter : "";
			const availableItems = getOptionColumnItems(agent, options, fieldName, agent.name, columnFilter, mode);
			const items = applyOptionColumnItemOrder(
				fieldName === "smart_model" && smartModeLinked && !smartModelPickerOpen ? [] : availableItems,
				optionColumnItemOrder,
				agentIndex,
				fieldName,
				columnFilter,
			);
			const width = getOptionColumnWidth({
				fieldName,
				items: fieldName === "smart_model" && smartModeLinked ? availableItems : items,
				selectedValues,
				isFocused: isFocusedField,
				isCheckbox: isInlineCheckbox,
				staleItems: agent.staleItems[fieldName] ?? [],
				filterText: isFocusedField ? optionColumnFilter : undefined,
			});
			const optionFocusedItemIndex = isFocusedField
				? focusedOptionItem
				: getOptionColumnItemIndex(agent, options, fieldName, undefined, agent.name, "", mode);
			return {
				fieldName,
				isDisabled,
				disabledItems: getOptionColumnDisabledItems(agent, options, fieldName),
				isFocusedField,
				isInlineCheckbox,
				selectedValues,
				columnFilter,
				items,
				width,
				optionFocusedItemIndex,
			};
		});
		const columnWidths = columnData.map((column) => column.width);
		const visibleCount = getMaxVisibleOptionColumns(
			undefined,
			columnData.length,
			columnWidths,
			optionColumnScrollOffset,
		);
		const visibleColumns = columnData.slice(optionColumnScrollOffset, optionColumnScrollOffset + visibleCount);
		const hasMoreLeft = optionColumnScrollOffset > 0;
		const hasMoreRight = optionColumnScrollOffset + visibleColumns.length < OPTION_COLUMN_FIELDS.length;

		return (
			<Box
				flexDirection="column"
				borderStyle={isFocused ? "bold" : "single"}
				borderColor={isFocused ? "cyan" : "gray"}
				paddingX={1}
				height={EXPANDED_ROW_HEIGHT}
				width="100%"
				flexShrink={0}
				overflow="hidden"
			>
				<Box flexDirection="row">
					<Text bold>{agent.name}</Text>
					<Text dimColor> — {descText}</Text>
					{missingDescription && <Text color="yellow"> ⚠ no description</Text>}
				</Box>
				<Box flexDirection="row" height={1} overflow="hidden">
					{status && (
						<Box flexShrink={0}>
							<StatusLine status={status} />
						</Box>
					)}
					{status && (
						<Box flexShrink={0}>
							<Text dimColor> · </Text>
						</Box>
					)}
					{focusedFieldHint}
				</Box>
				<Box flexDirection="row" height={EXPANDED_COLUMNS_HEIGHT} overflow="hidden">
					{hasMoreLeft && <Text dimColor>◀ </Text>}
					{visibleColumns.map((column) => (
						<Box key={column.fieldName} flexDirection="row">
							<OptionColumn
								fieldName={column.fieldName}
								items={column.items}
								selectedValues={column.selectedValues}
								focusedItemIndex={column.optionFocusedItemIndex}
								isFocused={column.isFocusedField}
								modeSummary={
									column.fieldName === "model" || (column.fieldName === "smart_model" && !smartModeLinked)
										? getModeSelection(agent, options, column.fieldName === "smart_model" ? "smart" : "fast")
										: undefined
								}
								linked={column.fieldName === "smart_model" && smartModeLinked}
								centerLinked={column.fieldName === "smart_model" && smartModeLinked && !smartModelPickerOpen}
								disabled={column.isDisabled}
								disabledItems={column.disabledItems}
								filterText={column.isFocusedField ? column.columnFilter : undefined}
								isCheckbox={column.isInlineCheckbox}
								staleItems={agent.staleItems[column.fieldName] ?? []}
								maxVisibleItems={
									column.fieldName === "model" || column.fieldName === "smart_model"
										? MAX_VISIBLE_MODEL_ITEMS_IN_EXPANDED_ROW
										: MAX_VISIBLE_OPTION_ITEMS_IN_EXPANDED_ROW
								}
								width={column.width}
							/>
						</Box>
					))}
					{hasMoreRight && <Text dimColor> ▶</Text>}
				</Box>
			</Box>
		);
	}

	// Compact row: 3 lines total
	return (
		<Box
			flexDirection="column"
			borderStyle={isFocused ? "bold" : "single"}
			borderColor={isFocused ? "cyan" : "gray"}
			paddingX={1}
			height={3}
			width="100%"
			flexShrink={0}
		>
			{/* Name line */}
			<Box flexDirection="row">
				<Text bold color={isFocused ? "cyan" : undefined}>
					{agent.name}
				</Text>
				{missingDescription && <Text color="yellow"> ⚠ no description</Text>}
			</Box>

			{/* Description / status line */}
			<Box flexDirection="row">
				<Text dimColor>{descText}</Text>
				{status && (
					<Box marginLeft={1}>
						<StatusLine status={status} />
					</Box>
				)}
			</Box>
		</Box>
	);
}
