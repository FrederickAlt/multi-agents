/**
 * Notification contract that owns async sub-agent completion lifecycle state.
 *
 * Implementations keep track of:
 * - completed-but-unconsumed agents
 * - which of those are still pending first-boundary delivery
 * - reminder cadence for still-unconsumed agents
 * - consumption of currently completed agents so they stop appearing in notifications
 */
export type AsyncAgentNotificationOpportunity = "input" | "turn_end";

/**
 * Notification facade owned by the async agent extension.
 */
export interface AsyncAgentNotificationPort {
	/** Record an agent completion so it can be surfaced to the root agent. */
	markCompleted(id: string): void;

	/** Mark consumed IDs so they stop appearing in any future notifications. */
	consume(ids: string[]): void;

	/**
	 * Return the currently due notification, if any.
	 *
	 * This advances cadence state and is expected to be called for both
	 * user-input and turn-end opportunities.
	 */
	takeDueNotification(opportunity?: AsyncAgentNotificationOpportunity): string | null;
}

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

export class AsyncAgentNotifier implements AsyncAgentNotificationPort {
	/** Completed-but-unconsumed agent IDs. */
	private completed: Set<string> = new Set();

	/** Completed IDs not yet announced at a turn boundary. */
	private pendingCompletions: Set<string> = new Set();

	/** Version bump only when new unconsumed completions are introduced. */
	private completionStateVersion = 0;
	/** Incremented at each new logical user/input opportunity. */
	private deliveryOpportunity = 0;
	private lastOpportunity = 0;
	private lastOpportunityCompletionVersion = -1;
	private lastOpportunityKind: AsyncAgentNotificationOpportunity = "turn_end";

	private turnsSinceNotification = 0;
	private readonly reminderTurnInterval: number;

	constructor(options: AsyncAgentNotifierOptions = {}) {
		this.reminderTurnInterval = options.reminderTurnInterval ?? 5;
	}

	/** Record an agent as completed-but-unconsumed. Idempotent per outstanding result. */
	markCompleted(id: string): void {
		if (this.completed.has(id)) return;
		this.completed.add(id);
		this.pendingCompletions.add(id);
		this.turnsSinceNotification = 0;
		this.completionStateVersion += 1;
	}

	private advanceOpportunity(opportunity: AsyncAgentNotificationOpportunity): number {
		if (opportunity === "input" || this.lastOpportunityKind !== "input") {
			this.deliveryOpportunity += 1;
		}
		this.lastOpportunityKind = opportunity;
		return this.deliveryOpportunity;
	}

	/**
	 * Mark one or more agent IDs as consumed (results retrieved via
	 * `wait_for_agent`).
	 */
	consume(ids: string[]): void {
		for (const id of ids) {
			if (this.completed.delete(id)) {
				this.pendingCompletions.delete(id);
			}
		}
		if (this.completed.size === 0) {
			this.turnsSinceNotification = 0;
		}
	}

	clear(): void {
		this.completed.clear();
		this.pendingCompletions.clear();
		this.completionStateVersion = 0;
		this.deliveryOpportunity = 0;
		this.lastOpportunity = 0;
		this.lastOpportunityCompletionVersion = -1;
		this.lastOpportunityKind = "turn_end";
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
	 * Return the notification due at this turn boundary / input batching point,
	 * if any.
	 *
	 * New completions notify immediately at the next boundary and reset the
	 * reminder counter. If no new completion arrives, reminders are emitted only
	 * after `reminderTurnInterval` further boundaries.
	 */
	takeNotificationForTurnBoundary(opportunity: AsyncAgentNotificationOpportunity = "turn_end"): string | null {
		return this.takeDueNotificationInternal(opportunity);
	}

	/**
	 * Alias for callers that think in terms of "due" notifications.
	 */
	takeDueNotification(opportunity: AsyncAgentNotificationOpportunity = "turn_end"): string | null {
		return this.takeDueNotificationInternal(opportunity);
	}

	private takeDueNotificationInternal(opportunity: AsyncAgentNotificationOpportunity): string | null {
		const currentOpportunity = this.advanceOpportunity(opportunity);
		if (this.lastOpportunity === currentOpportunity && this.lastOpportunityCompletionVersion === this.completionStateVersion) {
			return null;
		}

		this.lastOpportunity = currentOpportunity;
		this.lastOpportunityCompletionVersion = this.completionStateVersion;

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
	 * machine; use `takeDueNotification()` or `takeNotificationForTurnBoundary()`
	 * to mutate reminder cadence.
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
