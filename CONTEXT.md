# Persistent Task Subagents — Domain Vocabulary

## Domain

- **Root agent**: The top-level user-facing Pi persona. Depth 0 in the agent tree.
  Distinguished from the usual Pi "main agent" because the term "main" is ambiguous
  when every agent is a Pi session.
- **Sub-agent**: A non-ephemeral Pi session spawned by a Task call. Has its own
  transcript, tools, and config. Identified by a short hex ID. Persists across
  Pi restarts and is only cleaned up when the parent root session is replaced
  with `/new`.
- **Depth**: How many levels of spawning are allowed from the root agent.
  `depth: 0` → no sub-agents may be created; `depth: 1` → sub-agents may be
  created but cannot create further sub-agents; `depth: 2` → grandchildren allowed.
- **Metadata sidecar**: JSON file (`.task-subagents-<sessionId>.json`) storing
  sub-agent records alongside the root session.
- **MetadataStore**: Concurrent-safe module owning metadata read/write/lock.
- **SubagentSessionManager**: Module owning session creation, tracking, and disposal.
