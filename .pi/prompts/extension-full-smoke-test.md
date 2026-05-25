# Multi-agents extension full-surface smoke test

You are validating the `persistent-task-subagents` Pi extension end to end.

## Goals

- Cover the full extension surface, not a single happy path.
- Prefer deterministic Vitest suites first; use a live Pi session only for the final smoke pass.
- Report pass/fail per area.

## Required checks

1. `Task`
   - Confirm blocking behavior (`blocking: true`).
   - Confirm async behavior (`blocking: false`) returns immediately with a hex ID.
   - Confirm `resume` works for both blocking and async agents.
   - Confirm `depth` and `can_spawn` restrictions are enforced.
2. `wait_for_agent`
   - Wait on one ID and multiple IDs.
   - Confirm `completed`, `running`, `timed_out_still_running`, `killed`, and `unknown` statuses.
   - Confirm `kill_on_timeout` soft-kills first and hard-aborts if needed.
   - Confirm it can retrieve output from finished blocking agents too.
3. Notifications
   - Confirm async completion notifications arrive at turn boundaries.
   - Confirm multiple completions are consolidated into one notification.
   - Confirm consumed completions do not keep resurfacing after `wait_for_agent`.
4. Prompt composition
   - Confirm agent markdown variables, skills, `{{context_files}}`, and prompt parts render correctly.
5. Root agent and commands
   - Confirm `defaultRootAgent` resolution.
   - Confirm `/agent` and `/dump-prompt` still work.
6. Docs contract
   - Confirm the markdown docs are not stale relative to the registered commands and tools.

## Recommended execution order

1. Run the deterministic Vitest suites.
2. If `RUN_REAL_LLM_TESTS=1` and API key access is available, run the opt-in live `test/task-llm.test.ts`.
3. If you have a live Pi session, perform a manual smoke test:
   - call `Task` with `blocking:false`
   - capture the returned ID
   - call `wait_for_agent`
   - resume the same ID with `Task resume:<id>`
   - verify the sub-agent remembers earlier context

## Final report

Include:
- commands run
- tests passed/failed
- returned agent IDs
- any flaky or unverified gaps
