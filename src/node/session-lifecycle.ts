import { NodeError } from "./protocol.ts";

/** All callers share this queue: attachment, parent wake, reset, and close. */
export class SessionLifecycle {
	private readonly generations = new Map<string, number>();
	private readonly retired = new Set<string>();
	private readonly pending = new Map<string, Promise<void>>();

	async run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
		const generation = this.generations.get(sessionId) ?? 0;
		const previous = this.pending.get(sessionId);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.pending.set(sessionId, gate);
		try {
			await previous;
			if (this.retired.has(sessionId) || (this.generations.get(sessionId) ?? 0) !== generation)
				throw new NodeError(
					"NOT_FOUND",
					"This conversation binding changed while the operation was waiting. Reopen the current conversation.",
				);
			return await operation();
		} finally {
			release();
			if (this.pending.get(sessionId) === gate) this.pending.delete(sessionId);
		}
	}

	invalidate(sessionId: string, retire = false): void {
		this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
		if (retire) this.retired.add(sessionId);
	}

	async settled(): Promise<void> {
		await Promise.all([...this.pending.values()]);
	}

	get pendingCount(): number {
		return this.pending.size;
	}
}
