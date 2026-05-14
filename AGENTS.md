## What this project does

This is a **Pi extension** that adds a `Task` tool to Pi. The `Task` tool lets the model delegate autonomous work to **persistent sub-agents** — real Pi `AgentSession` instances with their own transcripts, tools, and config. Each sub-agent survives across Pi restarts, is identified by a short hex ID, and can be resumed later for follow-up work.

Sub-agents are configured via **agent definition files** — markdown files with YAML frontmatter. The project ships four built-in agents (`explorer`, `planner`, `reviewer`, `coder`), and users or projects can add their own.

## Project structure

```
multi-agents/
├── package.json              # npm package. pi.extensions points to ./subagent/index.ts
├── README.md                 # Human-facing README (features, commands, config)
├── CONTEXT.md                # Domain vocabulary (root agent, sub-agent, depth, etc.)
├── vitest.config.ts          # Vitest config with path aliases into pi-mono monorepo
├── subagent/
│   ├── index.ts              # Extension entry point — Task tool, commands, lifecycle
│   ├── agents.ts             # Agent discovery & config parsing from markdown files
│   ├── README.md             # Detailed feature documentation
│   └── agents/               # Built-in agent definition files
│       ├── explorer.md       # Fast read-only codebase exploration
│       ├── planner.md        # Read-only implementation planning
│       ├── reviewer.md       # Read-only code review
│       └── coder.md          # Fast coding agent for implementing plans
├── test/
│   ├── agents.test.ts        # Unit tests for agent discovery and config parsing
│   ├── task-utils.test.ts    # Unit tests for pure functions (hex IDs, names, rendering, metadata)
│   ├── task-integration.test.ts  # Integration tests (extension loading, tool registration)
│   └── task-llm.test.ts      # LLM integration tests (real Task execution with a live model)
└── docs/                     # Reserved for future documentation
```

## Core modules and where to find things

### `subagent/index.ts` — Extension entry point

Registers the `Task` tool and two commands (`/agent`, `/dump-prompt`). Handles the full sub-agent lifecycle:

- **Task tool execution** (`runTask`): resolves agent config, checks spawn permissions, allocates hex IDs, creates or resumes sessions, runs the prompt, returns results.
- **Prompt template rendering** (`renderPromptTemplate`): replaces `{{variables}}` in agent markdown with live context (tools, guidelines, cwd, date, etc.). Unknown variables are hard errors.
- **Metadata persistence** (`loadMetadata`, `saveMetadata`, `metadataPath`): stores sub-agent records in a sidecar JSON file (`.task-subagents-<sessionId>.json`) next to the root session. Concurrent-safe via a promise-based lock.
- **Session lifecycle**: sessions are disposed after each `Task` call to prevent unbounded memory. The on-disk session file is preserved so resuming reopens from disk.
- **Commands**:
  - `/agent <name>` — selects a configured agent persona as the main/user-facing agent. Persisted in metadata.
  - `/dump-prompt [name]` — prints the resolved system prompt for the current or named agent. Implemented by this extension.
- **Events**: hooks `session_start`, `session_shutdown`, and `before_agent_start` to manage metadata, clean up sessions on `/new`, and inject agent prompts for the main persona.

Key types: `SubagentRecord`, `MetadataFile`, `TaskDetails`, `RenderContext`, `PromptParts`, `RuntimeContext`.

### `subagent/agents.ts` — Agent discovery and configuration

Discovers agent definitions from three sources (in priority order, later overrides earlier):

1. **Bundled** — `subagent/agents/*.md` (shipped with the extension)
2. **User** — `~/.pi/agent/agents/*.md`
3. **Project** — nearest `.pi/agents/*.md` walking up from CWD

Agent markdown files use YAML frontmatter for configuration. The **filename stem** becomes the agent name (not a frontmatter field). Supported frontmatter fields:

| Field | Type | Description |
|-------|------|-------------|
| `description` | string (required) | Short description shown in agent lists |
| `tools` | comma-separated string | Whitelist of tool names (e.g. `read, grep, bash`) |
| `extensions` | comma-separated string | Filter for which extensions to load |
| `model` | string | Model override (e.g. `claude-haiku-4-5` or `provider/id`) |
| `reasoning_effort` | string | Thinking/reasoning effort level |
| `depth` | number | Maximum nesting depth this agent can spawn (0 = no spawns) |
| `canSpawn` | comma-separated string | Allowlist of agent types this agent may spawn |

