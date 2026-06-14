# Implementation Plan: Agent Configuration TUI (`pi-agent-config`)

## 1. File Structure

All new code lives under `src/tui/` alongside the existing `src/subagent/` directory.

```
src/
  tui/
    cli.ts                       # CLI entry point (bin script: pi-agent-config)
    app.tsx                      # Root Ink component — state hub & layout orchestration
    hooks/
      useConfig.ts               # Central state hook: reducer, actions, initial scan
      useKeyboard.ts             # Keyboard dispatch (arrow keys, Enter, Escape, q, r)
      useMouse.ts                # Mouse event handler (Ink mouse support)
      useOptionDiscovery.ts      # Scans ~/.pi/agent/ for all selectable options
    components/
      Board.tsx                  # Horizontally scrollable container of AgentColumn cards
      AgentColumn.tsx            # Single agent column: header + field rows + status
      FieldRow.tsx               # A single field row (label + value summary button)
      CheckboxOverlay.tsx        # Full-height overlay: multi-select with checkboxes
      DropdownOverlay.tsx        # Full-height overlay: single-select dropdown list
      StatusLine.tsx             # Per-column save-status line
      EmptyState.tsx             # Centered message: "No agent definitions found."
      ErrorColumn.tsx            # Fallback column for invalid-YAML agent files
      HelpFooter.tsx             # Bottom bar: keybindings hint + global status
    discovery/
      options.ts                 # Pure discovery functions (tools, extensions, models, etc.)
      agents.ts                  # Agent file scanning (reuses markdown-definitions patterns)
    file-io/
      read-agent.ts              # Read + parse a single agent .md → AgentConfigState
      write-agent.ts             # Selective field write-back into agent .md (text manipulation)
    state/
      types.ts                   # TypeScript types for ConfigState, actions, options
      reducer.ts                 # Immutable state reducer
  src/subagent/                      # Existing extension code — untouched
    agents.ts                    # ⚠️ PRD §10: mapToAgentConfig updated for can_spawn, prompt_parts
    markdown-definitions.ts      # ⚠️ PRD §10: remove bundled/project paths from discovery
    prompt-parts.ts              # ⚠️ PRD §10: already uses only ~/.pi/agent/ paths
    index.ts                     # Existing extension entry — untouched beyond above
  test/
    tui/
      options.test.ts            # Unit tests for discovery functions
      read-agent.test.ts         # Unit tests for YAML parsing + field extraction
      write-agent.test.ts        # Unit tests for selective write-back
      state-reducer.test.ts      # Unit tests for state transitions
      integration.test.ts        # Smoke test: scan a temp dir, modify, verify write-back
```

## 2. Entry Point and CLI Setup

**File:** `src/tui/cli.ts`

- Shebang: `#!/usr/bin/env node`
- Imports `render` from `ink` and the root `<App />` component
- Calls `render(<App />)` with `{ exitOnCtrlC: true, patchConsole: false }`
- No args, no flags. The command is just `pi-agent-config`
- `package.json` updated with:
  ```json
  "bin": {
    "pi-agent-config": "./src/tui/cli.ts"
  },
  "dependencies": {
    "ink": "^5.2.0",
    "react": "^19.0.0",
    "js-yaml": "^4.1.1"
  }
  ```

**Why no Pi runtime dependency:** The TUI runs standalone. It imports `getAgentDir` and `ModelRegistry` from `@mariozechner/pi-coding-agent` for path resolution and model discovery, but never creates an AgentSession.

## 3. Component Tree

```
<App>                               # app.tsx — state hub, useConfig() call
  <HelpFooter />                    # Bottom bar: "←→ nav | ↑↓ field | Enter edit | Esc close | r rescan | q quit"
  {state.error && <ErrorBanner />}  # Global error banner (discovery failure)
  {state.agents.length === 0
    ? <EmptyState />                # "No agent definitions found in ~/.pi/agent/agents/"
    : <>
        <Board>                     # Horizontally scrollable viewport
          {state.agents.map((agent, i) => (
            <AgentColumn            # One column per agent
              key={agent.filePath}
              agent={agent}
              options={state.options}
              isFocused={i === state.focus.agentIndex}
              focusedField={state.focus.fieldIndex}
              status={state.statuses.get(agent.filePath)}
            >
              {FIELDS.map((field, j) => (
                <FieldRow            # Single clickable/selectable field
                  key={field.name}
                  field={field}
                  isFocused={j === state.focus.fieldIndex && i === state.focus.agentIndex}
                />
              ))}
            </AgentColumn>
          ))}
        </Board>
        {state.overlay && (
          state.overlay.type === 'checkbox'
            ? <CheckboxOverlay overlay={state.overlay} />
            : <DropdownOverlay overlay={state.overlay} />
        )}
      </>
  }
</App>
```

