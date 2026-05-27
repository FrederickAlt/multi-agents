# PRD: Agent Configuration TUI

## 1. Feature Overview

A standalone terminal UI (`pi-agent-config`) that lets users configure every Agent definition's frontmatter. Users navigate a horizontally scrollable board of agent columns and adjust checkboxes and dropdowns. Every change writes immediately back to the agent's markdown file.

## 2. Executable

Standalone CLI command: `pi-agent-config`. Opens a full-screen Ink TUI. No Pi session dependency, no Pi runtime required beyond the package's own imports for option discovery.

## 3. Configuration Source

All runtime Agent definition and Prompt part discovery uses only `~/.pi/agent/`:

- `~/.pi/agent/agents/*.md` — Agent definitions
- `~/.pi/agent/prompt-parts/*.md` — Prompt parts

Bundled and project-level directories are removed from runtime discovery. They exist only for the seeding step (see §5).

## 4. Configurable Fields

| Field | Control | Frontmatter Format |
|---|---|---|
| `tools` | Checkbox multi-select | YAML list |
| `extensions` | Checkbox multi-select | YAML list |
| `model` | Dropdown | Scalar string |
| `reasoning_effort` | Dropdown | Scalar string |
| `depth` | Dropdown | Scalar integer or blank |
| `can_spawn` | Checkbox multi-select | YAML list |
| `skills` | Checkbox multi-select | YAML list |
| `prompt_parts` | Checkbox multi-select | YAML list |

`description` is display-only; not edited by the TUI. The markdown body below the frontmatter block is never touched by the TUI.

## 5. Field Semantics

### Checkbox fields (`tools`, `extensions`, `can_spawn`, `skills`, `prompt_parts`)

- **Missing from frontmatter** → all available items are active at runtime. The TUI displays all items as checked (`☑`). The field is not written to the file until the user explicitly modifies a checkbox.
- **Empty list** (`[]` in YAML) → no items are active. The TUI displays all items as unchecked (`☐`).
- **Explicit list** (e.g., `[read, bash]`) → only listed items are active. The TUI shows only those items checked. Deleting the last item writes `[]` (none), not a missing field.
- **Stale value** (configured item that no longer exists, e.g. a deleted agent referenced in `can_spawn`) → shown as `☑ item (missing)` marker. Preserved in the file until the user explicitly unchecks it.

### Dropdown fields (`model`, `reasoning_effort`, `depth`)

