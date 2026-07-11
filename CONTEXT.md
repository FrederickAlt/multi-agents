# Multi-agents domain and runtime context

This document explains the concepts that connect the modules listed in
`AGENTS.md`. Use it when reasoning about lifecycle, persistence, spawn policy,
or Root/Task symmetry.

## Runtime model

```text
User
  <-> Root agent (native Pi session, tree depth 0)
        -> Task
           <-> sub-agent (independent persistent Pi session, depth 1)
                 -> Task, if policy permits
                    <-> nested sub-agent (depth 2, ...)
```

An **Agent definition** is configuration, not a session. The same definition
may run as the Root agent or as any sub-agent. Each runtime agent is a real Pi
`AgentSession` with its own transcript, tools, model, extensions, and prompt.

Root and Task agents share prompt-composition semantics. Their runtime
placement differs: the Root talks to the user and owns the tree; a sub-agent
has a parent, a depth, a persistent Task ID, and a reporting notice.

## End-to-end lifecycle

### Root startup

The `pi-agents` launcher selects a session and Root Agent definition before Pi
loads extensions. It converts the definition's tools, model, and reasoning
effort into native Pi arguments, resolves allowed extensions under project
trust, disables uncontrolled extension discovery, and starts Pi with the
multi-agents extension explicitly loaded.

The extension then attaches Root prompt composition, commands, session events,
the `Task` tool, and `wait_for_agent`. Root selection is stored in the Pi
session transcript. `/agent <name>` changes it through a controlled launcher
restart so CLI-level tools/model/extensions and prompt-level persona stay in
sync.

### New Task

For a new Task, the controller:

1. Resolves the requested Agent definition and fast/smart mode.
2. Checks the parent's depth and `can_spawn` policy.
3. Resolves and validates the effective child CWD.
4. Allocates a collision-safe `SubagentRecord` in the Root metadata sidecar.
5. Creates a trust-aware resource loader filtered by the child definition.
6. Creates and binds a child Pi session with the chosen prompt, tools, model,
   reasoning effort, and extensions.
7. Runs the prompt and records the best available terminal output/state.

### Resume Task

`Task` with `resume: <id>` locates the existing record and reopens its JSONL Pi
session. The transcript supplies conversational memory. Resume is still checked
against the current parent's spawn policy and the record's Agent type; it is not
a bypass around current authorization.

### Completion and disposal

Terminal handling updates metadata, extracts useful output even from partial or
failed transcripts, emits async completion state where applicable, sends child
extension shutdown, and disposes the in-memory session. Normal disposal does
not delete the child transcript. Replacing the Root session (for example with
`/new`) cleans up the Root sidecar and its referenced child session files.

## State and ownership

| State | Owner | Persistence |
| --- | --- | --- |
| Root Agent selection | Pi session entries + `root-agent.ts` | Root JSONL transcript |
| Child identity/tree/terminal state | `MetadataStore` in `metadata.ts` | `.task-subagents-<rootId>.json` |
| Child conversation | Pi `SessionManager` | Child JSONL transcript |
| Open child sessions | `SubagentSessionManager` | Memory only |
| Async running/results/disposal | `SubagentSessionManager` | Memory, with terminal metadata in sidecar |
| Unconsumed completion reminders | `AsyncAgentNotifier` | Memory only |
| Agent/prompt configuration | User Markdown files | `~/.pi/agent/` |
| Project trust decisions | Pi trust store/settings | Pi-managed configuration |

The metadata sidecar stores child ID, human/display name, Agent type, effective
CWD, transcript path, parent ID, tree depth, timestamps, context usage, and
terminal outcome. `MetadataStore` serializes allocation per sidecar path to
avoid collisions from concurrent Task calls.

## Core vocabulary

- **Root agent**: the top-level user-facing Pi session at tree depth 0.
- **Sub-agent**: a persistent Pi session created or resumed through `Task`.
- **Agent definition**: a Markdown persona/config usable in either runtime
  placement. Its filename stem is its case-sensitive name.
- **Root Agent definition**: the definition currently applied to the Root
  session. A session-local selection wins over the configured default.
- **Task ID**: the 8-character hexadecimal ID used to resume or wait for a
  sub-agent. It identifies a metadata record, not an in-memory object.
- **Fast mode**: the default Agent mode using `model` and `reasoning_effort`.
- **Smart mode**: Task-selectable mode using `smart_model` and
  `smart_reasoning_effort`, with each missing value inherited from fast mode.
- **Tree depth**: runtime position: Root 0, child 1, grandchild 2, and so on.
- **Root depth limit**: absolute maximum depth inherited from the selected Root
  definition.
- **Local depth limit**: the current definition's own downward spawn allowance.
- **Depth policy**: the combined tree-depth, local-depth, and `can_spawn` state.
  `depth-policy.ts` is the only module that decides whether Task is allowed.
- **Metadata sidecar**: the Root-session-scoped JSON file containing all
  `SubagentRecord` entries.
- **Open session**: a child `AgentSession` currently held in memory by
  `SubagentSessionManager`.
- **Terminal outcome**: recorded result such as completed, crashed, timed out,
  aborted, or abort-request-failed.
- **Configuration seeding**: copying a bundled definition into user config only
  when that exact target file is missing. Existing files are never overwritten.

