# PRD: Root Agent Extension Isolation

## Problem

Configured Root agents have an `extensions:` frontmatter field that is intended to define which Pi extensions are available to that agent. This is currently not enforced for Root agents.

Task subagents already get proper extension filtering because the multi-agents extension creates their Pi resource loader and can pass an extension filter before their runtime is built. Root agents are different: Pi loads globally/project configured extensions before the multi-agents extension resolves the active Root agent. As a result, a Root agent can receive tools, hooks, commands, providers, and other side effects from extensions that are not listed in its `extensions:` allowlist.

This causes concrete bugs such as the default Root agent seeing PDF/LaTeX tools from the PDF preview extension even though the default agent config does not allow that extension.

Filtering the active tool list after startup is not enough. Disallowed extensions may already have installed hooks, commands, providers, resource handlers, or other behavior that can affect the agent. The desired behavior is that disallowed Root extensions are not loaded into the Pi process at all.

## Goal

Provide launcher-enforced Root agent extension isolation without modifying pi-mono.

Users should start Pi through the multi-agents launcher. For normal launches and final session launches, the launcher resolves the Root agent before starting the final Pi child, computes the extensions allowed by that Root agent, and starts Pi with only those extensions loaded.

Startup `--resume` intentionally uses a protected bootstrap child to preserve Pi's native resume picker UX. The bootstrap child loads only the launcher-managed multi-agents extension, lets Pi select the session, and immediately restarts into the final filtered child once the selected session is known.

## Desired State

When a user launches through the multi-agents launcher:

1. The active Root agent is known before each final Pi child process starts.
2. Pi extension auto-discovery is disabled for every launcher-managed child process.
3. Final child processes load only these extensions:
   - extensions allowed by the resolved Root agent's `extensions:` frontmatter,
   - protected multi-agents runtime extension(s),
   - explicit user-provided `-e/--extension` launch overrides.
4. Startup `--resume` may use a bootstrap child before the selected session is known. That bootstrap child loads only protected multi-agents runtime extension(s), shows Pi's native resume picker, and restarts into a final filtered child after selection.
5. Extensions not allowed by the Root agent are absent from final processes and cannot register tools, hooks, commands, providers, or side effects.
6. Task subagent extension filtering continues to work with the same policy as Root filtering.
7. Root agent selection is persisted in the Pi session JSONL using Pi custom session entries.
8. Resuming or continuing a session restores the Root agent recorded in that session.
9. Switching Root agents with `/agent <name>` starts a fresh standalone session for that agent with a newly computed extension set.

## User-Facing Requirements

### Launcher Entry Point

The package provides a launcher command, for example `pi-agents`. This is the supported way to use the multi-agents Root-agent system.

The launcher starts final Pi children with extension discovery disabled and explicit extension entries, conceptually:

```bash
pi --no-extensions \
  -e <multi-agents-extension> \
  -e <allowed-extension> \
  ...
```

For startup `--resume`, the launcher starts a bootstrap Pi child with extension discovery disabled, only the multi-agents extension injected, and Pi's original `--resume` flag preserved so Pi owns the resume picker UX.

### Extension Activation Contract

The multi-agents Pi extension is launcher-managed. It is injected by the launcher and is not a normally auto-loaded Pi extension.

If the extension is loaded outside the launcher, it must fail loudly with a clear diagnostic. A partial/degraded non-wrapper mode is not supported.

### Root Agent Extension Policy

Agent frontmatter `extensions:` entries are user-friendly selectors over the same extension candidates Pi would discover.

Selector behavior:

- no match: warn and load no extension for that selector,
- one match: load that extension,
- multiple matches: warn and load all matching extensions.

Users can disambiguate by writing a more specific selector, including a path-like selector.

Explicit command-line `-e/--extension` entries are user launch overrides and are force-loaded in final child processes even if the Root agent does not list them. During startup `--resume` bootstrap, these overrides are not loaded before session selection; they are preserved and applied to the final restarted child.

### Session Behavior

The selected Root agent is stored in the session JSONL as a Pi custom entry. The session file is the source of truth for its Root agent.

New sessions should record the resolved Root agent, including when the agent is the default fallback.

Existing sessions without a selected-root-agent entry fall back to launch/default Root-agent resolution.

Startup `pi-agents --resume` keeps Pi's normal resume picker. The launcher first starts a bootstrap Pi child with only the multi-agents extension loaded. If the user cancels the picker, no restart occurs. If the user selects a session, the bootstrap child requests a wrapper restart into that concrete session, and the final child restores the Root agent recorded in the selected session JSONL.

Interactive `/resume` also keeps Pi's normal picker. After a session is selected, the extension cancels the in-process switch before mutation and asks the wrapper to restart into the selected session with the correct filtered extension set.

### `/agent` Behavior

`/agent <name>` creates a fresh standalone session for the requested Root agent. It does not mutate the current session, does not relaunch the existing session as a different agent, and does not link the new session to the previous one as a parent session.

The launcher restarts Pi for the new session with that agent's filtered extension set.

## Non-Goals

- Do not modify pi-mono.
- Do not unload extensions from an already-running Pi process.
- Do not rely on active-tool filtering as the full isolation mechanism.
- Do not mutate global or project Pi settings during normal launcher operation.
- Do not isolate non-extension package resources such as skills, prompt templates, or themes.
- Do not provide backward compatibility for old Root-agent sidecar selection state.

## Breaking Changes

- The multi-agents extension is no longer intended to be loaded as a normal Pi extension outside the launcher.
- Root-agent selection is no longer read from the old `.task-subagents-<sessionId>.json` sidecar.
- `/agent <name>` starts a fresh standalone session instead of switching within the existing session.

## Acceptance Criteria

1. A Root agent whose `extensions:` does not match `pdf-preview` does not load PDF preview tools or hooks when launched through the wrapper.
2. A Root agent whose `extensions:` matches `pdf-preview` does load that extension when launched through the wrapper.
3. Explicit user `-e/--extension` arguments are loaded regardless of the Root agent allowlist.
4. Resuming a session restores the Root agent persisted in that session JSONL.
5. Startup `pi-agents --resume` and interactive `/resume` use Pi's native picker UX, then restart through the wrapper so the selected session runs with its recorded Root agent and filtered extension set.
6. `/agent <name>` starts a new standalone session with the requested Root agent and its filtered extension set.
7. Loading the multi-agents extension without the launcher fails loudly.
