# Technical Design: Launcher-Enforced Root Agent Extension Isolation

## Status

Draft. This document records the parts of the design that are already settled and isolates only high-impact architectural decisions that still need confirmation.

## Problem

The multi-agents `extensions:` field is intended to control which Pi extensions are available to a configured Root agent. Today that is true for Task subagents only, because this extension constructs their `DefaultResourceLoader` and passes `extensionsOverride: filterExtensionsForAgent(...)`.

For the Root agent, Pi constructs and loads extensions before the multi-agents extension resolves the Root agent. Therefore a globally configured extension can register tools, hooks, commands, providers, resources, or other side effects even when the resolved Root agent does not allow that extension.

Filtering only `pi.setActiveTools(...)` is insufficient when hooks or other extension elements must also be excluded. Disallowed Root extensions must not be loaded into the Pi process at all.

## Core Architecture

Add a launcher command owned by this package. Users launch Pi through this wrapper instead of plain `pi` when they want multi-agent Root isolation.

The wrapper resolves the target Root agent before spawning Pi, filters the Pi extension set according to that agent, and starts real Pi with extension auto-discovery disabled:

```bash
pi --no-extensions \
  -e <multi-agents-extension-entry> \
  -e <allowed-extension-entry-1> \
  -e <allowed-extension-entry-2> \
  ...original normalized pi args...
```

Pi's `--no-extensions` disables configured and auto-discovered extension loading, while explicit `-e` paths still load. This gives the wrapper a pre-load allowlist without modifying pi-mono.

## Invariants

1. A child Pi process is launched for exactly one resolved Root agent.
2. That child process loads only the extensions allowed by that Root agent plus protected multi-agents runtime extensions, except for explicit user-provided `-e/--extension` launch overrides.
3. Changing the Root agent requires restarting the child Pi process.
4. The multi-agents extension is launcher-managed and should not be used as a normally auto-loaded Pi extension.
5. Disallowed configured or auto-discovered extensions are not merely hidden from the model; they are absent from the child process and therefore cannot register hooks, commands, providers, or side effects.

## Extension Loading Model

The package should expose two runtime surfaces:

1. A launcher binary, for example `pi-agents`.
2. The existing Pi extension entrypoint, loaded only by the launcher with `-e`.

The extension entrypoint should guard against accidental non-wrapper activation by checking a launcher-provided environment variable, for example:

```txt
PI_MULTI_AGENTS_LAUNCHER=1
```

If the variable is absent, the extension must fail loudly with a clear diagnostic. Non-wrapper activation is not a supported degraded mode. The package should also stop advertising the extension as a normal auto-loaded Pi package entry, so normal `pi` does not load it by default.

## Wrapper Responsibilities

The wrapper performs these steps before spawning real Pi:

1. Parse the subset of Pi CLI arguments that affects session and Root-agent resolution.
2. Resolve the concrete target session file when launching an existing session.
3. Resolve the selected Root agent for that existing session, or resolve the launch Root agent for a new session.
4. Resolve Pi's configured extension candidates without loading them.
5. Filter configured and auto-discovered extension candidates using the same `AgentConfig.extensions` policy used for Task subagents.
6. Preserve explicit user-provided `-e/--extension` entries as force-loaded launch overrides.
7. Force-include the multi-agents extension itself.
8. Spawn real Pi with `--no-extensions` and explicit `-e` arguments for allowed extension entries, forced user extension entries, and the multi-agents entry.
9. Pass the resolved Root agent to the child through launcher environment when starting a new session.
10. Supervise the child process for wrapper-mediated restart requests.

## Session Resolution Before Launch

Pi already resolves sessions before loading extensions. The wrapper should mirror that pre-extension session resolution rather than starting a lightweight Pi process.

Relevant Pi APIs are available from `@mariozechner/pi-coding-agent`:

- `SessionManager.list(cwd, sessionDir)`
- `SessionManager.listAll()`
- `SessionManager.continueRecent(cwd, sessionDir)`
- `SessionManager.open(path, sessionDir)`
- `SessionManager.forkFrom(path, cwd, sessionDir)`
- `SettingsManager.create(cwd, agentDir)`
- `SessionSelectorComponent`

The exact private Pi helper `resolveSessionPath(...)` is small and can be mirrored:

1. If the session argument looks path-like or ends in `.jsonl`, treat it as a path.
2. Otherwise match it as a session ID prefix in current-cwd sessions.
3. Otherwise match it as a session ID prefix across all sessions.

### New Session

If no existing session is selected, the wrapper resolves the Root agent from explicit launch configuration and default Root-agent configuration.

The wrapper should not pre-create the session JSONL for normal new sessions. Pi's `SessionManager` intentionally delays flushing new session files until there is conversation content, so the clean path is to let the child Pi process create the session normally. The wrapper passes the resolved Root agent to the child through launcher environment, and the extension appends the selected-root-agent custom entry during `session_start` once Pi has created the session manager.

This applies even when the resolved agent is the default fallback. Persisting every resolved Root agent prevents sessions from drifting if `defaultRootAgent` or user configuration changes later.

### `--session <path-or-id>`

The wrapper resolves the concrete session path before spawning Pi, resolves the selected Root agent for that session, and passes the concrete path to the child as `--session <resolved-path>`.

### `--continue`

The wrapper resolves the most recent session before spawning Pi. If a recent session exists, the wrapper passes it to the child as `--session <resolved-path>`. If none exists, the wrapper treats this as a new session.

