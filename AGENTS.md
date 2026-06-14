## What this project does

This is a **Pi extension** that adds `Task` and `wait_for_agent` tools to Pi. The `Task` tool lets the model delegate autonomous work to **persistent sub-agents** — real Pi `AgentSession` instances with their own transcripts, tools, and config. Each sub-agent survives across Pi restarts, is identified by a short hex ID, and can be resumed later for follow-up work.

Agents are configured via **agent definition files** — markdown files with YAML frontmatter. The project ships five built-in agents (`default`, `explorer`, `planner`, `reviewer`, `coder`), and users or projects can add their own.

## Project structure

```
multi-agents/
├── package.json              # npm package. pi.extensions points to ./src/subagent/index.ts
├── README.md                 # Human-facing README (features, commands, config)
├── CONTEXT.md                # Domain vocabulary (root agent, sub-agent, depth, etc.)
├── vitest.config.ts          # Vitest config with path aliases into pi-mono monorepo
├── src/subagent/
│   ├── index.ts              # Extension entry point — Task and wait_for_agent tools, commands, lifecycle
│   ├── agents.ts             # Agent discovery & config parsing from markdown files
│   ├── markdown-definitions.ts # Generic markdown-definition loader (shared by agents + prompt-parts)
│   ├── prompt-parts.ts       # Prompt-part discovery (calls markdown-definitions.ts)
│   ├── prompt-composition.ts # Shared Agent-definition prompt renderer used by Root + Task sub-agents
│   ├── README.md             # Detailed feature documentation
│   ├── agents/               # Built-in agent definition files
│   │   ├── default.md        # Default Root coding assistant
│   │   ├── explorer.md       # Fast read-only codebase exploration
│   │   ├── planner.md        # Read-only implementation planning
│   │   ├── reviewer.md       # Read-only code review
│   │   └── coder.md          # Fast coding agent for implementing plans
│   └── prompt-parts/         # Built-in prompt-part fragments appended to rendered Agent definitions
│       ├── 010-tools.md      # Shared tool information for rendered Agent definitions
│       └── 020-runtime-context.md  # Runtime context (cwd, date, agent name/description)
├── test/
│   ├── agents.test.ts        # Unit tests for agent discovery and config parsing
│   ├── task-utils.test.ts    # Unit tests for pure functions (hex IDs, names, rendering, metadata)
│   ├── task-integration.test.ts  # Integration tests (extension loading, tool registration)
│   ├── subagent-resource-loader.test.ts # Sub-agent resource-loader prompt semantics
│   └── task-llm.test.ts      # LLM integration tests (real Task execution with a live model)
└── docs/                     # Reserved for future documentation
```

## Core modules and where to find things

### `src/subagent/index.ts` — Extension entry point

Registers the `Task` and `wait_for_agent` tools plus the `/agent` and `/dump-prompt` commands. Handles the full sub-agent lifecycle:

- **Task tool execution** (`runTask`): resolves agent config, checks spawn permissions, allocates hex IDs, creates or resumes sessions, runs the prompt, returns results.
- **Prompt composition**: delegates to `prompt-composition.ts` so Root agents and Task sub-agents use the same Agent-definition rendering path.
- **Metadata persistence** (`MetadataStore`): stores sub-agent records in a sidecar JSON file (`.task-subagents-<sessionId>.json`) next to the root session. Concurrent-safe via a promise-based lock.
- **Session lifecycle**: sessions are disposed after each `Task` call to prevent unbounded memory. The on-disk session file is preserved so resuming reopens from disk.
- **Commands**:
  - `/agent <name>` — selects a configured agent persona as the Root agent for the current session. Persisted in session metadata.
  - `/dump-prompt [next]` — dumps the current rendered multi-agents Root prompt, or with `next` dumps the exact prompt sent on the next provider request.
- **Events**: hooks `session_start`, `session_shutdown`, and `before_agent_start` to manage metadata, clean up sessions on `/new`, resolve the default/session-local Root agent, and inject rendered Agent definition prompts.

Key types: `SubagentRecord`, `MetadataFile`, `TaskDetails`, `RuntimeContext`. Import implementation types from their owning modules rather than from the extension entry point.

### `src/subagent/markdown-definitions.ts` — Generic markdown-definition loader

Owns the shared logic for discovering markdown definition files from bundled, user, and project directories. Used by both agents.ts and prompt-parts.ts.

