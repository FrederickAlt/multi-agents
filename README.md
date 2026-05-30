# Persistent Task Subagents

Pi extension for persistent configured sub-agents via the `Task` and `wait_for_agent` tools.

## Prompt Parts

Rendered Agent definition prompts are composed from two sources:

1. **Agent definition body** — the markdown body of the agent's `.md` file (after YAML frontmatter).
2. **Prompt parts** — markdown fragments from `subagent/prompt-parts/*.md` (bundled), `~/.pi/agent/prompt-parts/*.md` (user), or `.pi/prompt-parts/*.md` (project).

Each part is rendered independently (variable substitution applied separately) and joined with double-newline separators after the main agent prompt. This lets projects and users inject shared context (tools, guidelines, runtime info) across all rendered Agent definitions without duplicating it in each file.

Prompt parts are applied whenever this extension renders an Agent definition: the configured Root agent, a session-local `/agent` selection, and Task sub-agents.

Agent definition symmetry means prompt-composition symmetry: the same Agent markdown body, prompt variables, skill filtering, explicit `{{context_files}}` placement, and prompt parts render with the same semantics for Root and Task sub-agents. Runtime placement can still differ for model/tool/extension/session behavior.

The Agent definition path is the full prompt contract. Pi's hidden generic suffix and append-system prompt material are not preserved; use prompt parts and explicit `{{context_files}}` placement instead.

Built-in prompt parts:
- `010-tools.md` — shared tool info (`{{tools}}`, `{{guidelines}}`)
- `020-runtime-context.md` — runtime context (`{{cwd}}`, `{{date}}`, `{{agent_name}}`, `{{agent_description}}`)

## Agent Config TUI Diagnostics

Use `npm run tui:dump` to render deterministic `pi-agent-config` board scenarios into plain terminal text. This gives coding agents and tests a shell-visible view of Ink layout changes without screenshots or a real terminal session.

For live config debugging without touching real prompts, run `pi-agent-config --debug`. The CLI copies the current agent config root to a temporary dummy path, points the TUI at that copy, and shows the dummy/source paths in a yellow debug banner. Use `--debug-dir <path>` to choose the dummy path explicitly.

For focused layout checks, import `renderToText` from `src/tui/dev/render-to-text.ts` and render the component with fixed `columns` / `rows`.

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
- **`can_spawn`** = spawn allowlist tri-state: missing = unrestricted by name, blank = spawn none, explicit list = only listed agent names.

A sub-agent with `depth: 0` cannot call Task at all, including `resume`. New Task calls and resume calls both pass through `DepthPolicy` checks.

## Task Runtime Limits

Task executions are bounded by a default runtime timeout of **30 minutes**.
If the limit is exceeded, Task fails with `execution_timeout` and the sub-agent transcript is retained for `resume`.

## Async Task Retrieval

Use `Task` with `blocking: false` to spawn a sub-agent immediately. Call `wait_for_agent` with one or more IDs to retrieve output later, including from finished blocking agents.

Async completion notifications are delivered at safe root-agent run boundaries: after the root agent reaches `agent_end` and would otherwise become idle, the extension re-checks which completed async agents are still unconsumed and sends a `[System]` follow-up with `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`. This starts an automatic follow-up turn; it does not wait for the next user input. Notifications are not pre-built at intermediate `turn_end` events because the root agent may still consume the result with `wait_for_agent` later in the same run.

`can_spawn` examples:
- field absent → any agent name may be spawned if depth allows it
- `can_spawn: []` → no agent names may be spawned
- `can_spawn: [explorer, reviewer]` → only `explorer` and `reviewer` may be spawned

## Prompt Parts

Prompt-part markdown files are `.md` files with YAML frontmatter that get appended to rendered Agent definition prompts. They follow the same conventions as agent definitions: frontmatter (at minimum a `description` field) + body with `{{variables}}`.

Locations (same precedence as agents: bundled → user → project):
- `subagent/prompt-parts/*.md` (bundled with the extension)
- `~/.pi/agent/prompt-parts/*.md` (user)
- `.pi/prompt-parts/*.md` (project, nearest walking up from CWD)
