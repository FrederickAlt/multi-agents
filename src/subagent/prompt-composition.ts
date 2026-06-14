import type { AgentConfig } from "./agents.js";
import type { PromptPartConfig } from "./prompt-parts.js";

const REQUIRED_TEMPLATE_VARS = new Set([
	"tools",
	"guidelines",
	"context_files",
	"skills",
	"cwd",
	"date",
	"agent_name",
	"agent_description",
]);

export interface PromptParts {
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	promptGuidelines?: string[];
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: Array<{ name: string; description?: string; filePath?: string }>;
	cwd?: string;
}

export interface RenderContext {
	agent: AgentConfig;
	parts: PromptParts;
}

export const SUBAGENT_REPORTING_NOTICE = `# Subagent reporting

You are running as a subagent. Your parent agent will not see your full conversation or tool outputs; it will only receive your final assistant message.

Work autonomously until the delegated task is complete, or until you encounter an unexpected blocker, ambiguity, or failure that the parent needs to know about. Do not stop early without explaining the outcome.

Your final message should summarize:
- what you accomplished,
- key findings or changes,
- any blockers, risks, or follow-up needed.`;

function today(): string {
	const now = new Date();
	const yyyy = now.getFullYear();
	const mm = String(now.getMonth() + 1).padStart(2, "0");
	const dd = String(now.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function formatTools(parts: PromptParts): string {
	const names = parts.selectedTools ?? [];
	const snippets = parts.toolSnippets ?? {};
	const lines = names.filter((name) => snippets[name]).map((name) => `- ${name}: ${snippets[name]}`);
	return lines.length > 0 ? lines.join("\n") : "(none)";
}

function formatGuidelines(parts: PromptParts): string {
	const guidelines = parts.promptGuidelines ?? [];
	return guidelines.length > 0 ? guidelines.map((g) => `- ${g}`).join("\n") : "(none)";
}

function formatContextFiles(parts: PromptParts): string {
	const files = parts.contextFiles ?? [];
	if (files.length === 0) return "(none)";
	return files.map((file) => `## ${file.path}\n\n${file.content}`).join("\n\n");
}

function formatSkills(parts: PromptParts, agentSkills?: string[]): string {
	const allSkills = parts.skills ?? [];
	// agentSkills: undefined → all skills; [] → none; ["a","b"] → filter
	const filtered =
		agentSkills === undefined
			? allSkills
			: agentSkills.length === 0
				? []
				: allSkills.filter((s) => agentSkills.includes(s.name));
	if (filtered.length === 0) return "(none)";
	return filtered.map((skill) => `- ${skill.name}${skill.description ? `: ${skill.description}` : ""}`).join("\n");
}

/**
 * Build the template-variable value map from a RenderContext.
 * Root and Task sub-agents share this as the prompt-composition source of truth.
 */
export function buildTemplateValues(context: RenderContext): Record<string, string> {
	return {
		tools: formatTools(context.parts),
		guidelines: formatGuidelines(context.parts),
		context_files: formatContextFiles(context.parts),
		skills: formatSkills(context.parts, context.agent.skills),
		cwd: context.parts.cwd ?? "",
		date: today(),
		agent_name: context.agent.name,
		agent_description: context.agent.description,
	};
}

/** Render one template string by replacing {{variable}} placeholders. */
export function renderTemplateString(template: string, values: Record<string, string>, label: string): string {
	return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, rawName: string) => {
		if (!REQUIRED_TEMPLATE_VARS.has(rawName)) {
			throw new Error(`Unknown prompt variable ${match} in ${label}.`);
		}
		const value = values[rawName];
		if (value === undefined) {
			throw new Error(`Could not render prompt variable ${match} in ${label}.`);
		}
		return value;
	});
}

/** Render the agent-specific system prompt template. */
export function renderPromptTemplate(context: RenderContext): string {
	const values = buildTemplateValues(context);
	return renderTemplateString(context.agent.systemPrompt, values, context.agent.name);
}

/** Render the full prompt from the agent definition plus prompt-part fragments. */
export function renderSubagentSystemPrompt(context: RenderContext, promptParts: PromptPartConfig[]): string {
	const values = buildTemplateValues(context);
	const main = renderPromptTemplate(context);

	// Filter prompt parts by the agent's prompt_parts field:
	// - undefined → all parts included
	// - [] → no parts included
	// - ["name1", "name2"] → only matching parts
	const agentParts = context.agent.prompt_parts;
	const filteredParts =
		agentParts === undefined
			? promptParts
			: agentParts.length === 0
				? []
				: promptParts.filter((part) => agentParts.includes(part.name));

	const parts = filteredParts.map((part) => renderTemplateString(part.systemPrompt, values, part.name));
	return [main, ...parts].join("\n\n");
}

export interface SystemPromptCompositionOptions {
	/**
	 * The chained prompt Pi built before this extension replaces it. Accepted
	 * for compatibility with existing callers, but intentionally ignored: Agent
	 * definitions are the full prompt contract.
	 */
	baseSystemPrompt?: string;
	/** Pi append-system prompt material. Intentionally ignored for Agent definitions. */
	appendSystemPrompt?: string;
	/** Inject the Task-specific child-agent reporting contract. */
	includeSubagentReportingNotice?: boolean;
}

/**
 * Render the complete Agent-definition system prompt.
 *
 * Agent definitions are a full prompt contract: the markdown definition plus
 * resolved prompt-part fragments. Pi's default prompt, append-system prompt,
 * and generic context/skills/date suffix are intentionally not preserved here.
 */
export function renderComposedAgentSystemPrompt(
	context: RenderContext,
	promptParts: PromptPartConfig[],
	options: SystemPromptCompositionOptions = {},
): string {
	const prompt = renderSubagentSystemPrompt(context, promptParts);
	return options.includeSubagentReportingNotice ? [prompt, SUBAGENT_REPORTING_NOTICE].join("\n\n") : prompt;
}

export function buildPromptPartsFromOptions(options: any): PromptParts {
	return {
		selectedTools: options.selectedTools,
		toolSnippets: options.toolSnippets,
		promptGuidelines: options.promptGuidelines,
		contextFiles: options.contextFiles,
		skills: options.skills,
		cwd: options.cwd,
	};
}
