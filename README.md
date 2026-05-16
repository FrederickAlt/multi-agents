# Persistent Task Subagents

Pi extension for persistent configured sub-agents via the `Task` tool.

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
