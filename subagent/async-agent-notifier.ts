/**
 * AsyncAgentNotifier — notification state machine for async sub-agent completions.
 *
 * Tracks agent IDs that have completed asynchronously but whose output
 * hasn't been consumed yet via `wait_for_agent`. At turn boundaries
 * generates consolidated `[System]` notifications listing unconsumed agents.
 *
 * The state machine is fully synchronous and pure — no timers, no I/O,
 * no Pi runtime dependency. It is designed to be unit-tested in isolation.
 *
 * ## States
 *
 *   [empty]  ──+agent_end──→  [unconsumed]  ──turn boundary──→  [unconsumed] + notification
 *                                        ↑                             │
 *                                        │                             │
 *                                        └───wait_for_agent────────────┘
 *                                                                  (consumption removes IDs)
 *
 * ## Lifecycle
 *
 * 1. An async sub-agent session fires `agent_end` → `markCompleted(id)`.
 * 2. At the next turn boundary the extension calls `getPendingNotification()`
 *    to get a consolidated `[System]` message listing all ids whose
 *    completion hasn't been consumed yet.
 * 3. `wait_for_agent` retrieves results → `consume(ids)` removes them.
 * 4. If the set becomes empty the notification is omitted.
 *
 * ## Out of scope (see later issues)
 *
 * - Reminder policy / 5-turn counter (#27)
 * - Batching with user messages (#27)
 */
export class AsyncAgentNotifier {
	/** Completed-but-unconsumed agent IDs. */
	private completed: Set<string> = new Set();

	/** Record an agent as completed-but-unconsumed. Idempotent. */
	markCompleted(id: string): void {
		this.completed.add(id);
	}

	/**
	 * Mark one or more agent IDs as consumed (results retrieved via
	 * `wait_for_agent`). No-op for unknown IDs.
	 */
	consume(ids: string[]): void {
		for (const id of ids) {
			this.completed.delete(id);
		}
	}

	/** Whether there are any unconsumed completed agents. */
	hasUnconsumed(): boolean {
		return this.completed.size > 0;
	}

	/** The unconsumed completed agent IDs (read-only snapshot). */
	getUnconsumed(): readonly string[] {
		return [...this.completed].sort();
	}

	/**
	 * Build the consolidated `[System]` notification message, or `null`
	 * when there is nothing to notify about.
	 *
	 * The message instructs the parent agent to call `wait_for_agent`
	 * with the listed IDs.
	 */
	buildNotification(): string | null {
		if (this.completed.size === 0) return null;

		const ids = [...this.completed].sort();
		const idList = ids.map((id) => `"${id}"`).join(", ");

		const lines = [
			`[System] The following async sub-agent(s) have completed and are waiting for you to retrieve their output:`,
			"",
			...ids.map((id) => `- \`${id}\``),
			"",
			`Use \`wait_for_agent\` with agent_ids [${idList}] to retrieve their output.`,
		];

		return lines.join("\n");
	}
}