### Component Responsibilities

| Component | Role |
|---|---|
| `App` | Owns `useConfig()` state hook. Passes state + dispatch down. Calls `useKeyboard()` and `useMouse()`. |
| `Board` | Renders agent columns in a horizontal Flexbox row. Clips to terminal width. Translates `scrollOffset` into visible columns. |
| `AgentColumn` | One vertical column per agent. Renders header (bold name, dim description), field rows, and a status line. Highlights when focused. |
| `FieldRow` | Shows field label + value summary (e.g., `tools: 8 selected` or `model: claude-sonnet-4-5`). Highlights when cursor is on it. |
| `CheckboxOverlay` | Rendered as absolutely-positioned panel. Lists all available options with `☑`/`☐` markers. Keyboard (↑↓ Space) and mouse toggles. Enter/Esc to commit/cancel. |
| `DropdownOverlay` | Similar panel for single-select. Shows current selection with `●` marker. Keyboard (↑↓ Enter) or mouse to select. Esc to cancel. |
| `StatusLine` | Dim text: `Saved explorer.md` (green) or `Save failed: EACCES` (red). Fades after 2s. |
| `EmptyState` | Centered `Text` with dimmed message. |
| `ErrorColumn` | When YAML is invalid, shows error text and disables field controls. |
| `HelpFooter` | Fixed bottom row: gray keybinding hints. |

## 4. Data Flow

### 4.1 Startup Scan

```
cli.ts → render(<App />)
  App.useConfig() calls useOptionDiscovery() + scanAgents()
    ├─ scanAgents()
    │   ├─ readdir ~/.pi/agent/agents/*.md
    │   ├─ for each file: readAgent() → AgentConfigState
    │   │   ├─ read file
    │   │   ├─ parseFrontmatter(content)  (from @mariozechner/pi-coding-agent)
    │   │   ├─ extract fields (tools, extensions, model, reasoning_effort, depth,
    │   │   │   can_spawn, skills, prompt_parts) from frontmatter map
    │   │   ├─ detect stale values (items in checkbox lists not in discovered options)
    │   │   └─ return { name, description, frontmatter, filePath, error, staleItems }
    │   └─ return AgentConfigState[]
    │
    └─ useOptionDiscovery()
        ├─ discoverTools()        → built-in tool names + extension-registered tools
        ├─ discoverExtensions()   → basenames of ~/.pi/agent/extensions/ entries
        ├─ discoverModels()       → ModelRegistry.getAll() from pi-coding-agent
        ├─ discoverCanSpawn()     → agent filename stems (excluding self)
        ├─ discoverSkills()       → parent dir names of ~/.pi/agent/skills/*/SKILL.md
        ├─ discoverPromptParts()  → filename stems of ~/.pi/agent/prompt-parts/*.md
        └─ return DiscoveredOptions
```

### 4.2 Edit → Save Flow

```
User presses Enter on a field row
  → dispatch({ type: 'OPEN_OVERLAY', agentIndex, fieldName })
  
Overlay opens:
  - Checkbox: reads current field value from agent state
    - undefined → all items checked (tri-state: missing = all active)
    - [] → all items unchecked
    - ['a','b'] → only a,b checked
    - Stale items shown as ☑ item (missing)
  - Dropdown: reads current value
    - undefined → shows default (e.g., depth=0, reasoning_effort=medium, first model)
    - explicit → shows that value

User toggles/selects in overlay
  → local overlay state updates (NOT the agent state yet)

User presses Enter (commit):
  → dispatch({ type: 'SAVE_FIELD', agentIndex, fieldName, value })
  → writeFieldToFile(agent.filePath, fieldName, value)
    ├─ read file
    ├─ find frontmatter block (between --- markers)
    ├─ locate field position in frontmatter text (regex)
    ├─ replace/add field with new YAML
    │   - If field became [] and wasn't previously missing → write `field: []`
    │   - If field became undefined (checkbox: user toggled back to "all selected") 
    │     and field was previously present → remove field from frontmatter
    │   - If field value changed → replace
    │   - If field newly added → append to end of frontmatter
    ├─ write file
    └─ return { success, error? }
  → dispatch({ type: 'SAVE_COMPLETE', agentIndex, status })
  
User presses Escape in overlay:
  → dispatch({ type: 'CLOSE_OVERLAY' }) — no changes saved
```

