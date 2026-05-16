# Persistent Task Subagents

Pi extension for persistent configured sub-agents via the `Task` tool.

## Prompt Parts

Sub-agent system prompts are composed from two sources:

1. **Agent definition body** — the markdown body of the agent's `.md` file (after YAML frontmatter).
2. **Prompt parts** — markdown fragments from `subagent/prompt-parts/*.md` (bundled), `~/.pi/agent/prompt-parts/*.md` (user), or `.pi/prompt-parts/*.md` (project).

Each part is rendered independently (variable substitution applied separately) and joined with double-newline separators after the main agent prompt. This lets projects and users inject shared context (tools, guidelines, runtime info) across all sub-agents without duplicating it in each agent definition.

Prompt parts are **only applied to Task sub-agents**. The root/main agent prompt is unchanged.

Built-in prompt parts:
- `010-tools.md` — shared tool info (`{{tools}}`, `{{guidelines}}`)
- `020-runtime-context.md` — runtime context (`{{cwd}}`, `{{date}}`, `{{agent_name}}`, `{{depth}}`, `{{parent_agent_id}}`)

## Prompt Template Variables

Agent markdown files support these `{{variable}}` substitutions in the system prompt body:

| Variable | Expands to |
|---|---|
| `{{tools}}` | Available tool names and snippets |
| `{{guidelines}}` | Tool usage guidelines |
| `{{context_files}}` | Injected context file contents |
| `{{skills}}` | Available skill names and descriptions |
| `{{cwd}}` | Current working directory |
| `{{date}}` | Today's date (`YYYY-MM-DD`) |
| `{{agent_name}}` | Agent name (filename stem) |
| `{{agent_description}}` | Description from frontmatter |
| `{{parent_agent_id}}` | Parent agent's hex ID (empty for root) |
| `{{depth}}` | Tree depth — current position in agent tree (`0` for root) |

Any unrecognised variable is a hard error at render time.

## Depth and Spawn Control

Depth controls how many levels of sub-agent spawning are allowed from the Root agent.

- **Tree depth** = current position in the agent tree (Root = 0, child = 1, grandchild = 2).
- **`depth` config** = how many more Task levels this agent's definition permits.
- **Root depth limit** = the absolute maximum tree depth the Root agent allows.
- **`canSpawn`** = optional allowlist of agent names this agent may delegate to (`undefined` = unrestricted).

A sub-agent with `depth: 0` cannot call Task at all, including `resume`.  New Task calls and resume calls both pass through `DepthPolicy` checks.

## Prompt Parts

Prompt-part markdown files are `.md` files with YAML frontmatter that get appended to sub-agent system prompts. They follow the same conventions as agent definitions: frontmatter (at minimum a `description` field) + body with `{{variables}}`.

Locations (same precedence as agents: bundled → user → project):
- `subagent/prompt-parts/*.md` (bundled with the extension)
- `~/.pi/agent/prompt-parts/*.md` (user)
- `.pi/prompt-parts/*.md` (project, nearest walking up from CWD)
