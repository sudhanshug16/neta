// One object the Node and the tool server call, wiring records, approval,
// clock, reminders and the switch path together. `setMode` is the manual
// path (no record, cause `user`); `requestLeadPlus` grants through the
// charter rule with cause `tool`.
import type {
	DecisionRecord,
	Event,
	IsoTime,
	LeaderMode,
	Mission,
	MissionId,
	SessionId,
	WorkspaceId,
} from "../core/types.ts";
import { type Approval, evaluateRequest, parseReservations } from "./approval.ts";
import type { ActiveClock } from "./clock.ts";
import {
	type LeadMode,
	type LeadModeStore,
	type ModeSnapshot,
	type ModeSubject,
	modeEventData,
	snapshotOf,
	subjectKey,
} from "./records.ts";
import { bannerLine, type ReminderTracker, reminderLine } from "./reminders.ts";
import { applyModeSwitch, type SwitchDeps } from "./switch.ts";

export interface ModeServiceDeps {
	store: LeadModeStore;
	clock: ActiveClock;
	reminders: ReminderTracker;
	switchDeps: SwitchDeps;
	mission(id: MissionId): Mission | undefined;
	sessionFor(subject: ModeSubject): SessionId | undefined;
	charter(workspaceId: WorkspaceId): string;
	lastModeChange(subject: ModeSubject): Event | undefined;
	emit(event: Omit<Event, "seq">): void;
	now(): number;
	nowIso(): IsoTime;
}

// The granting record rebuilt from the last mode-change event, so Lead++
// survives a restart: the record lives flat on the event and nowhere else.
function recordFromEvent(event: Event | undefined): DecisionRecord | undefined {
	const data = event?.data;
	if (data === undefined) {
		return undefined;
	}
	for (const field of [
		"objective",
		"whyLeadInsufficient",
		"missionId",
		"mutationKind",
		"validation",
		"externalEffects",
	] as const) {
		if (typeof data[field] !== "string") {
			return undefined;
		}
	}
	if (typeof data.estimatedFiles !== "number" || typeof data.estimatedMinutes !== "number") {
		return undefined;
	}
	return {
		objective: data.objective as string,
		whyLeadInsufficient: data.whyLeadInsufficient as string,
		missionId: data.missionId as string,
		worktreePath: typeof data.worktreePath === "string" ? (data.worktreePath as string) : undefined,
		mutationKind: data.mutationKind as string,
		estimatedFiles: data.estimatedFiles as number,
		validation: data.validation as string,
		estimatedMinutes: data.estimatedMinutes as number,
		externalEffects: data.externalEffects as string,
	};
}

export class ModeService {
	private readonly deps: ModeServiceDeps;

	constructor(deps: ModeServiceDeps) {
		this.deps = deps;
	}

	async snapshot(subject: ModeSubject): Promise<ModeSnapshot> {
		const file = await this.deps.store.read(subject.workspaceId);
		const snap = snapshotOf(file.leader, file.leadModes, subject);
		if (snap.mode === "leadPlus") {
			// Post-restart realignment: the clock forgot this lifetime's keys,
			// so resume from the stored total and align the tracker silently.
			const key = subjectKey(subject);
			if (!this.deps.clock.keys().includes(key)) {
				this.deps.clock.resume(key, snap.modeActiveMs, this.deps.now());
				this.deps.reminders.observe(key, snap.modeActiveMs);
				this.deps.reminders.take(key);
			}
		}
		return snap;
	}

	// Manual path: the user's choice, no record, one subject.
	async setMode(subject: ModeSubject, mode: LeaderMode): Promise<ModeSnapshot> {
		const current = await this.snapshot(subject);
		if (current.mode === mode) {
			return current;
		}
		return this.switch(subject, current.mode, mode, "user");
	}

	async requestLeadPlus(
		subject: ModeSubject,
		record: DecisionRecord,
	): Promise<{ result: Approval; snapshot: ModeSnapshot }> {
		const current = await this.snapshot(subject);
		if (current.mode === "leadPlus") {
			return { result: { approved: true }, snapshot: current };
		}
		const result = await this.evaluateLeadPlus(subject, record);
		if (!result.approved) {
			return { result, snapshot: current };
		}
		return { result, snapshot: await this.applyApprovedLeadPlus(subject, record) };
	}

	async evaluateLeadPlus(subject: ModeSubject, record: DecisionRecord): Promise<Approval> {
		const mission = this.deps.mission(record.missionId);
		return evaluateRequest({
			record,
			mission,
			caller: subject,
			reservations: parseReservations(this.deps.charter(subject.workspaceId)),
		});
	}

	async applyApprovedLeadPlus(subject: ModeSubject, record: DecisionRecord): Promise<ModeSnapshot> {
		const current = await this.snapshot(subject);
		if (current.mode === "leadPlus") return current;
		const mission = this.deps.mission(record.missionId);
		return this.switch(subject, current.mode, "leadPlus", "tool", {
			record,
			missionId: record.missionId,
			mission: mission === undefined ? undefined : { number: mission.number, name: mission.name },
		});
	}

	// Closing or abandoning a mission returns its lead to `lead`, with the
	// cause the disposition implies. A leader-led mission has no lead agent,
	// so there is nobody to return.
	async onMissionClosed(mission: Mission): Promise<void> {
		if (mission.lead.kind !== "agent") {
			return;
		}
		const subject: ModeSubject = { kind: "lead", workspaceId: mission.workspaceId, agentId: mission.lead.agentId };
		const current = await this.snapshot(subject);
		if (current.mode === "lead") {
			return;
		}
		await this.switch(
			subject,
			current.mode,
			"lead",
			mission.disposition === "abandoned" ? "missionAbandoned" : "missionClosed",
			{
				missionId: mission.id,
				mission: { number: mission.number, name: mission.name },
			},
		);
	}