Prefer **Root agent**, **sub-agent**, and **Agent definition**. Avoid “main
agent,” which ambiguously refers to either the Root runtime or a definition.

## Spawn policy

`depth` is a non-negative number of additional Task levels allowed by a
definition:

- `depth: 0`: this agent cannot create or resume children.
- `depth: 1`: it may create direct children, but those children must also have
  their own positive local budget to spawn further.

For the selected Root definition, `depth` becomes both the Root's local budget
and the absolute tree limit. A child inherits that absolute Root limit and gets
its own local budget from its definition.

`can_spawn` is an additional tri-state name filter:

- Missing: unrestricted by name; depth still applies.
- `[]`: no Agent type allowed.
- Non-empty list: only the listed Agent names are allowed.

The same policy controls whether `Task` is exposed to the model and whether an
actual new/resume request is accepted.

## Definition and prompt semantics

Runtime discovery reads only:

- `~/.pi/agent/agents/*.md`
- `~/.pi/agent/prompt-parts/*.md`

Bundled definitions under `src/subagent/` are seed/package assets. Project-local
`.pi/agents/` and `.pi/prompt-parts/` are not runtime definition sources.

### Agent definition frontmatter

An Agent definition is a Markdown file with YAML frontmatter. Its filename stem
is the case-sensitive Agent name. Supported configuration fields are:

| Field | Meaning |
| --- | --- |
| `description` | Required short description used in Agent lists |
| `tools` | Tool whitelist; missing/blank uses Pi defaults, `[]` means none |
| `extensions` | Extension selection; missing/blank unrestricted, `[]` means none |
| `model`, `reasoning_effort` | Fast/default mode runtime |
| `smart_model`, `smart_reasoning_effort` | Smart overrides; missing values inherit fast mode |
| `depth` | Non-negative number of Task levels this definition may spawn |
| `can_spawn` | Missing unrestricted; `[]` none; otherwise Agent-name allowlist |
| `skills` | Missing all prompt skills; `[]` none; otherwise name filter |
| `prompt_parts` | Missing all fragments; `[]` none; otherwise name filter |

Reasoning effort uses Pi's current levels: `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, and `max`. The legacy value `maximum` is normalized to `max`
when read.

Configuration seeding copies bundled files into the user directories only when
the corresponding target file is missing. The TUI writes supported
frontmatter fields while preserving the Markdown body.

### Prompt templates

Agent bodies and prompt-part bodies may use exactly these template variables:

- `{{tools}}`
- `{{guidelines}}`
- `{{context_files}}`
- `{{skills}}`
- `{{cwd}}`
- `{{date}}`
- `{{agent_name}}`
- `{{agent_description}}`

Unknown variables fail at render time. Each selected prompt part is rendered
independently and appended to the Agent body. Context files are not implicitly
added; a template must place `{{context_files}}`.

`skills` and `prompt_parts` use tri-state selection:

- Missing: include all inherited/discovered content.
- `[]`: include none.
- Non-empty list: include only matching names.

Skill selection changes prompt content only; it does not disable commands,
tools, or extensions.

## Extension and trust model

The wrapper owns extension selection so an Agent definition cannot accidentally
load everything Pi can discover. Candidate resources are resolved before they
are imported or executed, disabled resources remain disabled, and the
multi-agents extension itself remains protected because it enforces the policy.

`extensions` is tri-state at runtime:

- Missing/blank: all enabled, trusted candidates.
- `[]`: none except the protected multi-agents/inline runtime.
- Non-empty list: candidates matching the configured aliases/selectors.

Root resolution happens in the launcher. Child resolution happens in the Task
resource-loader path. Both use Pi-compatible project trust decisions and fail
closed when a project contains trust-requiring resources without approval.

## Blocking and async execution

- **Blocking Task** (`blocking` omitted or `true`): the parent waits and receives
  output in the Task result.
- **Async Task** (`blocking: false`): the parent immediately receives the ID;
  the original prompt continues in the tracked child session.
- **`wait_for_agent`**: retrieves terminal output or waits for one/all listed
  IDs. `wait_all: false` returns when any finishes; `wait_all: true` waits for
  all or timeout.
- **Unconsumed agent**: a completed async result not yet retrieved by
  `wait_for_agent`. The notifier reminds the Root agent at safe boundaries.
- **`kill_on_timeout`**: escalation policy, not immediate deletion. It first
  asks the child to finish, then cancels in-flight work, attempts a bounded
  no-tools final summary, and uses forced abort only as fallback. The transcript
  remains resumable.
- **Outcome-agnostic extraction**: return the best usable assistant output from
  the transcript regardless of success, crash, timeout, or abort.

Cancellation signals must propagate through Task, wait, finish request, final
summary, and disposal. Queue acceptance from `steer()` is not Task completion;
the original prompt remains the owner of terminal finalization.

## Configuration TUI model

- **Agent row**: one user Agent definition in `pi-agent-config`.
- **Option column**: one editable frontmatter field within the expanded row.
- **Stale item**: a saved tool/extension/model/etc. no longer found by runtime
  discovery. Stale values are shown for deliberate cleanup, not silently
  removed or resurrected.

The TUI preserves Markdown bodies and writes only selected YAML frontmatter
fields. Runtime discovery may finish asynchronously; late discoveries update
available options and stale markers without overwriting local edits.
