# PRD: Async Task Execution

## Problem Statement

Currently every `Task` call is blocking — the parent agent calls `Task`, waits for the sub-agent to finish, and receives the output inline. The parent cannot do other work while a sub-agent runs. The model must also guess when a sub-agent has finished, or use the blocking call which ties up the turn.

Users want to spawn sub-agents asynchronously, continue doing other work, and retrieve results when ready. This enables parallel sub-agent execution and more efficient use of model turns.

## Solution

Add a `blocking` parameter to the `Task` tool (default `true`, preserving backward compatibility). When `blocking: false`, the tool spawns the sub-agent and returns immediately with the agent ID. A new `wait_for_agent` tool lets the parent retrieve results from one or more async agents. The system notifies the parent at safe root-agent run boundaries when an async agent finishes, with a recurring reminder every 5 notification opportunities if unconsumed agents remain.

## User Stories

1. As a root agent, I want to spawn a sub-agent asynchronously with `blocking: false`, so that I can continue working on other tasks while the sub-agent runs independently.
2. As a root agent, I want the `blocking` parameter to default to `true`, so that existing Task calls and agent behaviors are unchanged unless I explicitly opt into async.
3. As a root agent, I want to receive a system notification when an async sub-agent finishes, so that I know when results are ready without polling.
4. As a root agent, I want the notification to arrive when my current run would otherwise stop, so that I am never interrupted mid-action and the notification reflects the latest consumed/unconsumed state.
5. As a root agent, I want notifications for multiple finishing agents to be consolidated into a single message, so that I am not spammed with one notification per agent.
6. As a root agent, I want to be reminded every ~5 safe notification opportunities about unconsumed agents, so that I do not forget to retrieve results.
7. As a root agent, I want the reminder counter to reset whenever a new agent finishes, so that I see fresh completions immediately.
8. As a root agent, I want a still-pending async notification batched into the next submitted user input, so that the user's turn is not interrupted by an extra system message when the input arrives before the separate notification is emitted.
9. As a root agent, I want the `wait_for_agent` tool to accept a list of sub-agent IDs, so that I can wait on multiple agents at once.
10. As a root agent, I want `wait_for_agent` to return as soon as any listed agent has finished, so that I can consume results incrementally and decide whether to keep waiting for the rest.
11. As a root agent, I want `wait_for_agent` to return structured per-agent output, so that I can distinguish which agent produced which result.
12. As a root agent, I want `wait_for_agent` to report the status of agents that are still running, so that I know which agents remain outstanding.
13. As a root agent, I want `wait_for_agent` to accept a `timeout` parameter (default 5 minutes), so that I can bound how long I wait before getting a status update.
14. As a root agent, I want `wait_for_agent` to support a `kill_on_timeout` option, so that I can escalate from waiting to demanding that the sub-agent wrap up.
15. As a root agent, I want `kill_on_timeout` to send the sub-agent a soft-kill warning ("finish in under X minutes"), so that the sub-agent has a chance to produce a final answer before being aborted.
16. As a root agent, I want the sub-agent to be hard-aborted if it does not finish within the kill timeout, so that the parent is not blocked indefinitely.
17. As a root agent, I want a hard-aborted sub-agent's transcript to persist for resume, so that I can continue the work later.
18. As a root agent, I want `wait_for_agent` to always be available as a tool, so that the system prompt does not change mid-conversation and invalidate the cache.
19. As a root agent, I want `wait_for_agent` to work even on agents that were spawned in blocking mode (returning their output again from the persisted session file), so that the tool behaves uniformly regardless of how the agent was spawned.
20. As a root agent, I want the output from a stopped sub-agent to be extracted outcome-agnostically — whether the agent succeeded, crashed, timed out, or was aborted — so that I always get the best available content from the session transcript.
21. As a root agent, I want to resume any sub-agent (async or blocking) via the existing `resume` parameter on `Task`, so that follow-up work uses the same transcript regardless of original execution mode.
22. As a root agent, I want to mix blocking and non-blocking `Task` calls in the same turn via parallel tool calls, so that I can optimize for both urgent and deferrable work.
23. As a root agent, I want to be notified that an agent "crashed" (not "failed") when an unexpected error occurs, so that the language distinguishes between agent errors and task failures.
24. As a developer, I want the output extraction logic to be shared between the blocking and async paths, so that behavior is consistent and there is no duplication.
25. As a developer, I want the async notification state machine to be tested in isolation, so that the turn-counting and message-consolidation logic is verifiable without a running Pi session.

## Implementation Decisions

### 1. `blocking` parameter on Task tool

The `Task` tool parameters gain a `blocking` boolean, defaulting to `true`. When `blocking: true`, behavior is identical to today — the call waits for the sub-agent and returns its output inline. When `blocking: false`, the call spawns the sub-agent and returns immediately with the agent's ID and display name as acknowledgment.

### 2. `wait_for_agent` tool

A new tool registered alongside `Task` with parameters:

- `agent_ids`: list of hex IDs to wait on (required)
- `timeout`: minutes to wait before returning a status update (optional, default 5)
- `kill_on_timeout`: whether to escalate to kill on timeout (optional, default false)

The tool is always registered. Its description explains that it works for async agents and can also retrieve output from finished blocking agents.

When called, the tool checks each listed agent. For finished agents, it extracts and returns the output. For still-running agents, it waits on session completion. It returns as soon as any listed agent finishes, with structured per-agent output showing which completed, which are still running, and the status of any unknown IDs.

