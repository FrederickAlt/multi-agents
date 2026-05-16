# Persistent Task Subagents

Pi extension for delegating work to persistent configured sub-agents.

## Features

- One model-facing tool: `Task`
- Each sub-agent is a real Pi session in normal session storage
- Sub-agents can be resumed with short hex IDs
- Human-readable display names such as `Explore Tom`
- Configurable agent markdown files with prompt variables
- Main/user-facing agent persona via `/agent <name>` or `--agent <name>`
- Prompt inspection via `/dump-prompt [agentName]`

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
- `{{parent_agent_id}}`
- `{{depth}}`

Unknown variables are errors.

## Commands

```text
/agent explorer
/dump-prompt
/dump-prompt explorer
```

`/agent` selects the main user-facing persona. `/dump-prompt` prints either the current main prompt or a configured agent prompt with variables resolved.

## Included Agents

| Agent | Purpose | Depth |
| --- | --- | --- |
| `coder` | Fast coding agent for implementing plans/issues | 0 |
| `explorer` | Fast codebase recon for handoff to other agents | 0 |
| `planner` | Creates implementation plans from context and requirements | 0 |
| `reviewer` | Code review specialist for quality and security analysis | 0 |

All built-in agents have `depth: 0` and cannot spawn further sub-agents.

## Persistence

Sub-agent metadata is stored beside the main session in a sidecar file named `.task-subagents-<sessionId>.json`. Sub-agent sessions use Pi's normal session files. They survive quitting and resuming the same main session, and are cleared when the main session is replaced with `/new`.
