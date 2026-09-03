// Counts `modeActiveMs` only while at least one client is connected. No
// timers and no `Date.now()`: the Node drives `tick`, so every method takes
// the current time and tests use a fake clock.
export const PERSIST_INTERVAL_MS = 30_000;

export interface ActiveClockOptions {
	connectedClients: () => number;
	persist: (k: string, activeMs: number) => void;
	persistIntervalMs?: number;
}

export class ActiveClock {
	private readonly persist: (k: string, activeMs: number) => void;
	private readonly persistIntervalMs: number;
	private connected: number;
	private lastSeen: number | undefined;
	private readonly totals = new Map<string, number>();
	private readonly persisted = new Map<string, number>();

	constructor(options: ActiveClockOptions) {
		this.persist = options.persist;
		this.persistIntervalMs = options.persistIntervalMs ?? PERSIST_INTERVAL_MS;
		this.connected = Math.max(0, options.connectedClients());
	}

	resume(key: string, activeMs: number, nowMs: number): void {
		this.accrue(nowMs);
		this.totals.set(key, activeMs);
		this.persisted.set(key, activeMs);
	}

	// The final total. Flushes unsaved accrual; a key that never accrued is
	// not persisted.
	suspend(key: string, nowMs: number): number {
		this.accrue(nowMs);
		const total = this.totals.get(key) ?? 0;
		this.totals.delete(key);
		const saved = this.persisted.get(key);
		this.persisted.delete(key);
		if (saved === undefined || total > saved) {
			this.persist(key, total);
		}
		return total;
	}

	activeMs(key: string): number {
		return this.totals.get(key) ?? 0;
	}

	keys(): string[] {
		return [...this.totals.keys()];
	}

	setConnectedClients(count: number, nowMs: number): void {
		this.accrue(nowMs);
		this.connected = Math.max(0, count);
	}

	tick(nowMs: number): void {
		this.accrue(nowMs);
	}

	private accrue(nowMs: number): void {
		if (this.lastSeen !== undefined && this.connected > 0) {
			const span = Math.max(0, nowMs - this.lastSeen);
			if (span > 0) {
				for (const [key, total] of this.totals) {
					const next = total + span;
					this.totals.set(key, next);
					if (next - (this.persisted.get(key) ?? 0) >= this.persistIntervalMs) {
						this.persisted.set(key, next);
						this.persist(key, next);
					}
				}
			}
		}
		this.lastSeen = nowMs;
	}
}