### `--resume`

The wrapper must perform the session picker before spawning Pi. It can reuse Pi's exported `SessionSelectorComponent` together with `SessionManager.list` and `SessionManager.listAll`. The selected path is then passed to the child as `--session <selected-path>`.

This avoids launching Pi with an unknown session and therefore avoids loading the wrong extension set.

### `--fork <path-or-id>`

The wrapper pre-resolves and pre-forks the session using `SessionManager.forkFrom(...)`, then spawns the child with `--session <forked-session-path>`.

The selected Root agent for the fork should be inherited from the source session.

## Root Agent Switching

`/agent <name>` becomes a wrapper-mediated standalone new-session restart rather than an in-process Root switch.

A session must not be relaunched as a different Root agent. Selecting a new Root agent creates a fresh standalone session for that agent. The new session should not reference the previous session as `parentSession`, and it should not inherit the previous session's conversation history.

Flow:

1. The extension validates the requested agent.
2. The extension writes a restart request to a wrapper-provided path, for example from `PI_MULTI_AGENTS_RESTART_FILE`. The request names the requested agent.
3. The extension asks Pi to shut down.
4. The wrapper observes the child exit, reads the restart request, resolves the requested agent's extension set, and respawns Pi as a fresh new session with the requested Root agent passed through launcher environment.
5. The restarted child Pi process creates the new session normally, and the extension appends the selected-root-agent custom entry during `session_start`.

The child process invariant remains simple: one Root agent, one extension set. Root-agent changes are represented by standalone new session files, not by mutating the Root agent of an existing session.

## Extension Candidate Resolution

The wrapper should resolve extension candidates without loading modules. It should use Pi's package/settings resolution APIs rather than reimplementing package discovery.

The intended source is `DefaultPackageManager.resolve(...)`, which returns resolved extension resources and metadata without importing extension modules. Configured and auto-discovered extension resources are filtered through the resolved Root agent policy before being passed to the child.

CLI `-e/--extension` arguments are explicit user launch overrides. The wrapper should resolve them separately in the same way Pi handles temporary extension sources and pass them through to the child even if they are not listed in the Root agent's `extensions:` allowlist.

### Agent `extensions:` Selector Semantics

Agent frontmatter `extensions:` entries are user-friendly selectors over the same extension candidates Pi would discover. They are not required to be opaque exact IDs.

The wrapper resolves extension candidates the same way Pi does, without loading modules, then matches each selector against candidate metadata such as configured source, concrete path, canonical path, package base directory, package-relative resource path, and display-oriented path/name aliases.

Selector outcomes:

- No match: emit a warning and load no extension for that selector.
- Exactly one match: load that extension.
- Multiple matches: emit an ambiguity warning and load all matching extensions.

Users can disambiguate by writing a more specific selector, including a path-like selector, in the agent frontmatter.

The actual matching implementation for configured and auto-discovered extensions should be shared with Task subagent filtering by refactoring `src/subagent/extension-filter.ts` into reusable identity/matching helpers. The policy must preserve these selector outcomes for both Root and Task subagent filtering.

## Isolation Scope

This design isolates Pi extensions only. It does not attempt to isolate all resources from disallowed packages.

Skills, prompt templates, themes, and other non-extension resources continue to follow normal Pi configuration and discovery unless separately controlled by existing Agent fields such as `skills` and `prompt_parts`.

This keeps the launcher focused on preventing disallowed extension hooks, tools, commands, providers, and extension side effects from entering the Root process.

## Protected Extension Rule

The multi-agents runtime extension must always be loaded, even if the Root agent has an explicit `extensions:` allowlist that omits it. Otherwise the launcher/enforcement machinery would disable itself.

This should reuse the existing protected extension naming logic in `src/subagent/protected-extension.ts`.

## Non-Goals

- Do not modify pi-mono.
- Do not mutate global or project Pi settings as part of normal launching.
- Do not try to unload extensions from an already-started Root Pi process.
- Do not rely on active-tool filtering as the full isolation mechanism.
- Do not isolate non-extension package resources such as skills, prompt templates, or themes in this design.

## Root Agent Selection Persistence

Root-agent selection is persisted only in the Pi session JSONL using Pi's built-in extension state mechanism: `custom` session entries.

The extension should append entries with a stable custom type, for example:

```json
{
  "type": "custom",
  "customType": "persistent-task-subagents:selected-root-agent",
  "data": {
    "version": 1,
    "agent": "planner"
  }
}
```

A launched session is associated with the selected Root agent recorded in its session file. Every launched session should get an entry for its resolved Root agent, including default fallback sessions. For new sessions, the wrapper passes the resolved agent to the child and the extension writes the entry during `session_start`. The existing `.task-subagents-<sessionId>.json` sidecar remains only for subagent records and must not be used for Root-agent selection.

Root-agent changes create standalone new sessions; they do not append a different selected Root agent to the existing session and do not link the new session to the old one as a parent.

This is an intentional breaking change. There is no migration or fallback from sidecar `selectedMainAgent`.

Consequences:

- A session file is self-contained for Root-agent selection.
- Moving or copying a session JSONL preserves its Root agent.
- Forked sessions inherit the selected Root agent naturally because `SessionManager.forkFrom(...)` copies session entries.
- The wrapper can resolve the selected Root agent by reading one artifact: the target session JSONL.
- Existing sessions without the custom entry fall back to launch/default Root-agent selection.