### 4.3 Rescan (`r` key)

```
dispatch({ type: 'RESCAN' })
  → re-runs scanAgents() + useOptionDiscovery()
  → preserves current focus position if possible
  → closes any open overlay
```

## 5. State Management

### 5.1 State Types (`src/tui/state/types.ts`)

```typescript
interface ConfigState {
  agents: AgentConfigState[];
  options: DiscoveredOptions;
  focus: FocusState;
  overlay: OverlayState | null;
  statuses: Map<string, StatusInfo>;  // keyed by filePath
  scrollOffset: number;
  globalError: string | null;
}

interface AgentConfigState {
  name: string;                        // filename stem
  description: string;                 // from frontmatter, display-only
  filePath: string;                    // absolute path
  frontmatter: Record<string, unknown>; // parsed YAML (or null if parse error)
  body: string;                        // markdown after frontmatter (never touched)
  error: string | null;                // YAML parse error message
  staleItems: Record<string, string[]>; // fieldName → stale value names
}

interface FocusState {
  agentIndex: number;
  fieldIndex: number;                  // index into FIELDS_ORDER
}

interface OverlayState {
  type: 'checkbox' | 'dropdown';
  agentIndex: number;
  fieldName: string;
  currentValue: string[] | string | undefined;  // from agent frontmatter
  availableItems: string[];
  staleItems: string[];
  // For checkbox: locally toggled set (starts as currentValue resolved)
  localSelection: string[];
  // For dropdown: locally selected item
  localSelected: string;
}

interface DiscoveredOptions {
  tools: string[];
  extensions: string[];
  models: ModelOption[];
  reasoningEfforts: string[];
  depths: number[];
  canSpawn: string[];
  skills: string[];
  promptParts: string[];
}

interface ModelOption {
  provider: string;
  modelId: string;
  displayName: string;
}

interface StatusInfo {
  type: 'saved' | 'error' | 'saving';
  message: string;
  timestamp: number;
}
```

### 5.2 Actions (reducer)

```typescript
type ConfigAction =
  | { type: 'INIT_COMPLETE'; agents: AgentConfigState[]; options: DiscoveredOptions }
  | { type: 'INIT_ERROR'; error: string }
  | { type: 'FOCUS_AGENT'; direction: 'next' | 'prev' }
  | { type: 'FOCUS_FIELD'; direction: 'next' | 'prev' }
  | { type: 'OPEN_OVERLAY'; agentIndex: number; fieldName: string }
  | { type: 'CLOSE_OVERLAY' }
  | { type: 'TOGGLE_CHECKBOX'; item: string }
  | { type: 'SELECT_DROPDOWN'; item: string }
  | { type: 'COMMIT_OVERLAY' }
  | { type: 'SAVE_COMPLETE'; agentIndex: number; status: StatusInfo }
  | { type: 'RESCAN' }
  | { type: 'RESCAN_COMPLETE'; agents: AgentConfigState[]; options: DiscoveredOptions }
  | { type: 'SCROLL'; direction: 'left' | 'right' };
```

### 5.3 `useConfig` Hook (`src/tui/hooks/useConfig.ts`)

- Uses `useReducer` with the reducer above
- On mount: runs async scan, dispatches `INIT_COMPLETE` or `INIT_ERROR`
- Exposes `{ state, dispatch }` plus memoized action creators:
  - `focusNextAgent()`, `focusPrevAgent()`
  - `focusNextField()`, `focusPrevField()`
  - `openOverlay(agentIndex, fieldName)`
  - `commitOverlay()` — calls write-agent, then dispatches `SAVE_COMPLETE`
  - `closeOverlay()`
  - `rescan()`

## 6. Key Algorithms

### 6.1 Option Discovery (`src/tui/discovery/options.ts`)