- **`discoverMarkdownDefinitions(options)`** — orchestrates discovery with bundled → user → project precedence. Returns `{ definitions, diagnostics, projectDir }`.
- **`loadDefinitionsFromDir(dir, source, diagnostics)`** — reads .md files from a directory, parses YAML frontmatter, derives name from filename stem.
- **`findNearestProjectDir(cwd, kind)`** — walks up from cwd looking for `.pi/<kind>/`.

Types: `RawMarkdownDefinition`, `MarkdownDiagnostic`, `MarkdownDiscoveryOptions`, `MarkdownDefinitionSource`.

### `src/subagent/root-agent.ts` — Root agent resolution

Resolves the effective Root Agent definition from the session-local `/agent` selection or the configured `defaultRootAgent` fallback (default: `default`). A missing configured default is a hard error instead of falling back to raw Pi behavior.

Key functions: `resolveRootAgent(options)`. Key constants: `DEFAULT_ROOT_AGENT_NAME`.

### `src/subagent/prompt-composition.ts` — Shared Agent-definition prompt composition

Owns the stable prompt-rendering interface used by both Root agents and Task sub-agents. It replaces `{{variables}}` in agent markdown with live context (tools, guidelines, cwd, date, context files, skills, etc.), rejects unknown variables, applies skill filtering, renders prompt-part fragments independently, and intentionally ignores Pi raw/base and append-system prompt material.

Agent definition symmetry in this project means prompt-composition symmetry. The same Agent markdown body, prompt variables, skill filtering, explicit `{{context_files}}` placement, and prompt parts render with the same semantics for Root and Task sub-agents; runtime placement can still differ for model/tool/extension/session behavior.

Key types: `RenderContext`, `PromptParts`. Key functions: `renderTemplateString`, `renderPromptTemplate`, `renderSubagentSystemPrompt`, `renderComposedAgentSystemPrompt`, `buildTemplateValues`.

### `src/subagent/prompt-parts.ts` — Prompt-part discovery

Discovers prompt-part fragment files that get appended to rendered Agent definition prompts at render time. Calls `discoverMarkdownDefinitions` internally.

Discovery paths:
1. **Bundled** — `src/subagent/prompt-parts/*.md` (shipped with the extension)
2. **User** — `~/.pi/agent/prompt-parts/*.md`
3. **Project** — nearest `.pi/prompt-parts/*.md` walking up from CWD

- **`discoverPromptParts(cwd, scope)`** — returns `{ parts: PromptPartConfig[], diagnostics, projectDir }`.

Types: `PromptPartConfig`, `PromptPartDiscoveryResult`.

### `src/subagent/agents.ts` — Agent discovery and configuration

Discovers agent definitions from three sources (in priority order, later overrides earlier):

1. **Bundled** — `src/subagent/agents/*.md` (shipped with the extension)
2. **User** — `~/.pi/agent/agents/*.md`
3. **Project** — nearest `.pi/agents/*.md` walking up from CWD

Internally calls `discoverMarkdownDefinitions` and maps `RawMarkdownDefinition` → `AgentConfig`. Agent markdown files use YAML frontmatter for configuration. The **filename stem** becomes the agent name (not a frontmatter field). Supported frontmatter fields:

| Field | Type | Description |
|-------|------|-------------|
| `description` | string (required) | Short description shown in agent lists |
| `tools` | YAML list | Whitelist of tool names (e.g. `[read, grep, bash]`) |
| `extensions` | YAML list | Filter for which extensions to load |
| `model` | string | Model override (e.g. `claude-haiku-4-5` or `provider/id`) |
| `reasoning_effort` | string | Thinking/reasoning effort level |
| `depth` | number | Maximum nesting depth this agent can spawn (0 = no spawns) |
| `can_spawn` | YAML list | Spawn allowlist tri-state: missing = unrestricted, blank = spawn none, values = only listed agent types |
| `skills` | YAML list | Skill prompt filtering (tri-state: missing=all, blank=none, values=filter) |
| `prompt_parts` | YAML list | Prompt-part filtering (tri-state: missing=all, blank=none, values=filter) |

Key functions: `discoverAgents(cwd, scope)`, `formatAgentList(agents, maxItems)`.

### `src/tui/dev/render-to-text.ts` — Agent config TUI diagnostics

Provides `renderToText(element, { columns, rows })`, which renders Ink components into a deterministic fake terminal and returns the visible frame as plain text. Use this when debugging `pi-agent-config` layout issues so an agent can inspect the actual boxed TUI output from shell/test output without screenshots or an interactive terminal.

The related `npm run tui:dump` script runs `src/tui/dev/render-scenarios.tsx` and prints several fixed `Board` scenarios. This is the quickest way to see whether agent config columns are jumping, wrapping, or scrolling unexpectedly. When manually testing config writes or the live TUI, use `pi-agent-config --debug` (or `--debug-dir <path>`) so changes are written to a dummy config path instead of real prompt files.