	onClientsChanged(count: number): void {
		this.deps.clock.setConnectedClients(count, this.deps.now());
	}

	tick(): void {
		const now = this.deps.now();
		this.deps.clock.tick(now);
		for (const key of this.deps.clock.keys()) {
			const activeMs = this.deps.clock.activeMs(key);
			if (this.deps.reminders.observe(key, activeMs) === "firstEvent") {
				this.deps.emit({
					at: this.deps.nowIso(),
					workspaceId: key.split(":")[1] ?? "",
					kind: "leader.modeReminder",
					data: { activeMs },
				});
			}
		}
	}

	// Every tool response passes through here (05 calls it): a `lead`
	// response is unchanged; a `leadPlus` one carries exactly one banner line
	// plus one coalesced reminder when one is due.
	async decorate(subject: ModeSubject, response: string): Promise<string> {
		const snap = await this.snapshot(subject);
		if (snap.mode !== "leadPlus") {
			return response;
		}
		const key = subjectKey(subject);
		const activeMs = this.deps.clock.keys().includes(key) ? this.deps.clock.activeMs(key) : snap.modeActiveMs;
		const mins = Math.floor(activeMs / 60_000);
		let missionId = snap.missionId;
		if (missionId === undefined && subject.kind === "leader") {
			missionId = (await this.deps.store.read(subject.workspaceId)).leader.activeMissionId;
		}
		const mission = missionId === undefined ? undefined : this.deps.mission(missionId);
		const banner =
			mission === undefined
				? `Lead++ active ${mins} min`
				: bannerLine({ activeMs, missionNumber: mission.number, missionName: mission.name });
		const parts = [banner, response];
		if (this.deps.reminders.take(key)) {
			parts.push(reminderLine({ activeMs, record: recordFromEvent(this.deps.lastModeChange(subject)) }));
		}
		return parts.join("\n");
	}

	private async switch(
		subject: ModeSubject,
		from: LeaderMode,
		to: LeaderMode,
		cause: "user" | "tool" | "missionClosed" | "missionAbandoned",
		opts?: { record?: DecisionRecord; missionId?: MissionId; mission?: { number: number; name: string } },
	): Promise<ModeSnapshot> {
		const file = await this.deps.store.read(subject.workspaceId);
		const key = subjectKey(subject);
		const at = this.deps.nowIso();
		const now = this.deps.now();
		const snap = snapshotOf(file.leader, file.leadModes, subject);
		let missionId = opts?.missionId;
		if (to === "leadPlus") {
			if (subject.kind === "leader") {
				await this.deps.store.writeLeader(subject.workspaceId, {
					...file.leader,
					mode: to,
					modeSince: at,
					modeActiveMs: snap.modeActiveMs,
				});
			} else {
				const prev = file.leadModes[subject.agentId];
				missionId = missionId ?? prev?.missionId ?? "";
				const mode: LeadMode = {
					agentId: subject.agentId,
					missionId,
					mode: to,
					modeSince: at,
					modeActiveMs: snap.modeActiveMs,
				};
				await this.deps.store.writeLeadMode(subject.workspaceId, subject.agentId, mode);
			}
			this.deps.clock.resume(key, snap.modeActiveMs, now);
		} else {
			const live = this.deps.clock.keys().includes(key);
			const final = live ? this.deps.clock.suspend(key, now) : snap.modeActiveMs;
			if (subject.kind === "leader") {
				await this.deps.store.writeLeader(subject.workspaceId, {
					...file.leader,
					mode: to,
					modeSince: at,
					modeActiveMs: final,
				});
			} else {
				const prev = file.leadModes[subject.agentId];
				missionId = missionId ?? prev?.missionId;
				await this.deps.store.writeLeadMode(subject.workspaceId, subject.agentId, {
					agentId: subject.agentId,
					missionId: missionId ?? "",
					mode: to,
					modeSince: at,
					modeActiveMs: final,
				});
			}
			this.deps.reminders.clear(key);
		}
		const mission = opts?.mission ?? this.storedMission(subject, file.leadModes);
		const sessionId = this.deps.sessionFor(subject);
		if (sessionId !== undefined) {
			await applyModeSwitch(this.deps.switchDeps, {
				sessionId,
				from,
				to,
				cause,
				mission,
				record: opts?.record,
			});
		}
		this.deps.emit({
			at,
			workspaceId: subject.workspaceId,
			kind: "leader.modeChanged",
			...(missionId === undefined ? {} : { missionId }),
			data: modeEventData({ from, to, cause, missionId, record: opts?.record }),
		});
		const fresh = await this.deps.store.read(subject.workspaceId);
		return snapshotOf(fresh.leader, fresh.leadModes, subject);
	}

	private storedMission(
		subject: ModeSubject,
		leadModes: Record<string, LeadMode>,
	): { number: number; name: string } | undefined {
		if (subject.kind === "leader") {
			return undefined;
		}
		const missionId = leadModes[subject.agentId]?.missionId;
		if (missionId === undefined || missionId === "") {
			return undefined;
		}
		const mission = this.deps.mission(missionId);
		return mission === undefined ? undefined : { number: mission.number, name: mission.name };
	}
}