#### Tools Discovery
```typescript
function discoverTools(agentDir: string, agents: AgentConfigState[]): string[] {
  // 1. Built-in Pi tool names (hardcoded from pi-coding-agent SDK):
  //    read, bash, edit, write, grep, find, ls
  const builtins = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
  
  // 2. Scan ~/.pi/agent/extensions/ for registered tool names.
  //    Each extension directory may have tool registrations.
  //    For simplicity v1: list all extension names (they may register tools).
  //    Also check any tools mentioned in existing agent definitions.
  const fromAgents = new Set<string>();
  for (const agent of agents) {
    const tools = agent.frontmatter?.tools;
    if (Array.isArray(tools)) {
      for (const t of tools) fromAgents.add(String(t));
    }
  }
  
  // 3. Union all sources, deduplicate
  return [...new Set([...builtins, ...fromAgents])];
}
```

#### Extensions Discovery
```typescript
function discoverExtensions(agentDir: string): string[] {
  const extDir = path.join(agentDir, 'extensions');
  if (!fs.existsSync(extDir)) return [];
  return fs.readdirSync(extDir, { withFileTypes: true })
    .filter(e => e.isDirectory() || e.isFile())
    .map(e => e.isDirectory() ? e.name : path.basename(e.name, path.extname(e.name)));
}
```

#### Models Discovery
```typescript
function discoverModels(agentDir: string): ModelOption[] {
  // Use ModelRegistry from @mariozechner/pi-coding-agent
  // Construct AuthStorage pointing at ~/.pi/agent/auth.json
  const authStorage = AuthStorage.create(agentDir);
  const registry = new ModelRegistry(authStorage, path.join(agentDir, 'models.json'));
  registry.refresh();
  return registry.getAll().map(m => ({
    provider: m.provider,
    modelId: m.id,
    displayName: m.name ?? `${m.provider}/${m.id}`,
  }));
}
```

> **Note:** `AuthStorage` and `ModelRegistry` are exported from `@mariozechner/pi-coding-agent`. If `models.json` doesn't exist or is invalid, `getAll()` falls back to built-in models. The TUI should catch errors and show a warning in the status line.

#### Can Spawn Discovery
```typescript
function discoverCanSpawn(agentDir: string): string[] {
  const agentsDir = path.join(agentDir, 'agents');
  if (!fs.existsSync(agentsDir)) return [];
  return fs.readdirSync(agentsDir)
    .filter(f => f.endsWith('.md') && !f.startsWith('.'))
    .map(f => path.basename(f, '.md'));
}
```

#### Skills Discovery
```typescript
function discoverSkills(agentDir: string): string[] {
  const skillsDir = path.join(agentDir, 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  // Skills follow pattern: skills/<name>/SKILL.md
  const result: string[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
    if (fs.existsSync(skillFile)) result.push(entry.name);
  }
  return result;
}
```

#### Prompt Parts Discovery
```typescript
function discoverPromptParts(agentDir: string): string[] {
  const ppDir = path.join(agentDir, 'prompt-parts');
  if (!fs.existsSync(ppDir)) return [];
  return fs.readdirSync(ppDir)
    .filter(f => f.endsWith('.md') && !f.startsWith('.'))
    .map(f => path.basename(f, '.md'));
}
```

### 6.2 Agent File Reading (`src/tui/file-io/read-agent.ts`)

```typescript
function readAgent(filePath: string): AgentConfigState {
  const name = path.basename(filePath, '.md');
  
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { name, description: '', filePath, frontmatter: {}, body: '', 
             error: `Cannot read file: ${(err as Error).message}`, staleItems: {} };
  }
  
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parseFrontmatter<Record<string, unknown>>(content);
    frontmatter = parsed.frontmatter;
    body = parsed.body;
  } catch (err) {
    return { name, description: '', filePath, frontmatter: {}, body: content,
             error: `Invalid YAML: ${(err as Error).message}`, staleItems: {} };
  }
  
  const description = frontmatter.description 
    ? String(frontmatter.description) 
    : '';
  
  return {
    name,
    description,
    filePath,
    frontmatter,
    body,
    error: description ? null : 'Missing description field',
    staleItems: {},  // populated later against discovered options
  };
}
```

### 6.3 Immediate Save — Selective Field Write (`src/tui/file-io/write-agent.ts`)

This is the most complex I/O operation. Strategy: **text-level manipulation of the frontmatter block** to preserve formatting and only touch the changed field.