### `src/subagent/agents/*.md` — Built-in agent definitions

| Agent | Model | Tools | Depth | can_spawn | Purpose |
|-------|-------|-------|-------|-----------|---------|
| `default` | inherited | All | 1 | — | Default Root coding assistant |
| `explorer` | deepseek-v4-flash | All | 0 | — | Fast read-only codebase recon, returns structured findings |
| `planner` | deepseek-v4-pro | All | 0 | — | Read-only implementation planning |
| `reviewer` | deepseek-v4-pro | read, grep, find, ls, bash | 0 | — | Code review (read-only bash only) |
| `coder` | deepseek-v4-flash | All | 0 | explorer, planner, reviewer, coder | Fast coding agent for implementing plans |

### Test files

- **`test/agents.test.ts`** — Tests `discoverAgents`, `formatAgentList`, frontmatter parsing, depth handling, project agent discovery with temp directories.
- **`test/root-agent.test.ts`** — Tests Root agent resolution: configured default fallback, session-local selection precedence, and missing-default errors.
- **`test/task-utils.test.ts`** — Tests prompt template and prompt-composition behavior.
- **`test/task-integration.test.ts`** — Tests extension loading, Task tool registration with correct schema, prompt snippet/guidelines presence. No real LLM calls.
- **`test/subagent-resource-loader.test.ts`** — Tests Task sub-agent resource-loader prompt semantics: native context injection disabled while explicit `{{context_files}}` rendering still works.
- **`test/task-llm.test.ts`** — End-to-end tests with a real LLM (deepseek-v4-flash). Tests spawning a subagent that reads a file, and resuming a subagent to verify conversation memory. Skipped when no API key is available.

Run tests with `npm test` (vitest).

For TUI diagnostics, run `npm run tui:dump` to print shell-visible `pi-agent-config` board snapshots. Tests can import `renderToText` from `src/tui/dev/render-to-text.ts` for focused layout assertions. When manually testing config writes or the live TUI, use `pi-agent-config --debug` (or `--debug-dir <path>`) so changes are written to a dummy config path instead of real prompt files.

## Build, Test, Lint

```bash
npm run check       # Biome lint/format + strict TypeScript; writes safe fixes; does not run tests
npm test            # Vitest tests; real LLM tests skipped by default
npm run test:watch  # Vitest watch mode
npm run test:llm    # Opt-in real LLM tests; requires local Pi auth
npm run tui:dump    # Render deterministic TUI scenarios as terminal text
```

`npm run check` mirrors pi-mono: it runs `biome check --write --error-on-warnings .` and `tsgo --noEmit`. Because Biome runs with `--write`, it may modify code files.

Tests require a sibling Pi checkout because `vitest.config.ts` aliases Pi packages from `../pi-mono` or `../../pi-mono`. In CI, `earendil-works/pi` is checked out as `pi-mono`.

Prompt markdown files are user-owned. Do not format or lint `src/subagent/agents/*.md` or `src/subagent/prompt-parts/*.md`; they are intentionally excluded from Biome.

## Key design decisions

### Spawn control via depth and can_spawn

Every agent has an optional `depth` field. The built-in `default` Root agent uses `depth: 1`; the built-in specialist sub-agents use `depth: 0`. `depth` is the maximum nesting level: depth 0 means no further sub-agents can be spawned, depth 1 allows sub-agents but no grandchildren, etc. The `can_spawn` field further restricts which agent types are allowed.

`can_spawn` has tri-state semantics:
- **Missing** (`can_spawn` field absent) → unrestricted by name; depth still applies.
- **Empty array** (`can_spawn: []`) → spawn no agents.
- **Explicit list** (`can_spawn: [explorer, reviewer]`) → spawn only those agent types.

### Prompt template variables

Agent and prompt-part system prompts support 8 required variables: `{{tools}}`, `{{guidelines}}`, `{{context_files}}`, `{{skills}}`, `{{cwd}}`, `{{date}}`, `{{agent_name}}`, `{{agent_description}}`. Unknown variables throw at render time. Internal tree metadata such as parent IDs and depth is intentionally not available as prompt variables.

Variable substitution is performed in `prompt-composition.ts` by `renderTemplateString(template, values, label)`, which replaces `{{variable}}` placeholders against a values map. `renderPromptTemplate(context)` renders the agent's own markdown body. `renderSubagentSystemPrompt(context, promptParts)` renders the agent prompt followed by zero or more resolved prompt-part fragments, each rendered independently and joined with double-newline separators.

