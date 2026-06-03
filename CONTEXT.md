# Persistent Task Subagents — Domain Vocabulary

## Domain

- **Root agent**: The top-level user-facing Pi session. Tree depth 0 in the agent tree.
  Distinguished from the usual Pi "main agent" because the term "main" is ambiguous
  when every agent is a Pi session.
- **Sub-agent**: A non-ephemeral Pi session spawned by a Task call. Has its own
  transcript, tools, and config. Identified by a short hex ID. Persists across
  Pi restarts and is only cleaned up when the parent root session is replaced
  with `/new`.
- **Agent definition**: A markdown-backed persona/configuration that can run either as
  the Root agent or as a Sub-agent. Root-vs-Sub-agent placement should not change
  prompt composition semantics; only runtime facts such as tree depth and parent ID differ.
- **Model reference**: The frontmatter value for an Agent definition's model selection; it must resolve to exactly one Pi model through the runtime model resolver, preferring a unique model ID and using `provider/model-id` only when the model ID is ambiguous.
- **Agent row**: The TUI representation of one Agent definition in the configuration screen; compact rows are three terminal lines tall and the selected row expands into a bounded ten-line configuration panel.
- **Option column**: A fixed-width editable column inside the selected Agent row, representing one configurable frontmatter field and its selectable items.
- **Default Root agent definition**: The Agent definition selected for the Root agent when the user has not explicitly selected one. This is configuration, not special runtime behaviour; the selected Agent definition remains fully symmetric with every other Agent definition.
- **Root agent selection**: Session-local choice of which Agent definition runs as the Root agent. `/agent <name>` changes the current session's selection; new sessions fall back to the configured Default Root agent definition.
- **Tree depth**: Current position in the agent tree. Root is 0, child is 1,
  grandchild is 2, etc.  Stored on `SubagentRecord.depth` and exposed at
  runtime as `RuntimeContext.treeDepth`.
- **Depth config** (`AgentConfig.depth`): Spawn allowance — how many more Task
  levels this agent's configuration permits downward.  For the Root agent this
  also acts as the global tree limit (`rootDepthLimit`).  For sub-agents it's
  the local budget (`localDepthLimit`).  `depth: 0` → this agent may never
  call Task; `depth: 1` → may create one level of children; etc.
- **Root depth limit**: The absolute maximum tree depth the Root agent allows.
  Tasks are denied when `treeDepth >= rootDepthLimit`.
- **Local depth limit**: Whether the *current* agent's config permits further
  spawning.  A sub-agent with `depth: 0` cannot call Task even if the Root
  limit would allow deeper trees.
- **can_spawn**: Optional allowlist of Agent definition names this agent may delegate to.
  Missing field = unrestricted by allowlist. A defined array (even empty) acts
  as an allowlist; an empty array means "spawn none".
- **DepthPolicy**: Centralised module (`subagent/depth-policy.ts`) that owns
  every spawn decision — tree-depth limit, local depth budget, and can_spawn.
  Replaces ad-hoc checks scattered across `TaskController` and `index.ts`.
- **Metadata sidecar**: JSON file (`.task-subagents-<sessionId>.json`) storing
  sub-agent records alongside the root session.
