import type { ParentReport } from "../store/parent-reports.ts";
import { deliverParentReport, type ReportPorts } from "./agent-runtime.ts";

/** One durable receipt per child turn, serialized continuation admission per parent. */
export class ParentDispatcher {
	private readonly pending = new Map<string, ParentReport>();
	private readonly parents = new Map<string, Promise<void>>();
	private readonly running = new Set<string>();
	private timer?: ReturnType<typeof setTimeout>;
	private timerAt = 0;
	private stopped = false;
	private readonly failures = new Map<string, number>();
	private readonly retryAt = new Map<string, number>();
	constructor(privatePorts: ReportPorts, onError: (report: ParentReport, error: unknown) => void) {
		this.ports = privatePorts;
		this.onError = onError;
	}
	private readonly ports: ReportPorts;
	private readonly onError: (report: ParentReport, error: unknown) => void;
	enqueue(report: ParentReport): void {
		if (this.stopped || report.status !== "pending") return;
		this.pending.set(report.id, report);
		this.schedule(0);
	}
	private schedule(delay: number): void {
		if (this.stopped || !this.pending.size) return;
		const at = Date.now() + delay;
		if (this.timer && this.timerAt <= at) return;
		clearTimeout(this.timer);
		this.timerAt = at;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			for (const report of this.pending.values()) this.dispatch(report);
			this.scheduleNext();
		}, delay);
		this.timer.unref();
	}
	private scheduleNext(): void {
		if (this.stopped) return;
		let earliest = Infinity;
		for (const report of this.pending.values()) {
			const parent = report.parentActorId ?? `workspace:${report.workspaceId}`;
			if (!this.parents.has(parent)) earliest = Math.min(earliest, this.retryAt.get(parent) ?? 0);
		}
		if (earliest !== Infinity) this.schedule(Math.max(0, earliest - Date.now()));
	}
	private dispatch(report: ParentReport): void {
		if (this.stopped || this.running.has(report.id)) return;
		const parent = report.parentActorId ?? `workspace:${report.workspaceId}`;
		// Keep a failed head in place: a later result must not bypass it. Other
		// parents remain independent, including while this parent's backoff runs.
		if (this.parents.has(parent) || (this.retryAt.get(parent) ?? 0) > Date.now()) return;
		this.running.add(report.id);
		const operation = Promise.resolve()
			.then(async () => {
				if (this.stopped) return;
				await deliverParentReport(report, this.ports);
				this.pending.delete(report.id);
				this.failures.delete(parent);
				this.retryAt.delete(parent);
			})
			.catch((error: unknown) => {
				const failures = Math.min(6, (this.failures.get(parent) ?? 0) + 1);
				this.failures.set(parent, failures);
				this.retryAt.set(parent, Date.now() + Math.min(30_000, 500 * 2 ** failures));
				this.onError(report, error);
			})
			.finally(() => {
				this.running.delete(report.id);
				if (this.parents.get(parent) === operation) this.parents.delete(parent);
				this.scheduleNext();
			});
		this.parents.set(parent, operation);
	}
	stop(): void {
		this.stopped = true;
		clearTimeout(this.timer);
	}
	get pendingCount(): number {
		return this.pending.size;
	}
}
