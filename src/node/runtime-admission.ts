import { randomUUID } from "node:crypto";
import { NodeError } from "./protocol.ts";

/** Node-owned admission, independent of persisted actor labels. */
export class RuntimeAdmission {
	readonly instanceId: string;
	private pending = 0;
	private drain: { token: string; expiresAt: number } | undefined;
	private stopping = false;
	private readonly now: () => number;

	constructor(instanceId: string = randomUUID(), now: () => number = Date.now) {
		this.instanceId = instanceId;
		this.now = now;
	}

	private currentDrain(): { token: string; expiresAt: number } | undefined {
		if (this.drain && !this.stopping && this.drain.expiresAt <= this.now()) this.drain = undefined;
		return this.drain;
	}

	enter(): () => void {
		if (this.stopping || this.currentDrain())
			throw new NodeError(
				"BUSY",
				"Neta is preparing an update. Retry after reconnecting; this request was not started.",
			);
		this.pending++;
		let released = false;
		return () => {
			if (!released) {
				released = true;
				this.pending--;
			}
		};
	}

	prepare(
		expectedInstance: string,
		active: boolean,
	): { prepared: false; reason: string } | { prepared: true; token: string; expiresAt: number } {
		if (expectedInstance !== this.instanceId) return { prepared: false, reason: "instance-changed" };
		if (this.stopping || this.currentDrain()) return { prepared: false, reason: "update-in-progress" };
		if (active || this.pending > 0) return { prepared: false, reason: "active-work" };
		this.drain = { token: randomUUID(), expiresAt: this.now() + 15_000 };
		return { prepared: true, ...this.drain };
	}

	commit(expectedInstance: string, token: string, active: boolean): boolean {
		const drain = this.currentDrain();
		if (expectedInstance !== this.instanceId || !drain || drain.token !== token || this.stopping) return false;
		if (active || this.pending > 0) {
			this.drain = undefined;
			return false;
		}
		this.stopping = true;
		return true;
	}

	cancel(expectedInstance: string, token: string): void {
		if (expectedInstance === this.instanceId && this.currentDrain()?.token === token && !this.stopping)
			this.drain = undefined;
	}

	stop(): void {
		this.stopping = true;
	}

	get pendingCount(): number {
		return this.pending;
	}
}
