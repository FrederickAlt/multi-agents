/**
 * AsyncAgentNotifier — notification state machine for async sub-agent completions.
 *
 * Tracks agent IDs that have completed asynchronously but whose output
 * hasn't been consumed yet via `wait_for_agent`. At turn boundaries
 * generates consolidated `[System]` notifications listing unconsumed agents,
 * then recurring reminders after a fixed number of turns with no new
 * completion.
 *
 * The state machine is fully synchronous and pure — no timers, no I/O,
 * no Pi runtime dependency. It is designed to be unit-tested in isolation.
 */
export interface AsyncAgentNotifierOptions {
	reminderTurnInterval?: number;
}

export class AsyncAgentNotifier {
	/** Completed-but-unconsumed agent IDs. */
	private completed: Set<string> = new Set();

	/** Completed IDs not yet announced at a turn boundary. */
	private pendingCompletions: Set<string> = new Set();

	private turnsSinceNotification = 0;
	private readonly reminderTurnInterval: number;

	constructor(options: AsyncAgentNotifierOptions = {}) {
		this.reminderTurnInterval = options.reminderTurnInterval ?? 5;
	}

	/** Record an agent as completed-but-unconsumed. Idempotent. */
	markCompleted(id: string): void {
		if (this.completed.has(id)) return;
		this.completed.add(id);
		this.pendingCompletions.add(id);
		this.turnsSinceNotification = 0;
	}

	/**
	 * Mark one or more agent IDs as consumed (results retrieved via
	 * `wait_for_agent`). No-op for unknown IDs.
	 */
	consume(ids: string[]): void {
		for (const id of ids) {
			this.completed.delete(id);
			this.pendingCompletions.delete(id);
		}
		if (this.completed.size === 0) {
			this.turnsSinceNotification = 0;
		}
	}

	clear(): void {
		this.completed.clear();
		this.pendingCompletions.clear();
		this.turnsSinceNotification = 0;
	}

	/** Whether there are any unconsumed completed agents. */
	hasUnconsumed(): boolean {
		return this.completed.size > 0;
	}

	/** Whether a new completion is awaiting its first boundary notification. */
	hasPendingCompletion(): boolean {
		return this.pendingCompletions.size > 0;
	}

	/** The unconsumed completed agent IDs (read-only snapshot). */
	getUnconsumed(): readonly string[] {
		return [...this.completed].sort();
	}

	/**
	 * Return the notification due at this turn boundary, if any.
	 *
	 * New completions notify immediately at the next boundary and reset the
	 * reminder counter. If no new completion arrives, reminders are emitted only
	 * after `reminderTurnInterval` further boundaries.
	 */
	takeNotificationForTurnBoundary(): string | null {
		if (this.completed.size === 0) return null;

		if (this.pendingCompletions.size > 0) {
			this.pendingCompletions.clear();
			this.turnsSinceNotification = 0;
			return this.buildNotification("completion");
		}

		this.turnsSinceNotification += 1;
		if (this.turnsSinceNotification < this.reminderTurnInterval) return null;

		this.turnsSinceNotification = 0;
		return this.buildNotification("reminder");
	}

	/**
	 * Build the consolidated `[System]` notification message, or `null`
	 * when there is nothing to notify about.
	 *
	 * The message instructs the parent agent to call `wait_for_agent`
	 * with the listed IDs. Calling this method does not advance the state
	 * machine; production turn-boundary code should use
	 * `takeNotificationForTurnBoundary()`.
	 */
	buildNotification(kind: "completion" | "reminder" = "completion"): string | null {
		if (this.completed.size === 0) return null;

		const ids = [...this.completed].sort();
		const idList = ids.map((id) => `"${id}"`).join(", ");
		const header = kind === "reminder"
			? `[System] Reminder: the following async sub-agent(s) have completed and are still waiting for you to retrieve their output:`
			: `[System] The following async sub-agent(s) have completed and are waiting for you to retrieve their output:`;

		const lines = [
			header,
			"",
			...ids.map((id) => `- \`${id}\``),
			"",
			`Use \`wait_for_agent\` with agent_ids [${idList}] to retrieve their output.`,
		];

		return lines.join("\n");
	}
}
