# Persistent Task Subagents Extension Spec

## Goal

Build a Pi extension that replaces the current subprocess-based subagent example with a persistent, configurable sub-agent system.

The main model-facing interface is a single tool named `Task`. Agents are configured as markdown files with YAML frontmatter and prompt bodies. Sub-agent sessions are real Pi sessions stored in normal Pi session storage, can be resumed by ID, and can be inspected through slash commands.

The implementation should use intended Pi extension APIs where possible. Avoid private Pi internals or brittle hacks. If a desired behavior is not supported cleanly by Pi, document the limitation and implement the closest public-API behavior.

## User-Facing Behavior

### Task Tool

Expose one model-callable tool. Prefer tool name `Task` if Pi accepts uppercase tool names; otherwise use internal name `task` and display label `Task`.

Schema:

```ts
{
  description: string;
  prompt: string;
  subagent_type: string;
  resume?: string;
}
```

Fields:

- `description`: required short 3-5 word task label.
- `prompt`: required full autonomous task description. It should be detailed because the sub-agent reports back once at the end.
- `subagent_type`: required configured agent type to run, such as `general-purpose` or `Explore`.
- `resume`: optional short hex agent ID from a previous run. If provided, continue that sub-agent transcript.

There are no explicit `single`, `parallel`, or `chain` modes. Pi already runs sibling tool calls concurrently when the model emits multiple tool calls in one assistant turn. Sequential chains are done naturally by calling `Task`, waiting for the result, then calling `Task` again.

### Persistence

All sub-agents persist by default. There is no `persistent` flag.

Sub-agent sessions:

- are stored in Pi's normal session storage;
- survive quitting Pi and resuming the same main session;
- are associated with the main session that spawned them;
- are cleared when the main session is replaced with `/new`;
- do not need a hard maximum count.

If `resume` references an unknown or cleared ID, the tool should return a clear error listing known live/resumable IDs when possible.

### Agent IDs And Display Names

Each spawned sub-agent gets:

- a short hex ID, for example `fad96168`;
- a human-readable display name, for example `Explorer Tom`.

The hex ID is the stable identifier that the parent model uses in `resume`.

The human name is for UI display only. Maintain a fixed pool of 30 names. Names must be unique among live sub-agents in the same main session. If the pool is exhausted, append increasing numbers starting at `1`.

Suggested name pool:

```txt
Tom, Ada, Max, Ivy, Leo, Nora, Sam, Mia, Eli, Zoe,
Kai, Ava, Ben, Lia, Gus, Nia, Ray, Uma, Jan, Eva,
Sol, Kim, Ari, Liv, Cal, Bea, Ned, Pia, Ren, Tess
```

Display format should combine agent type and human name, for example `Explorer Tom`.

## Agent Configuration

Agents are markdown files. Keep the shape close to the existing example:

```md
---
name: Explore
description: Fast codebase exploration
tools: read, grep, find, ls
extensions: web, github
model: claude-haiku-4-5
depth: 1
canSpawn: general-purpose, Explore
---

You are an exploration agent.

{{tools}}

{{guidelines}}
```

Supported frontmatter:

- `name`: required configured agent type.
- `description`: required human/model-facing description.
- `tools`: optional comma-separated tool allowlist. If omitted, use Pi defaults.
- `extensions`: optional comma-separated extension allowlist.
- `model`: optional model override.
- `depth`: optional depth setting for agents that can become the main/user-facing agent.
- `canSpawn`: optional comma-separated allowlist of agent types this agent may spawn.

Agent discovery should continue to support:

- user-level agents from `~/.pi/agent/agents/*.md`;
- project-level agents from nearest `.pi/agents/*.md` when enabled by the extension behavior.

Project agents overriding user agents by matching name is acceptable and matches the existing example.

## Tool And Extension Filtering

For each sub-agent, tool availability is determined by the agent config:

- `tools` is an allowlist against all tools made available after the agent's allowed extensions are considered.
- If `tools` references a tool from an extension that is not loaded for that sub-agent, omit that tool and show a warning.
- If `tools` is omitted, use Pi's default tools.
- Prompt variables for tools and guidelines must reflect only tools active for that specific agent.

This is important: if a web extension exists for the main agent but an `Explore` sub-agent is not configured to include it, the `Explore` prompt must not include web tool descriptions or web-specific guidelines.

## Prompt Templating

Agent prompt bodies use Handlebars-style placeholders. Placeholders must always resolve. Unknown or unrenderable placeholders are configuration errors and must prevent the agent from starting.

Supported placeholders:

```txt
{{tools}}
{{guidelines}}
{{context_files}}
{{skills}}
{{cwd}}
{{date}}
{{agent_name}}
{{agent_description}}
{{parent_agent_id}}
{{depth}}
```

Required for the first implementation:

- `{{tools}}`
- `{{guidelines}}`
- `{{cwd}}`
- `{{date}}`
- `{{agent_name}}`
- `{{agent_description}}`