```typescript
function writeFieldToFile(
  filePath: string,
  fieldName: string,
  value: string[] | string | number | undefined,
): { success: boolean; error?: string } {
  // 1. Read current file content
  const content = fs.readFileSync(filePath, 'utf-8');
  
  // 2. Split into frontmatter + body
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    // No frontmatter block — create one
    const newFm = buildFrontmatterField(fieldName, value);
    const newContent = `---\n${newFm}\n---\n\n${content}`;
    fs.writeFileSync(filePath, newContent, 'utf-8');
    return { success: true };
  }
  
  const [, fmText, body] = fmMatch;
  
  // 3. Remove the field if it exists in fmText, then append/replace
  let newFmText: string;
  
  if (value === undefined) {
    // Remove the field entirely (checkbox: user reverted to "all selected")
    newFmText = removeFieldFromYamlText(fmText, fieldName);
  } else if (Array.isArray(value) && value.length === 0) {
    // Empty array: write field: []
    newFmText = setFieldInYamlText(fmText, fieldName, '[]');
  } else if (Array.isArray(value)) {
    // YAML list
    const lines = [fieldName + ':'];
    for (const item of value) {
      lines.push(`  - ${item}`);
    }
    newFmText = setFieldInYamlText(fmText, fieldName, lines.join('\n'));
  } else if (typeof value === 'number') {
    newFmText = setFieldInYamlText(fmText, fieldName, String(value));
  } else {
    // Scalar string
    newFmText = setFieldInYamlText(fmText, fieldName, value);
  }
  
  // 4. Write back
  const newContent = `---\n${newFmText}\n---\n${body}`;
  
  try {
    fs.writeFileSync(filePath, newContent, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
```

#### Helper: `setFieldInYamlText(fmText, fieldName, newValueLines)`

```
1. Find existing field in fmText via regex:
   - Scalar: /^fieldName:\s*.*$/m
   - List: /^fieldName:\s*$\n(?:  - .*\n?)*/m
2. If found → replace with newValueLines
3. If not found → append newValueLines to end of fmText (trim trailing whitespace first)
4. Return updated fmText
```

#### Helper: `removeFieldFromYamlText(fmText, fieldName)`

```
1. Find existing field (same regex)
2. If found → remove the line(s) + any trailing blank line left behind
3. Return updated fmText
```

### 6.4 Tri-State Checkbox Resolution

```typescript
function resolveCheckboxValue(
  frontmatterValue: unknown,    // undefined | [] | ['a','b']
  availableItems: string[],     // all discoverable items
): { checked: Set<string>; explicit: boolean } {
  if (frontmatterValue === undefined) {
    // Missing → all items active, all shown as checked
    return { checked: new Set(availableItems), explicit: false };
  }
  if (!Array.isArray(frontmatterValue)) {
    // Comma-separated string → parse (backward compat from parseCheckboxField)
    const items = String(frontmatterValue).split(',').map(s => s.trim()).filter(Boolean);
    if (items.length === 0) {
      return { checked: new Set(), explicit: true };  // [] → none
    }
    return { checked: new Set(items), explicit: true };
  }
  if (frontmatterValue.length === 0) {
    return { checked: new Set(), explicit: true };  // [] → none
  }
  return { checked: new Set(frontmatterValue.map(String)), explicit: true };
}
```

When the user opens a checkbox overlay:
- `explicit: false` → overlay shows "All items selected (field not written to file)" hint
- First toggle → field becomes explicit, all available items pre-checked, user's toggle unchecks the clicked item
- When all items are re-checked → field returns to `undefined` (removed from file)

## 7. Navigation and Keyboard

### 7.1 Keyboard Dispatch (`src/tui/hooks/useKeyboard.ts`)

Uses Ink's `useInput` hook:

| Key | Action |
|---|---|
| `←` / `h` | Focus previous agent column (wraps at end) |
| `→` / `l` | Focus next agent column (wraps at end) |
| `↑` / `k` | Focus previous field row (wraps) |
| `↓` / `j` | Focus next field row (wraps) |
| `Enter` | If overlay closed: open overlay for focused field. If overlay open: commit. |
| `Escape` | Close overlay without saving. If no overlay: no-op. |
| `Space` | In checkbox overlay: toggle focused item |
| `q` | Quit (calls `useApp().exit()`) |
| `r` | Rescan `~/.pi/agent/` |

### 7.2 Mouse Support (`src/tui/hooks/useMouse.ts`)