On timeout, still-running agents are reported as "timed out, still running." If `kill_on_timeout: true`, the sub-agent receives a soft-kill message instructing it to finish within the same timeout duration. If it still does not finish within the kill window, the session is hard-aborted. The transcript persists for resume.

### 3. Notification system

A new module `AsyncAgentNotifier` owns the notification lifecycle:

- When an async agent's final result has been stored, the notifier records the agent as completed-but-unconsumed.
- Notifications are delivered at safe root-agent run boundaries, not at intermediate assistant `turn_end` events.
  - A **root-agent run** starts with a user prompt or automatic follow-up and ends at `agent_end`, when the root agent would otherwise become idle and return control to the user.
  - A run may contain multiple assistant/tool turns and therefore multiple `turn_end` events.
  - The extension intentionally does not build static notification text at `turn_end`, because the root agent can still call `wait_for_agent` later in the same run. If the text were queued then, it could become stale before Pi delivers it.
- After `agent_end`, the extension revalidates the current unconsumed-agent set. If any completed agents remain unconsumed, it injects a consolidated `[System]` message listing their IDs and instructing the parent to call `wait_for_agent`.
- The Pi enqueue mechanism for these automatic notifications is `pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" })`. Because this is sent after `agent_end`, it starts an automatic follow-up turn and does not wait for the next user input. If called while a run is still active, Pi would queue a frozen follow-up message, which is the stale-notification class this design avoids.
- If any agents remain unconsumed after 5 safe notification opportunities with no new completions, the message is re-injected.
- If a new agent finishes during this window, the message is injected at the next safe run boundary and the counter resets.
- If user input is submitted while a completion notification is still pending, the notification is prepended to that submitted input rather than injected as a separate follow-up turn.

### 4. Outcome-agnostic output extraction

Both blocking and async paths share a single output extraction function. When an agent stops (success, crash, timeout, abort), the extractor:

1. Reads the session transcript for the last assistant text message (same as `getFinalTextFromMessages` today).
2. If the transcript has no assistant message but has an error or abort record, uses that.
3. Falls back to a generic error message only if the transcript is empty or unavailable.

The blocking error handler is updated to use this shared extractor rather than only reading the thrown error message, so partial output before a crash is preserved.

### 5. Session lifecycle for async agents

Async sessions follow the same lifecycle as blocking sessions. After `wait_for_agent` consumes the output, the in-memory session is disposed. The session file persists on disk. If `wait_for_agent` is called again on the same ID, the output is re-read from the persisted session file — no in-memory state or caching is needed.

### 6. `SubagentSessionManager` changes

The session manager exposes the ability to wait for async result storage, so `wait_for_agent` does not report terminal completion before final output extraction has finished. The async result-ready callback invokes `AsyncAgentNotifier` only after output is available.

### 7. `TaskController` changes

The controller gains:
- Branching on `blocking` parameter in `execute()`: `blocking: true` follows the existing path; `blocking: false` spawns and returns immediately.
- A `waitForAgents()` method that accepts a list of agent IDs, blocks until completion or timeout, and returns structured per-agent output using the shared output extractor.
- The shared outcome-agnostic output extraction function.

### 8. `configureTaskToolForRuntime` (index.ts) changes

Registers the `wait_for_agent` tool and adds the `blocking` parameter to the `Task` tool schema. Tool prompt guidelines are updated to document async usage patterns.

## Testing Decisions

Tests should verify external behavior — what the parent agent observes — not internal implementation details. For notification delivery, prefer behavior-level tests that model the extension's public runtime interface and assert observable outcomes (for example, whether a stale notification reaches the parent), not tests that only assert the exact `sendMessage` option object used internally.

### Modules to test

- **`TaskController`** (existing test file): Add tests for `blocking: false` (returns immediately with agent ID), `blocking: true` (unchanged), `waitForAgents()` (returns per-agent output, handles timeout, handles unknown IDs, handles kill_on_timeout escalation), shared outcome-agnostic extraction (returns partial output on crash, returns error when transcript empty).
- **`SubagentSessionManager`** (existing test file): Add tests for async result-ready notification callback registration and waiting for result storage without blocking the parent session.
- **`AsyncAgentNotifier`** (new test file): Test the notification state machine in isolation — consolidated message content, reminder counter, counter reset on new completion, empty state produces no notification, multiple agents in one message. These tests operate on pure state transitions with no Pi runtime dependency.
- **Async notification runtime integration**: Add a behavior-level regression test for stale notification delivery. Through the extension-facing `sendMessage`/`input`/`turn_end`/`agent_end` interface, simulate an async completion becoming due during a root-agent run, retrieve the result with `wait_for_agent` before the run ends, then end the run and submit the next user input. The parent should not observe the previously consumed agent ID in a later notification. This test should fail if notifications are queued as frozen deferred text from `turn_end` and pass when notification content is built only after run-boundary revalidation.

### Test patterns

Follow existing test patterns in the project: Vitest with mock adapters (`vi.fn()`), fake `SubagentRecord` and `AgentConfig` factories, and the existing adapter interface pattern (`AgentDiscoveryAdapter`, `MetadataAdapter`, `SessionAdapter`) that enables testing without live Pi sessions.

## Out of Scope

- Persistent notification state across Pi restarts (notifications are in-memory only; after restart the parent uses `Task(resume: ...)` to re-engage agents).
- Automatic agent timeout or abort during async execution (the parent must explicitly use `wait_for_agent` with `kill_on_timeout`).
- Mid-turn progress streaming from async agents.
- Changing the system prompt mid-conversation to add or remove the `wait_for_agent` tool.
- Any change to how `resume` works or how session files are structured on disk.
