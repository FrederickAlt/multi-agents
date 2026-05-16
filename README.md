# Persistent Task Subagents

Pi extension for persistent configured sub-agents via the `Task` tool.

## Prompt Parts

Rendered Agent definition prompts are composed from two sources:

1. **Agent definition body** — the markdown body of the agent's `.md` file (after YAML frontmatter).
2. **Prompt parts** — markdown fragments from `subagent/prompt-parts/*.md` (bundled), `~/.pi/agent/prompt-parts/*.md` (user), or `.pi/prompt-parts/*.md` (project).

Each part is rendered independently (variable substitution applied separately) and joined with double-newline separators after the main agent prompt. This lets projects and users inject shared context (tools, guidelines, runtime info) across all rendered Agent definitions without duplicating it in each file.

Prompt parts are applied whenever this extension renders an Agent definition: the configured Root agent, a session-local `/agent` selection, and Task sub-agents.

The Agent definition path is the full prompt contract. Pi's hidden generic suffix and append-system prompt material are not preserved; use prompt parts and explicit `{{context_files}}` placement instead.

Built-in prompt parts:
- `010-tools.md` — shared tool info (`{{tools}}`, `{{guidelines}}`)
- `020-runtime-context.md` — runtime context (`{{cwd}}`, `{{date}}`, `{{agent_name}}`, `{{agent_description}}`)

## Default Root Agent

The Root agent always resolves through a markdown Agent definition. If no session-local `/agent <name>` selection exists, the extension uses the configured `defaultRootAgent` flag, which defaults to `default`. The built-in `subagent/agents/default.md` can be overridden from `~/.pi/agent/agents/default.md` or the nearest `.pi/agents/default.md` like any other Agent definition.

A missing configured default is a hard error so configuration mistakes are visible.

## Prompt Template Variables

Agent markdown files support these `{{variable}}` substitutions in the system prompt body:

| Variable | Expands to |
|---|---|
| `{{tools}}` | Available tool names and snippets |
| `{{guidelines}}` | Tool usage guidelines |
| `{{context_files}}` | Loaded project context file contents, only at the explicit template location |
| `{{skills}}` | Available skill names and descriptions |
| `{{cwd}}` | Current working directory |
| `{{date}}` | Today's date (`YYYY-MM-DD`) |
| `{{agent_name}}` | Agent name (filename stem) |
| `{{agent_description}}` | Description from frontmatter |

Any unrecognised variable is a hard error at render time. Internal tree metadata such as parent IDs and depth is not available as prompt variables.

## Depth and Spawn Control

Depth controls how many levels of sub-agent spawning are allowed from the Root agent.

- **Tree depth** = current position in the agent tree (Root = 0, child = 1, grandchild = 2).
- **`depth` config** = how many more Task levels this agent's definition permits.
- **Root depth limit** = the absolute maximum tree depth the Root agent allows.
- **`canSpawn`** = optional allowlist of agent names this agent may delegate to (`undefined` = unrestricted).

A sub-agent with `depth: 0` cannot call Task at all, including `resume`.  New Task calls and resume calls both pass through `DepthPolicy` checks.

## Prompt Parts

Prompt-part markdown files are `.md` files with YAML frontmatter that get appended to rendered Agent definition prompts. They follow the same conventions as agent definitions: frontmatter (at minimum a `description` field) + body with `{{variables}}`.

Locations (same precedence as agents: bundled → user → project):
- `subagent/prompt-parts/*.md` (bundled with the extension)
- `~/.pi/agent/prompt-parts/*.md` (user)
- `.pi/prompt-parts/*.md` (project, nearest walking up from CWD)
