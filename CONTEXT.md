# Persistent Task Subagents — Domain Vocabulary

## Domain

- **Root agent**: The top-level user-facing Pi persona. Tree depth 0 in the agent tree.
  Distinguished from the usual Pi "main agent" because the term "main" is ambiguous
  when every agent is a Pi session.
- **Sub-agent**: A non-ephemeral Pi session spawned by a Task call. Has its own
  transcript, tools, and config. Identified by a short hex ID. Persists across
  Pi restarts and is only cleaned up when the parent root session is replaced
  with `/new`.
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