Other placeholders may be skipped only if Pi makes them impractical, but unknown placeholders must still fail loudly.

`{{tools}}` should render the same kind of prompt-facing tool list Pi uses in its default system prompt: one-line tool snippets, not full parameter schemas. The actual tool parameter schemas are still supplied through Pi's tool-calling API.

`{{guidelines}}` should render only guidelines for that agent's active tools. Pi tool guidelines are flat bullets, so each guideline should remain as provided.

If a custom prompt does not include `{{tools}}` or `{{guidelines}}`, omit those sections. Do not append them automatically.

## Main Agent Persona

Every configured agent should be usable as the user-facing main agent.

Provide:

- a slash command such as `/agent <agentName>` to switch or select the main agent persona;
- a startup CLI flag if Pi's extension flag API supports string values, for example `--agent Explore`.

If Pi only supports boolean extension flags, do not hack around it. In that case, `/agent` is the guaranteed supported path and the CLI limitation should be documented.

The main-agent system prompt should be rendered from the selected agent config through Pi's official `before_agent_start` hook.

## Spawn Permissions And Depth

Depth starts at the main user-facing agent:

- main agent depth is `0`;
- direct sub-agents are depth `1`;
- `depth: 0` means no sub-agents may be spawned;
- `depth: 1` means direct sub-agents may be spawned, but those sub-agents cannot spawn further agents.

Only the depth setting of the main user-facing agent should define the maximum spawn depth for the whole agent tree.

Every agent, including the main agent, may have a `canSpawn` allowlist. An agent may only spawn configured agent types in its allowlist. If `canSpawn` is absent, use a conservative default of no nested spawning for sub-agents. The main agent's intended defaults should be explicit in its markdown config.

When a spawn is blocked by depth or `canSpawn`, return a clear tool error explaining why.

## Slash Commands

### `/dump-prompt`

With no argument, dump what the current main model sees before the first user prompt. Prefer `ctx.getSystemPrompt()` where possible.

With an agent name, render that configured agent's prompt as it would be seen by the model before its first task, including resolved prompt variables and any warnings.

Examples:

```txt
/dump-prompt
/dump-prompt Explore
```

### `/agent`

Select or inspect the user-facing main agent persona.

Minimum behavior:

```txt
/agent Explore
```

If no argument is provided, show the currently selected main agent and the configured options.

## Implementation Direction

Replace the old subprocess approach (`pi --mode json -p --no-session`) with in-process Pi sessions using `createAgentSession(...)`.

Use:

- `createAgentSession(...)` for sub-agent sessions;
- normal `SessionManager` storage for persistent sub-agent sessions;
- `before_agent_start` to render and inject configured main-agent prompts;
- `registerTool` for `Task`;
- `registerCommand` for `/dump-prompt` and `/agent`;
- `registerFlag` only if the installed Pi API supports the needed string startup flag;
- `session_start`, `session_shutdown`, and session switch events to restore and clean sub-agent metadata.

Sub-agent metadata must persist enough information to resume after process restart:

- main session identifier or file;
- short hex ID;
- human display name;
- configured agent type;
- sub-agent session file or ID;
- parent agent ID if any;
- current depth.

Store metadata in a way that does not require modifying Pi core. Prefer extension-managed metadata associated with the main session. If Pi has no clean metadata attachment point, use an extension-owned sidecar file keyed by the main session file/ID.

## Rendering And UX

Tool call display should show:

- `Task`;
- configured agent type;
- short description;
- hex ID when known;
- human display name when known;
- whether it is a new run or resume.

Tool result display should show:

- final sub-agent response;
- ID and display name for reuse;
- warnings about omitted tools/extensions;
- model/usage information if available without excessive complexity.

The parent model must receive the short hex ID in the tool result so it can resume the same agent later.

## Tests And Acceptance Criteria

Test or manually verify:

- `Task` starts a configured agent and returns final output.
- New `Task` calls create a short hex ID and unique human display name.
- `resume` continues a previous sub-agent transcript.
- Sub-agent sessions survive quitting Pi and resuming the same main session.
- `/new` clears sub-agent metadata/sessions for the old main session.
- `{{tools}}` and `{{guidelines}}` include only active tools for that agent.
- Missing extension tools are omitted and warned about.
- Unknown prompt placeholders fail loudly.
- Depth blocks disallowed nested spawns.
- `canSpawn` blocks disallowed agent types.
- `/dump-prompt` works with no argument and with a configured agent name.
- `/agent <name>` selects a configured main-agent persona.
- Multiple `Task` calls in one model turn can execute concurrently through Pi's default parallel tool execution.

## Explicit Non-Goals

- Do not keep the old `parallel` and `chain` API.
- Do not add a max-subagent-count setting.
- Do not add an ephemeral/persistent toggle; all sub-agents persist by default.
- Do not manually duplicate full tool parameter schemas inside prompt text.
- Do not rely on private Pi internals unless no public route exists and the limitation is documented first.
