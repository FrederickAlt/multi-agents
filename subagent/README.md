# Persistent Task Subagents

Pi extension for delegating work to persistent configured sub-agents.

## Features

- One model-facing tool: `Task`
- Each sub-agent is a real Pi session in normal session storage
- Sub-agents can be resumed with short hex IDs
- Human-readable display names such as `Explore Tom`
- Configurable agent markdown files with prompt variables
- Prompt-part fragments appended to rendered Agent definition prompts (tools, runtime context, project-specific additions)
- Root agent resolved through markdown Agent definitions, with configurable `defaultRootAgent` fallback
- Main/user-facing agent persona via session-local `/agent <name>` or `--agent <name>`
- Prompt inspection via Pi's <code>dump-prompt</code> command.

## Task Tool

```json
{
  "description": "short task label",
  "prompt": "full autonomous task description",
  "subagent_type": "explorer",
  "resume": "fad96168"
}
```

`resume` is optional. Omit it to start a new persistent sub-agent. Use the returned ID to continue the same transcript later.

Parallel work does not need a special mode. Pi can execute sibling tool calls concurrently when the model emits multiple `Task` calls in one turn. Sequential chains happen naturally by calling `Task`, reading the result, then calling `Task` again.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
description: Fast codebase exploration
tools: read, grep, find, ls, bash
extensions: web
model: claude-haiku-4-5
depth: 0
canSpawn: planner, reviewer
---

You are an exploration agent.

Available tools:
{{tools}}

Tool guidelines:
{{guidelines}}
```

Locations:

- `~/.pi/agent/agents/*.md`
- nearest `.pi/agents/*.md`

Frontmatter fields:

| Field | Type | Description |
|---|---|---|
| `description` | string | Required. Short description for agent lists |
| `tools` | comma-separated | Tool whitelist |
| `extensions` | comma-separated | Filter for extensions to load |
| `model` | string | Model override |
| `reasoning_effort` | string | Thinking/reasoning effort level |
| `depth` | number | Spawn allowance — how many more Task levels this agent permits |
| `canSpawn` | comma-separated | Allowlist of agent types this agent may delegate to |

Supported prompt variables:

- `{{tools}}`
- `{{guidelines}}`
- `{{context_files}}`
- `{{skills}}`
- `{{cwd}}`
- `{{date}}`
- `{{agent_name}}`
- `{{agent_description}}`

Unknown variables are errors. Internal tree metadata such as parent IDs and depth is not available as prompt variables.

## Prompt Parts

In addition to the agent's own system prompt, rendered Agent definitions receive prompt-part fragments. Prompt parts are independent `.md` files with YAML frontmatter that get resolved separately and appended to the Agent-definition system prompt.

Locations (same precedence as agents: bundled → user → project):
- `subagent/prompt-parts/*.md` (bundled with the extension)
- `~/.pi/agent/prompt-parts/*.md` (user)
- `.pi/prompt-parts/*.md` (project, nearest walking up from CWD)

A prompt-part file looks like:

```markdown
---
description: Shared tool information for all subagents
---

## Available Tools

{{tools}}

## Tool Guidelines

{{guidelines}}
```

Prompt parts support the same `{{variables}}` as agent definitions. Each part is rendered independently with the same rendering context, then joined with double-newline separators after the main agent prompt.

Prompt parts apply whenever this extension renders an Agent definition: the configured Root agent, a session-local `/agent` selection, and Task sub-agents. They are discovered from the agent's effective working directory, so project-specific prompt-parts can extend or override built-in ones.

The Agent definition path is the full prompt contract. Pi's hidden generic suffix and append-system prompt material are not preserved; use prompt parts and explicit `{{context_files}}` placement instead.

Built-in prompt parts (shipped with the extension):
- `010-tools.md` — shared tool information
- `020-runtime-context.md` — runtime context (cwd, date, agent name and description)

## Commands

```text
/agent explorer
```

`/agent` selects the Root agent persona for the current session. Sessions without a selection use the configured `defaultRootAgent`, which defaults to the built-in `default` Agent definition.

Use Pi's built-in system prompt dump to inspect the current system prompt.

## Included Agents

| Agent | Purpose | Depth |
| --- | --- | --- |
| `default` | Default Root coding assistant | 1 |
| `coder` | Fast coding agent for implementing plans/issues | 0 |
| `explorer` | Fast codebase recon for handoff to other agents | 0 |
| `planner` | Creates implementation plans from context and requirements | 0 |
| `reviewer` | Code review specialist for quality and security analysis | 0 |

The built-in specialist agents have `depth: 0` and cannot spawn further sub-agents. The built-in `default` Root agent has `depth: 1` so it can delegate one level by default.

## Included Prompt Parts

| Part | Purpose |
| --- | --- |
| `010-tools` | Shared tool information for rendered Agent definitions (`{{tools}}`, `{{guidelines}}`) |
| `020-runtime-context` | Runtime context for rendered Agent definitions (`{{cwd}}`, `{{date}}`, `{{agent_name}}`, `{{agent_description}}`) |

## Persistence

Sub-agent metadata is stored beside the main session in a sidecar file named `.task-subagents-<sessionId>.json`. Sub-agent sessions use Pi's normal session files. They survive quitting and resuming the same main session, and are cleared when the main session is replaced with `/new`.