- **MetadataStore**: Concurrent-safe module owning metadata read/write/lock.
- **SubagentSessionManager**: Module owning session creation, tracking, and disposal.
- **Prompt inheritance policy**: Per-agent configuration that controls which parent/root prompt material is inherited by a sub-agent. This project intentionally does not need a `systemPromptMode` domain concept because agent prompts are always composed with universal prompt parts.
- **Prompt part selection**: Per-agent configuration that controls which discovered Prompt parts are included when rendering an Agent definition. Missing selection means include all Prompt parts; an empty selection means include none; a non-empty selection means include only those named Prompt parts. Avoid: general prompts, extra prompts.
- **Configuration seeding**: Copying bundled Agent definitions and Prompt parts into the user configuration directory when the whole target directory does not exist, so normal configuration edits happen against user-owned files. It does not copy individual missing bundled files into an existing directory, and seeded definitions replace bundled and project-level runtime fallback. Seeded Agent definitions contain explicit values for every configurable frontmatter field.
- **Context file injection**: Project context files (for example `AGENTS.md`) are only included in an Agent-definition prompt when an agent or prompt-part template explicitly uses `{{context_files}}`; they are not automatically appended by Pi's generic `# Project Context` section.
- **Skill selection**: Per-agent allowlist for skills included in an Agent-definition prompt. Missing `skills` means inherit all parent/root skills; an empty list means include no skills; a non-empty list means include only those named skills.
- **Blocking execution**: The original Task execution mode where the parent agent calls Task and waits for the sub-agent to finish before receiving output inline. Controlled by the `blocking` parameter (default `true`).
- **Async execution**: New Task execution mode where the parent agent spawns a sub-agent and receives an immediate acknowledgment with the agent ID. The parent continues working and retrieves results later via `wait_for_agent`. Controlled by `blocking: false`.
- **`blocking` parameter**: Boolean parameter on the Task tool (`true` by default). `true` preserves existing blocking behaviour; `false` enables async execution.
- **`wait_for_agent`**: A tool that retrieves output from one or more sub-agents by ID. By default, blocks the parent turn until any listed agent finishes or a timeout expires; with `wait_all: true`, blocks until all listed running agents finish or a timeout expires. Returns structured per-agent output. Works on both async agents and finished blocking agents. Accepts `timeout` (minutes, default 5), `wait_all` (boolean, default false), and `kill_on_timeout` (boolean, default false).
- **Outcome-agnostic output extraction**: The principle that when a sub-agent stops — whether by success, crash, timeout, or abort — the best available output is extracted from the session transcript. Avoids empty or error-only results when partial output exists.
- **`kill_on_timeout`**: Compatibility-named parameter on `wait_for_agent` that escalates timeout handling. When the timeout fires with `kill_on_timeout: true`, the sub-agent is first asked to produce a final answer within the same duration. If it still does not finish, in-flight work is cancelled/aborted, the session waits up to 5 seconds for session/tool completion, tools are disabled for a bounded final-summary request where supported, and the session is forcibly aborted as a fallback if the summary does not complete. The transcript persists for resume.
- **Finish request**: Asking a running sub-agent to produce its final answer within a deadline, giving it a chance to finish cleanly before abort escalation.
- **Forced abort fallback**: Forcibly aborting a sub-agent session after the finish request and final-summary attempt do not complete. The session transcript persists on disk and the agent can be resumed.
- **Unconsumed agent**: An async agent that has finished execution but whose output has not yet been retrieved via `wait_for_agent`. Tracked by the notification system and re-reminded every ~5 safe notification opportunities until consumed.
- **Root-agent run**: One continuous root-agent invocation, from a user prompt or automatic follow-up until `agent_end`. A run can contain multiple assistant/tool turns and multiple `turn_end` events. At `agent_end`, the root agent would otherwise become idle and control would return to the user.
- **Notification system**: Safe-run-boundary injection of consolidated `[System]` messages listing finished-but-unconsumed async agents. The extension intentionally does not build static async-completion text at intermediate `turn_end` events because the root agent may still call `wait_for_agent` later in the same run, making that text stale before Pi delivers it. Instead, after `agent_end`, it revalidates the unconsumed-agent set and sends the notification through `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`, which starts an automatic follow-up turn rather than waiting for user input. If unconsumed agents remain after ~5 safe notification opportunities with no new completions, the message is re-injected. When the user is mid-typing, the notification batches with the user's message.

## Flagged ambiguities

- "main agent" was used to mean Agent definitions generally, not the **Root agent** — resolved: use **Agent definition** for the configurable persona and **Root agent** only for the top-level user-facing Pi session.
- `canSpawn` conflicts with the preferred frontmatter naming style — resolved: use `can_spawn` only; no prototype backward compatibility for `canSpawn`.
- Comma-separated checkbox fields are less clear than YAML arrays — resolved: store checkbox selections as YAML lists, with `[]` meaning none.
- Project-level `.pi/agents/` and `.pi/prompt-parts/` conflict with the desired single editable configuration home — resolved: use user-level `~/.pi/agent/agents/` and `~/.pi/agent/prompt-parts/` only.
- "singular model name" was ambiguous between a stripped bare identifier, Pi's CLI table output, and runtime-resolvable model selection — resolved: use **Model reference** values derived from Pi library model objects and accepted by the runtime model resolver; preserve slashes that are part of model IDs.