Ink supports mouse events via `useInput` (raw `\x1b[M...` sequences) or via the experimental `useMouse` hook if available in the installed Ink version. If not available natively, implement a raw escape-sequence parser.

Mouse actions:
- Click on agent column header → focus that agent
- Click on field row → focus that field, open overlay
- Click on checkbox item in overlay → toggle
- Click on dropdown item in overlay → select
- Click outside overlay → close overlay (Escape equivalent)

### 7.3 Horizontal Scrolling

The `Board` component renders columns in a horizontal row. Only as many columns as fit in the terminal width are visible. `scrollOffset` determines which columns to render:

```
visible columns = agents.slice(scrollOffset, scrollOffset + maxVisible)
```

Moving focus past screen edge auto-scrolls:
- `focus.agentIndex < scrollOffset` → `scrollOffset = focus.agentIndex`
- `focus.agentIndex >= scrollOffset + maxVisible` → `scrollOffset = focus.agentIndex - maxVisible + 1`

## 8. Layout Dimensions

Each `AgentColumn` is a fixed width of ~30 characters to fit multiple columns:

```
┌──────────────────────────────┐
│ **explorer**                 │  ← bold name
│ A curious exploration agent  │  ← dim description
│                              │
│ tools:       8 selected   ►  │  ← field rows (► indicates dropdown)
│ extensions:  2 selected   ►  │
│ model:       claude-sonnet ►│
│ reasoning:   high         ►  │
│ depth:       2            ►  │
│ can_spawn:   3 selected   ►  │
│ skills:      1 selected   ►  │
│ prompt_parts: all (default)► │
│                              │
│ Saved explorer.md            │  ← status line
└──────────────────────────────┘
```

The focused column gets a highlighted border (color/faint inversion).

## 9. Overlay Components

### CheckboxOverlay

```
┌─────────────────────────────────────┐
│ tools — explorer                    │
│                                     │
│ All items selected (not in file)    │  ← shown when explicit=false
│                                     │
│ ☑ read                              │
│ ☑ bash                              │
│ ☑ edit                              │
│ ☑ write                             │
│ ☐ grep                              │  ← user just unchecked
│ ☑ find                              │
│ ☑ ls                                │
│ ☑ web_search (missing)              │  ← stale item
│                                     │
│ Enter: save  Esc: cancel  Space: tog│
└─────────────────────────────────────┘
```

### DropdownOverlay

```
┌─────────────────────────────────────┐
│ model — explorer                    │
│                                     │
│ ● claude-sonnet-4-5                 │  ← current selection
│   claude-opus-4-5                   │
│   claude-haiku-4-5                  │
│   gpt-5                             │
│   gemini-2.5-pro                    │
│                                     │
│ Enter: select  Esc: cancel          │
└─────────────────────────────────────┘
```

Overlay positioning:
- Rendered below or above the field row (calculate based on terminal height)
- Uses `Box` with absolute positioning (Ink supports `position: 'absolute'` via Yoga)
- Dims the background board while open

## 10. PRD §10: Runtime Parser Changes

Changes to the existing extension code (NOT part of the TUI, but required by the PRD):

### 10.1 `src/subagent/agents.ts` — `mapToAgentConfig`

Current code already uses `can_spawn` and `prompt_parts` (lines 116-119 show `fm.can_spawn` and `fm.prompt_parts`). Verify:
- `canSpawn` (camelCase) is NOT read anywhere
- `prompt_parts` is parsed via `parseCheckboxField`
- `parseCheckboxField` handles both YAML arrays and comma-separated strings

Changes needed:
- Remove comma-separated string fallback from `parseCheckboxField` (PRD §10: "Checkbox fields parsed as YAML lists, not comma-separated strings")
- Verify `canSpawn` backward compat is removed

### 10.2 `src/subagent/markdown-definitions.ts` — `discoverMarkdownDefinitions`

Already uses only `getAgentDir()` + `options.userSubdir`. The `findNearestProjectDir` function exists but is marked `@deprecated` and not called by `discoverMarkdownDefinitions`. Confirm it's truly unused; remove if so.

### 10.3 `src/subagent/prompt-parts.ts` — `discoverPromptParts`

Already uses only `~/.pi/agent/prompt-parts/`. No changes needed.

## 11. Step-by-Step Implementation Order

