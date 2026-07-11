# Multi-agents repository compass

<!-- CODEGRAPH_START -->
## Code discovery

This repository is indexed by CodeGraph (`.codegraph/` exists). Before using
grep/find or opening implementation files to locate code, use one of:

- `codegraph explore "<symbols or question>"` for relevant source and call paths.
- `codegraph node <symbol-or-file>` for one symbol or indexed source file.

Use normal file reads after CodeGraph when documentation, configuration, or an
unindexed file is needed.
<!-- CODEGRAPH_END -->

## What this repository is

This package wraps Pi so it can control which extensions are loaded, then adds
persistent configured agents through the `Task` and `wait_for_agent` tools. An
Agent definition can run as either the user-facing Root agent or a delegated
sub-agent. Sub-agents are real Pi sessions with independent transcripts and can
be resumed by ID.

There are three main surfaces:

- `pi-agents`: launcher that selects the Root runtime and starts native Pi.
- Multi-agents extension: Root prompt/lifecycle plus Task orchestration.
- `pi-agent-config`: Ink TUI for inspecting and editing Agent definitions.

Read `CONTEXT.md` for domain vocabulary, configuration semantics, persistence,
trust, and lifecycle details. Read `README.md` and `src/subagent/README.md` for
user-facing behavior.

## Architecture at a glance

```text
src/launcher/cli.ts
  -> src/launcher/pi-agents.ts
     -> native Pi + explicitly selected extensions
        -> src/subagent/index.ts
           -> prompt/root lifecycle modules
           -> task-tool-registration.ts
              -> task-controller.ts
                 -> metadata.ts
                 -> session-manager.ts
                 -> depth-policy.ts

src/tui/cli.ts
  -> src/tui/app.tsx
     -> discovery + state/hooks + frontmatter file I/O + components
```

The launcher owns CLI/session projection and Root extension control.
`subagent/index.ts` is the extension composition root. `TaskController` owns
use-case orchestration, while metadata, spawn policy, and live Pi-session state
remain in dedicated modules.

## Where to look

### Launcher and extension control

- `src/launcher/cli.ts` — `pi-agents` executable entry.
- `src/launcher/pi-agents.ts` — Pi arguments, session selection, Root runtime
  projection, extension selection, child process, and restart loop.
- `src/subagent/launcher-contract.ts` — launcher/extension environment and
  restart-file protocol.
- `src/subagent/extension-resolution.ts` — trust-aware resource resolution
  before extension execution.
- `src/subagent/extension-filter.ts` — per-Agent extension selection and alias
  matching.
- `src/subagent/protected-extension.ts` — extensions that policy filtering must
  retain.

### Root and Task runtime

- `src/subagent/index.ts` — extension entry and composition root: commands,
  events, Root prompt injection, trust restart, and concrete adapters.
- `src/subagent/task-tool-registration.ts` — `Task`/`wait_for_agent` Pi tool
  schemas, rendering, activation, and forwarding.
- `src/subagent/task-controller.ts` — create/resume, blocking/async execution,
  waiting, timeout, and abort orchestration.
- `src/subagent/session-manager.ts` — Pi child-session/model adapters, live
  session tracking, async result state, extension lifecycle, and disposal.
- `src/subagent/metadata.ts` — persistent child records, allocation, mutation,
  and cleanup.
- `src/subagent/depth-policy.ts` — single source of truth for spawn decisions.
- `src/subagent/output-extraction.ts` — terminal and partial-output handling.
- `src/subagent/context-usage.ts` — child context-window reporting.
- `src/subagent/async-agent-notifier.ts` — unconsumed async completion notices.
- `src/subagent/debug-logger.ts` — bounded, redacted runtime diagnostics.

### Definitions and prompts

- `src/subagent/markdown-definitions.ts` — shared Markdown/frontmatter loader.
- `src/subagent/agents.ts` — Agent registry, validation, and mode resolution.
- `src/subagent/root-agent.ts` — effective Root definition and session-local
  selection.
- `src/subagent/prompt-parts.ts` — prompt-fragment discovery.
- `src/subagent/prompt-composition.ts` — shared Root/Task prompt rendering.
- `src/subagent/reasoning-effort.ts` — Pi reasoning-level normalization.
- `src/subagent/seeding.ts` — bundled-to-user definition seeding.
- `src/subagent/agents/` and `src/subagent/prompt-parts/` — bundled seed assets.

### Configuration TUI

- `src/tui/cli.ts`, `src/tui/app.tsx` — executable entry and Ink app.
- `src/tui/discovery/options.ts` — Pi tools/extensions/models/skills discovery.
- `src/tui/hooks/useOptionDiscovery.ts` — asynchronous discovery lifecycle.
- `src/tui/hooks/useConfig.ts` — config actions and write coordination.
- `src/tui/file-io/` — body-preserving frontmatter reads/writes.
- `src/tui/state/` — state types, option semantics, and reducer.
- `src/tui/components/` — terminal presentation.
- `src/tui/dev/` — deterministic text rendering for layout diagnosis.

## Test map

- `test/launcher*.test.ts` — launcher, sessions, restarts, trust, and guard.
- `test/task-controller.test.ts` — Task/wait orchestration.
- `test/subagent-session-manager.test.ts` — child lifecycle and disposal.
- `test/metadata-store.test.ts`, `depth-policy.test.ts`, and
  `async-agent-notifier.test.ts` — focused domain modules.
- `test/task-integration.test.ts` and
  `subagent-resource-loader.test.ts` — extension wiring without a live model.
- `test/tui/` and `test/tui-*.test.*` — TUI discovery, state, I/O, and layout.
- `test/task-llm.test.ts` — opt-in live-model integration.

## Common commands

```bash
npm run check       # Biome plus strict TypeScript
npm test            # Non-live Vitest suite
npm run build       # Compile dist and copy bundled seed assets
npm run tui:dump    # Render deterministic TUI frames as text
npm run test:llm    # Explicit live-model test
```

Tests alias Pi packages to the sibling `pi-mono` checkout. Use
`pi-agent-config --debug` or `--debug-dir <path>` for manual TUI tests that
must not touch real user definitions.

## Guardrails

- Never edit the Markdown body of `src/subagent/agents/*.md` or
  `src/subagent/prompt-parts/*.md` without explicit user instruction.
- Keep Root and Task prompt rendering unified in `prompt-composition.ts`.
- Keep spawn authorization in `depth-policy.ts`, metadata persistence in
  `metadata.ts`, and live Pi-session ownership in `session-manager.ts`.
- Resolve/filter extension candidates before importing or executing them, and
  preserve Pi project-trust semantics.
- Await extension shutdown and session disposal without deleting resumable
  transcripts during normal disposal.
- Do not read credential-bearing Pi provider/auth files. Live-model tests are
  opt-in and use the provider/model specified by the user.