- **Missing from frontmatter** → the file has no opinion; runtime uses its own default. The TUI dropdown shows the runtime default value (e.g. the current default model, Pi's default thinking level, depth `0`). Selecting any value writes the field explicitly to the frontmatter, even if the selection matches what was shown as default.
- **Explicit value present** → the dropdown shows that value.
- **Depth values**: `0`, `1`, `2`, `3`, `4`, `5`. Missing depth defaults to `0` (cannot spawn).
- **Reasoning effort values**: low, medium, high, maximum — Pi's supported thinking levels.
- **Model values**: all models Pi can discover (configured in `models.json` plus provider-registered models).

### All fields

- Each individual change (checkbox toggle, dropdown selection) saves the file immediately.
- A status line shows `Saved <name>.md` on success or `Save failed: …` on error.
- Untouched fields are never written. Only the specific field the user changed is added or modified in the frontmatter.

## 6. Configuration Seeding

### When

Seeding runs on extension install and on first run before the extension activates. It seeds only when the target directory is absent:

- If `~/.pi/agent/agents/` does not exist, copy all bundled agent `.md` files into it.
- If `~/.pi/agent/prompt-parts/` does not exist, copy all bundled prompt-part `.md` files into it.

### How

Copies are file-level copies, not symlinks. If the directory already exists, no files are added or overwritten. There is no individual-file backfill — a partially deleted directory stays as-is.

### Seeded Content

Seeded Agent definition files contain explicit YAML frontmatter values for every configurable field. Missing fields should not occur in seeded files. Example of a seeded file:

```yaml
---
description: Default Root coding assistant
tools:
  - read
  - bash
  - grep
extensions: []
model: claude-haiku-4-5
reasoning_effort: high
depth: 1
can_spawn: []
skills: []
prompt_parts:
  - 010-tools
  - 020-runtime-context
---
```

Note: the values in the example are illustrative. Actual values must match what the bundled definition intends plus the complete set of tool/extension/skill/prompt-part names available at seeding time.

## 7. TUI Layout

### Board

One wide column per Agent definition, arranged horizontally. Left/right arrows scroll between agent columns. The column in focus is highlighted.

### Column Contents

Each column lists, top to bottom:

- **Agent name** (filename stem, bold)
- **description** (read-only, dimmed)
- Spacer
- `tools` — a dropdown button showing count of selected tools (e.g. `tools: 8 selected`)
- `extensions` — dropdown button
- `model` — dropdown button showing current model name
- `reasoning_effort` — dropdown button
- `depth` — dropdown button
- `can_spawn` — dropdown button
- `skills` — dropdown button
- `prompt_parts` — dropdown button
- Status line (last saved status)

### Navigation

- Left/right arrows → move between agent columns
- Up/down arrows → move between field rows within a column
- Enter → open the dropdown/checkbox overlay for the focused field
- Escape → close the overlay without further changes
- Within an overlay, up/down arrows or mouse clicks toggle individual checkboxes or select dropdown items
- `q` → quit
- `r` → rescan `~/.pi/agent/` and refresh all option lists

### Mouse

Mouse clicks on column headers (to select an agent), on dropdown buttons (to open), and on individual checkboxes or dropdown items are supported.

## 8. Option Discovery

All selectable options are discovered by scanning `~/.pi/agent/` on startup and on manual refresh (`r`):

| Field | Discovery Source |
|---|---|
| `tools` | Built-in Pi coding tool names + tool names registered by installed extensions + any tool name found in any existing Agent definition's `tools` list |
| `extensions` | Files/directories under `~/.pi/agent/extensions/` (basenames) |
| `model` | All models Pi can discover: `~/.pi/agent/models.json` plus provider-registered models |
| `reasoning_effort` | Fixed list of Pi thinking levels (e.g. low, medium, high, maximum) |
| `depth` | Fixed list: 0 through 5 |
| `can_spawn` | All Agent definition filename stems found in `~/.pi/agent/agents/*.md`, including the agent itself |
| `skills` | All `SKILL.md` files under `~/.pi/agent/skills/` (skill name is the parent directory name) |
| `prompt_parts` | All `.md` files under `~/.pi/agent/prompt-parts/` (name is the filename stem) |

Discovery is read-only. It reads directory listings and file content but never executes tool actions or extension loading code that would have side effects.

## 9. Error Handling

| Scenario | Behavior |
|---|---|
| Agent file has invalid YAML frontmatter | Column shows error text. Field controls are disabled. Save is impossible until the file is fixed manually. |
| Agent file is missing `description` | Column shows a warning badge. Other fields remain editable. |
| Field references a stale value (e.g. `can_spawn` lists a deleted agent) | Checkbox shows `☑ stale-agent (missing)`. Preserved in file until unchecked. |
| Prompt part or skill is deleted while referenced | Same `(missing)` treatment as above. |
| File system is read-only | Save fails with error in status line. Staged changes remain visible. |
| `~/.pi/agent/agents/` is empty | Board shows centered message: "No agent definitions found." |
| Discovery scan fails (e.g. permission error) | Show error in status line. Use last known option lists if available. |

## 10. Runtime Parser Changes

The existing `mapToAgentConfig` parser in `subagent/agents.ts` must be updated to exclusively use underscore-prefixed frontmatter field names:

- `canSpawn` → `can_spawn` only; no backward-compatible read of the old name
- New field: `prompt_parts` (YAML list)
- Checkbox fields parsed as YAML lists, not comma-separated strings

The `subagent/markdown-definitions.ts` loader and the `subagent/prompt-parts.ts` discovery module must also remove bundled and project-level paths from their discovery, using only `~/.pi/agent/` paths.

## 11. Dependencies

- **Ink** (React-based terminal UI framework) — same as `pi-agent-dashboard`
- **React** — required by Ink
- **chokidar** — optional file watcher for auto-refresh (optional in v1; `r` key sufficient)
- **js-yaml** — for reading/writing YAML frontmatter in agent `.md` files

The package reuses architectural patterns from `pi-agent-dashboard/src/tui/`:
- `useDashboard` hook pattern → adapted as `useConfig` hook
- `keyboard.ts` → adapted key dispatch
- `state.ts` → adapted configuration state model

## 12. Out of Scope (v1)

- Creating or deleting Agent definitions (file management is manual)
- Editing Prompt part content (file management is manual)
- Editing the Agent definition markdown body
- Editing `description`
- Project-level `.pi/` fallback directories (removed from runtime too)
- Multi-user or remote configuration
- Validation beyond YAML parseability (no semantic validation of tool names, model IDs, etc.)
- Tests (testing strategy is an implementation detail, not a PRD concern)