| Step | Description | Complexity | Dependencies |
|---|---|---|---|
| **1** | **Types & State** — Create `src/tui/state/types.ts` with all interfaces and `src/tui/state/reducer.ts` with the pure reducer function. Tests for reducer. | Low | None |
| **2** | **Discovery Module** — Create `src/tui/discovery/options.ts` with all pure discovery functions (tools, extensions, models, can_spawn, skills, prompt_parts). Unit tests with temp directories. | Medium | Step 1 |
| **3** | **Agent Reading** — Create `src/tui/file-io/read-agent.ts` using `parseFrontmatter` from pi-coding-agent. Reuses patterns from `markdown-definitions.ts`. Tests. | Low | Step 1 |
| **4** | **Agent Writing** — Create `src/tui/file-io/write-agent.ts` with text-manipulation field write. **Highest-risk module.** Thorough tests with various YAML structures. | High | Step 3 |
| **5** | **useOptionDiscovery Hook** — Create `src/tui/hooks/useOptionDiscovery.ts`. Async hook that calls discovery functions and returns `DiscoveredOptions`. Handles errors gracefully. | Low | Step 2 |
| **6** | **useConfig Hook** — Create `src/tui/hooks/useConfig.ts`. Orchestrates initial scan (agent reading + option discovery), exposes state + dispatch. | Medium | Steps 2-5 |
| **7** | **Static Components** — `EmptyState.tsx`, `HelpFooter.tsx`, `StatusLine.tsx`, `ErrorColumn.tsx`. Pure presentational Ink components. | Low | Step 1 |
| **8** | **FieldRow Component** — `FieldRow.tsx`. Renders field label + value summary. Handles `isFocused` highlight. | Low | Step 1 |
| **9** | **AgentColumn Component** — `AgentColumn.tsx`. Renders header + field rows + status line for one agent. Handles focused/unfocused styling. | Low | Steps 7-8 |
| **10** | **Board Component** — `Board.tsx`. Horizontal scrollable container. Calculates visible columns. Handles scroll state. | Medium | Step 9 |
| **11** | **Overlay Components** — `CheckboxOverlay.tsx` and `DropdownOverlay.tsx`. Complex state management for local selection, stale item display, tri-state hints. | High | Steps 1, 8 |
| **12** | **useKeyboard Hook** — `src/tui/hooks/useKeyboard.ts`. Maps keypresses to dispatch calls. Handles both navigation and overlay interaction. | Medium | Steps 6, 11 |
| **13** | **useMouse Hook** — `src/tui/hooks/useMouse.ts`. Ink mouse event parsing + dispatch. | Medium | Steps 6, 11 |
| **14** | **App Component** — `app.tsx`. Glues everything together: useConfig + useKeyboard + useMouse + layout. | Medium | Steps 6, 10-13 |
| **15** | **CLI Entry Point** — `src/tui/cli.ts`. `#!/usr/bin/env node`, `render(<App />)`. | Trivial | Step 14 |
| **16** | **package.json Updates** — Add `bin`, `dependencies` (ink, react, js-yaml), `files` entry. | Trivial | Step 15 |
| **17** | **PRD §10 Parser Changes** — Update `parseCheckboxField` in `agents.ts`, verify/clean up `markdown-definitions.ts`, verify `prompt-parts.ts`. | Low | None (independent) |
| **18** | **Integration Tests** — End-to-end test: create temp dir with agent files, launch TUI (headless/simulated), verify keyboard navigation, modify field, verify file was written correctly. | High | Steps 1-16 |
| **19** | **Config Seeding (PRD §6)** — Add seeding logic that runs on install/first-run. Copies bundled agent and prompt-part `.md` files to `~/.pi/agent/` if the directories don't exist. | Medium | None (independent) |

## 12. Risk Areas & Mitigations

### 12.1 YAML Write-Back Precision
**Risk:** Text manipulation of YAML is fragile. Incorrect regex could corrupt files.
**Mitigation:**
- Use the `yaml` library to *parse* the frontmatter for validation after write
- Write tests with many YAML edge cases (nested structures, quoted strings, comments)
- On write failure, report error in status line; never write partial content
- Consider a backup strategy: write to `.bak` first, then rename

### 12.2 Model Discovery Without Pi Session
**Risk:** `ModelRegistry` may require `AuthStorage` which may need `auth.json`. If these don't exist, model discovery could fail entirely.
**Mitigation:**
- Catcher errors from `ModelRegistry` construction
- Fall back to built-in models (hardcoded list of common providers/models)
- Show a warning in the status line if models couldn't be fully discovered
- Optionally, fall back to parsing `~/.pi/agent/models.json` directly with `js-yaml`

