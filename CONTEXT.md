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
- **canSpawn**: Optional allowlist of agent names this agent may delegate to.
  `undefined` = unrestricted by allowlist.  A defined array (even empty) acts
  as an allowlist; an empty array means "spawn none".
- **DepthPolicy**: Centralised module (`subagent/depth-policy.ts`) that owns
  every spawn decision — tree-depth limit, local depth budget, and canSpawn.
  Replaces ad-hoc checks scattered across `TaskController` and `index.ts`.
- **Metadata sidecar**: JSON file (`.task-subagents-<sessionId>.json`) storing
  sub-agent records alongside the root session.
- **MetadataStore**: Concurrent-safe module owning metadata read/write/lock.
- **SubagentSessionManager**: Module owning session creation, tracking, and disposal.
- **Prompt inheritance policy**: Per-agent configuration that controls which parent/root prompt material is inherited by a sub-agent. This project intentionally does not need a `systemPromptMode` domain concept because agent prompts are always composed with universal prompt parts.
- **Context file injection**: Project context files (for example `AGENTS.md`) are only included in an Agent-definition prompt when an agent or prompt-part template explicitly uses `{{context_files}}`; they are not automatically appended by Pi's generic `# Project Context` section.
- **Skill selection**: Per-agent allowlist for skills included in a sub-agent prompt. Missing `skills` means inherit all parent/root skills; an empty list means include no skills; a non-empty list means include only those named skills.