### Skill prompt filtering

Each agent definition can specify a `skills` frontmatter field with tri-state semantics:
- **Missing** (`skills` field absent) → all inherited skill prompt content appears in `{{skills}}`
- **Empty array** (`skills: []`) → no skill prompt content (agent receives no skill guidance in its prompt)
- **Explicit list** (`skills: [tdd, diagnose]`) → only matching named skills appear in `{{skills}}`

Skill filtering affects prompt content only. It does not disable runtime skill commands, tools, extensions, or user-invoked skills. The same filtered skill list is visible throughout the render context, including agent definition bodies and prompt-part fragments.

### Prompt parts

Prompt parts are markdown fragments that get appended to rendered Agent definition prompts at render time. They are discovered from the same three sources as agent definitions (bundled, user, project) with the same precedence. Each part is a .md file with YAML frontmatter (at minimum a `description` field) and a body that may contain `{{variables}}`.

Prompt parts apply to the configured Root agent, session-local `/agent` selections, and Task sub-agents. They are discovered fresh for the agent's effective working directory, so project-specific prompt-parts can extend or override built-in ones.

Built-in prompt parts:
- `010-tools.md` — Shared tool information (`{{tools}}`, `{{guidelines}}`)
- `020-runtime-context.md` — Runtime context (cwd, date, agent name and description)

Users and projects can add their own: `~/.pi/agent/prompt-parts/*.md` or `.pi/prompt-parts/*.md`.

### Metadata persistence

Sub-agent records live in `.task-subagents-<sessionId>.json` in the session directory. Each record stores the hex ID, human name, display name, agent type, session file path, depth, parent ID, and timestamps. The file is read on session start and cleaned up on `/new`.

### Concurrency

Concurrent `Task` calls are serialized through a metadata lock promise to prevent ID collision. After the lock is acquired, metadata is re-read to pick up any records written by earlier tasks.

### Session disposal

Sub-agent `AgentSession` objects are disposed after each `Task` call. The on-disk session file is preserved so `resume` can reopen it. This prevents unbounded memory accumulation when many sub-agents are spawned.

### Debug logging

The extension includes an isolated debug logger for tracing Task and async wait/kill flow.

- Enablement: local constant in `src/subagent/debug-logger.ts`, `MULTI_AGENTS_DEBUG_LOGGING_ENABLED` (currently `true` in this checkout).
- Logs: `.task-subagents-<sessionId>.debug.jsonl` in the root session directory when enabled.
- Redaction: sensitive keys (`authorization`, `bearer`, `cookie`, `password`, `secret`, `secret_key`, `token`, `apikey`, `api_key`, `access_token`, `refresh_token`) are redacted; values are truncated for bounded size.

## Dependencies

- **Runtime**: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui` — the Pi platform packages they are found at `~/p/AI/pi_extensions/pi-mono/packages/coding-agent` etc.
- **Schema validation**: `typebox` for the Task tool parameter schema
- **Testing**: `vitest` with path aliases resolving to local `pi-mono` source
- **Node builtins**: `fs`, `path`, `crypto` (for random hex IDs), `url`

## Working on this project

1. The project lives inside a `pi_extensions` directory, with `pi-mono` at `../../pi-mono/` (referenced in vitest.config.ts aliases).
2. Agent markdown files are the primary configuration mechanism. To add a new agent type, create a `.md` file in `src/subagent/agents/` (bundled), `~/.pi/agent/agents/` (user), or `.pi/agents/` (project).
3. Prompt-part markdown files can be added to `src/subagent/prompt-parts/` (bundled), `~/.pi/agent/prompt-parts/` (user), or `.pi/prompt-parts/` (project).
4. The generic markdown loader (`markdown-definitions.ts`) is shared by both agent and prompt-part discovery. Adding a new kind of markdown definition should reuse this loader.
5. The extension registers itself via `package.json` → `pi.extensions: ["./src/subagent/index.ts"]`.
6. When modifying prompt templates, ensure `REQUIRED_TEMPLATE_VARS` in `prompt-composition.ts` stays in sync with the variables used in agent and prompt-part markdown.
7. **CRITICAL: Never modify agent/prompt-part body content.** Only the user writes prompts. You may edit YAML frontmatter fields (`description`, `tools`, `model`, `depth`, `can_spawn`, `prompt_parts`, `reasoning_effort`, `extensions`) in `src/subagent/agents/*.md` and `src/subagent/prompt-parts/*.md`, but the markdown body below the `---` separator is strictly off-limits without explicit user instruction.