### 12.3 Ink Version & Mouse Support
**Risk:** Mouse support in Ink is version-dependent. Ink 5 may not have `useMouse` hook.
**Mitigation:**
- Check Ink version features; if `useMouse` is unavailable, implement raw escape-sequence parsing
- Make mouse support a "nice-to-have" — keyboard navigation must be fully functional first
- Fall back gracefully: if mouse parsing fails, keyboard still works

### 12.4 Horizontal Scrolling Performance
**Risk:** Rendering all agent columns when there are many (50+) could be slow.
**Mitigation:**
- Only render visible columns (+1 buffer on each side)
- Use `React.memo` on `AgentColumn` with `isFocused` as key change detector
- Measure: if < 20 columns, render all; otherwise virtualize

## 13. Test Strategy

### Unit Tests (vitest, same as existing project)

| Test File | What It Tests |
|---|---|
| `test/tui/options.test.ts` | Each discovery function with temp directories. Test edge cases: empty dirs, missing dirs, permission errors. |
| `test/tui/read-agent.test.ts` | `readAgent()` with valid YAML, invalid YAML, missing description, empty file, various frontmatter formats. |
| `test/tui/write-agent.test.ts` | `writeFieldToFile()` for all field types: add new field, modify existing, remove field, write empty list, write YAML list. Verify untouched fields remain unchanged. Verify body is never touched. |
| `test/tui/state-reducer.test.ts` | All reducer actions: init, focus movement, overlay open/close, save complete, rescan. |
| `test/tui/integration.test.ts` | Full flow: create temp agent dir, programmatically simulate keyboard events, verify file output. Use Ink's `render` with test-mode stdout. |

### Manual Testing
- Run `pi-agent-config` in a terminal
- Test with real `~/.pi/agent/` directory
- Verify all field types work
- Test error scenarios: read-only fs, invalid YAML, missing dirs

## 14. Dependencies to Add

```json
{
  "dependencies": {
    "ink": "^5.2.0",
    "react": "^19.0.0",
    "js-yaml": "^4.1.1"
  },
  "bin": {
    "pi-agent-config": "./src/tui/cli.ts"
  }
}
```

Note: `@mariozechner/pi-coding-agent` is already a peer/transitive dependency (used for `getAgentDir`, `parseFrontmatter`, `ModelRegistry`, `AuthStorage`). The TUI does not add it as a direct dependency; it relies on the package being present in the Pi ecosystem.

## 15. Out of Scope (per PRD §12)

- Creating/deleting agent definitions
- Editing prompt part content
- Editing the markdown body
- Editing `description`
- Project-level `.pi/` fallback
- Multi-user or remote configuration
- Semantic validation of tool/model IDs
- File watcher (`chokidar`) — optional v2, `r` key sufficient for v1

## 16. Files to Create Summary

```
src/tui/cli.ts
src/tui/app.tsx
src/tui/hooks/useConfig.ts
src/tui/hooks/useKeyboard.ts
src/tui/hooks/useMouse.ts
src/tui/hooks/useOptionDiscovery.ts
src/tui/components/Board.tsx
src/tui/components/AgentColumn.tsx
src/tui/components/FieldRow.tsx
src/tui/components/CheckboxOverlay.tsx
src/tui/components/DropdownOverlay.tsx
src/tui/components/StatusLine.tsx
src/tui/components/EmptyState.tsx
src/tui/components/ErrorColumn.tsx
src/tui/components/HelpFooter.tsx
src/tui/discovery/options.ts
src/tui/discovery/agents.ts
src/tui/file-io/read-agent.ts
src/tui/file-io/write-agent.ts
src/tui/state/types.ts
src/tui/state/reducer.ts
test/tui/options.test.ts
test/tui/read-agent.test.ts
test/tui/write-agent.test.ts
test/tui/state-reducer.test.ts
test/tui/integration.test.ts
```

## 17. Files to Modify Summary

```
package.json                          # Add bin, dependencies
src/subagent/agents.ts                    # Remove comma-separated string fallback from parseCheckboxField
src/subagent/markdown-definitions.ts      # Verify/clean up deprecated findNearestProjectDir
```
