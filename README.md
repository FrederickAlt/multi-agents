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
| `{{depth}}` | Nesting depth (`0` for root) |

Any unrecognised variable is a hard error at render time.