Key functions: `discoverAgents(cwd, scope)`, `formatAgentList(agents, maxItems)`.

### `subagent/agents/*.md` — Built-in agent definitions

| Agent | Model | Tools | Depth | canSpawn | Purpose |
|-------|-------|-------|-------|----------|---------|
| `explorer` | deepseek-v4-flash | All | 0 | — | Fast read-only codebase recon, returns structured findings |
| `planner` | deepseek-v4-pro | All | 0 | — | Read-only implementation planning |
| `reviewer` | deepseek-v4-pro | read, grep, find, ls, bash | 0 | — | Code review (read-only bash only) |
| `coder` | deepseek-v4-flash | All | 0 | explorer, planner, reviewer, coder | Fast coding agent for implementing plans |

### Test files

- **`test/agents.test.ts`** — Tests `discoverAgents`, `formatAgentList`, frontmatter parsing, depth handling, project agent discovery with temp directories.
- **`test/task-utils.test.ts`** — Tests `randomHexId`, `pickHumanName`, `renderPromptTemplate`, `loadMetadata`/`saveMetadata`, `getFinalTextFromMessages`, `checkSpawnAllowed`, `resolveTaskAgent`.
- **`test/task-integration.test.ts`** — Tests extension loading, Task tool registration with correct schema, prompt snippet/guidelines presence. No real LLM calls.
- **`test/task-llm.test.ts`** — End-to-end tests with a real LLM (deepseek-v4-flash). Tests spawning a subagent that reads a file, and resuming a subagent to verify conversation memory. Skipped when no API key is available.

Run tests with `npm test` (vitest).

## Key design decisions

### Spawn control via depth and canSpawn

Every agent has an optional `depth` field (default ∞ for the root agent, 0 for built-in sub-agents). `depth` is the maximum nesting level: depth 0 means no further sub-agents can be spawned, depth 1 allows sub-agents but no grandchildren, etc. The `canSpawn` field further restricts which agent types are allowed.

### Prompt template variables

Agent system prompts support 10 required variables: `{{tools}}`, `{{guidelines}}`, `{{context_files}}`, `{{skills}}`, `{{cwd}}`, `{{date}}`, `{{agent_name}}`, `{{agent_description}}`, `{{parent_agent_id}}`, `{{depth}}`. Unknown variables throw at render time.

### Metadata persistence

Sub-agent records live in `.task-subagents-<sessionId>.json` in the session directory. Each record stores the hex ID, human name, display name, agent type, session file path, depth, parent ID, and timestamps. The file is read on session start and cleaned up on `/new`.

### Concurrency

Concurrent `Task` calls are serialized through a metadata lock promise to prevent ID collision. After the lock is acquired, metadata is re-read to pick up any records written by earlier tasks.

### Session disposal

Sub-agent `AgentSession` objects are disposed after each `Task` call. The on-disk session file is preserved so `resume` can reopen it. This prevents unbounded memory accumulation when many sub-agents are spawned.

## Dependencies

- **Runtime**: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui` — the Pi platform packages they are found at `~/p/AI/pi_extensions/pi-mono/packages/coding-agent` etc.
- **Schema validation**: `typebox` for the Task tool parameter schema
- **Testing**: `vitest` with path aliases resolving to local `pi-mono` source
- **Node builtins**: `fs`, `path`, `crypto` (for random hex IDs), `url`

## Working on this project

1. The project lives inside a `pi_extensions` directory, with `pi-mono` at `../../pi-mono/` (referenced in vitest.config.ts aliases).
2. Agent markdown files are the primary configuration mechanism. To add a new agent type, create a `.md` file in `subagent/agents/` (bundled), `~/.pi/agent/agents/` (user), or `.pi/agents/` (project).
3. The extension registers itself via `package.json` → `pi.extensions: ["./subagent/index.ts"]`.
4. When modifying prompt templates, ensure `REQUIRED_TEMPLATE_VARS` in `index.ts` stays in sync with the variables used in agent markdown.
