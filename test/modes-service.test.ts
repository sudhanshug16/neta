import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionEvent, startSession } from "../src/acp/session.ts";
import type { ProviderSettings } from "../src/acp/settings.ts";
import type { AgentId, DecisionRecord, Event, Leader, Mission, SessionId } from "../src/core/types.ts";
import { ActiveClock } from "../src/modes/clock.ts";
import { type LeaderFile, type ModeSubject, subjectKey } from "../src/modes/records.ts";
import { ReminderTracker } from "../src/modes/reminders.ts";
import { ModeService, type ModeServiceDeps } from "../src/modes/service.ts";

const FIXTURE = new URL("./fixtures/fake-acp-agent.mjs", import.meta.url).pathname;
const WORKSPACE = "w";
const AGENT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MISSION = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const LEAD: ModeSubject = { kind: "lead", workspaceId: WORKSPACE, agentId: AGENT as AgentId };
const LEADER: ModeSubject = { kind: "leader", workspaceId: WORKSPACE };

function settingsFor(store: string) {
	const fake: ProviderSettings = {
		command: process.execPath,
		args: [FIXTURE, "--session-store", store],
		resume: true,
		defaultModel: "",
	};
	return { providers: { fake }, leader: { provider: "fake" }, forbiddenModels: [] as string[] };
}

type Started = Awaited<ReturnType<typeof startSession>>;

async function start(): Promise<Started> {
	const dir = mkdtempSync(join(tmpdir(), "neta-modesvc-"));
	const store = join(dir, "store.json");
	writeFileSync(store, JSON.stringify({ counter: 0, sessions: {} }));
	return startSession({
		settings: settingsFor(store),
		provider: "fake",
		access: "readOnly",
		cwd: mkdtempSync(join(tmpdir(), "neta-modesvc-")),
	});
}

const collectors = new WeakMap<Started, { seen: SessionEvent[]; at: number }>();

function collectorFor(session: Started): { seen: SessionEvent[]; at: number } {
	let collector = collectors.get(session);
	if (collector === undefined) {
		collector = { seen: [], at: 0 };
		collectors.set(session, collector);
		const owned = collector;
		void (async (): Promise<void> => {
			for await (const event of session.events()) {
				owned.seen.push(event);
			}
		})();
	}
	return collector;
}

async function drainTurn(session: Started, turnId: string): Promise<void> {
	const collector = collectorFor(session);
	for (;;) {
		const end = collector.seen
			.slice(collector.at)
			.find((event) => (event.type === "turnEnd" && event.turnId === turnId) || event.type === "interrupted");
		if (end !== undefined) {
			collector.at = collector.seen.length;
			return;
		}
		await Bun.sleep(10);
	}
}

function baseLeader(): Leader {
	return {
		workspaceId: WORKSPACE,
		machineId: "m",
		name: "Halden",
		sessionId: "01ARZ3NDEKTSV4RRFFQ69G5AAA",
		provider: "fake",
		model: "test-model",
		mode: "lead",
		modeSince: new Date(0).toISOString(),
		modeActiveMs: 0,
		state: "running",
	};
}

function baseMission(): Mission {
	return {
		id: MISSION,
		number: 4,
		workspaceId: WORKSPACE,
		machineId: "m",
		name: "lens port",
		objective: "port the lens",
		changes: [],
		lead: { kind: "agent", agentId: AGENT as AgentId },
		agentIds: [AGENT as AgentId],
		access: "readOnly",
		state: "running",
		createdAt: new Date(0).toISOString(),
	};
}

function baseRecord(extra?: Partial<DecisionRecord>): DecisionRecord {
	return {
		objective: "port the lens",
		whyLeadInsufficient: "needs a writer",
		missionId: MISSION,
		mutationKind: "code",
		estimatedFiles: 3,
		validation: "tests pass",
		estimatedMinutes: 30,
		externalEffects: "none",
		...extra,
	};
}

interface Fixture {
	service: ModeService;
	emitted: Array<Omit<Event, "seq">>;
	calls: string[];
	missions: Map<string, Mission>;
	files: Map<string, LeaderFile>;
	nowMs: { value: number };
	sessions: Map<string, Started>;
	charterText: { value: string };
}

function fixture(sessions: Map<string, Started>): Fixture {
	const files = new Map<string, LeaderFile>();
	const missions = new Map<string, Mission>([[MISSION, baseMission()]]);
	const emitted: Array<Omit<Event, "seq">> = [];
	const calls: string[] = [];
	const nowMs = { value: 0 };
	const charterText = { value: "" };

	function readFile(workspaceId: string): LeaderFile {
		return files.get(workspaceId) ?? { leader: baseLeader(), leadModes: {} };
	}

	const deps: ModeServiceDeps = {
		store: {
			read: (workspaceId) => Promise.resolve(readFile(workspaceId)),
			writeLeader: (workspaceId, leader) => {
				files.set(workspaceId, { leader, leadModes: readFile(workspaceId).leadModes });
				return Promise.resolve();
			},
			writeLeadMode: (workspaceId, agentId, mode) => {
				const file = readFile(workspaceId);
				const leadModes = { ...file.leadModes };
				if (mode === undefined) {
					delete leadModes[agentId];
				} else {
					leadModes[agentId] = mode;
				}
				files.set(workspaceId, { leader: file.leader, leadModes });
				return Promise.resolve();
			},
		},
		clock: new ActiveClock({
			connectedClients: () => 0,
			persist: (key, activeMs) => {
				const parts = key.split(":");
				if (parts[0] === "leader" && parts[1] !== undefined) {
					const file = readFile(parts[1]);
					files.set(parts[1], { leader: { ...file.leader, modeActiveMs: activeMs }, leadModes: file.leadModes });
				} else if (parts[0] === "lead" && parts[1] !== undefined && parts[2] !== undefined) {
					const file = readFile(parts[1]);
					const prev = file.leadModes[parts[2]];
					if (prev !== undefined) {
						files.set(parts[1], {
							leader: file.leader,
							leadModes: { ...file.leadModes, [parts[2]]: { ...prev, modeActiveMs: activeMs } },
						});
					}
				}
			},
		}),
		reminders: new ReminderTracker(),
		switchDeps: {
			isTurnActive: (id) =>
				[...sessions.values()].some((session) => session.sessionId === id && session.openTurnId !== undefined),
			steer: async (id, prompt) => {
				calls.push(`steer:${id}`);
				const session = [...sessions.values()].find((candidate) => candidate.sessionId === id);
				if (session === undefined) {
					throw new Error(`no live session: ${id}`);
				}
				if (session.openTurnId !== undefined) {
					calls.push(`cancel:${id}`);
					await session.cancel();
					while (session.openTurnId !== undefined) {
						await Bun.sleep(10);
					}
				}
				await drainTurn(session, session.prompt(prompt));
			},
			switchAccess: (id, access) => {
				calls.push(`access:${id}:${access}`);
				return Promise.resolve();
			},
		},
		mission: (id) => missions.get(id),
		sessionFor: (subject) => sessions.get(subjectKey(subject))?.sessionId as SessionId | undefined,
		charter: () => charterText.value,
		lastModeChange: () => {
			const found = [...emitted].reverse().find((event) => event.kind === "leader.modeChanged");
			return found === undefined ? undefined : { ...found, seq: 1 };
		},
		emit: (event) => {
			emitted.push(event);
		},
		now: () => nowMs.value,
		nowIso: () => new Date(nowMs.value).toISOString(),
	};
	return { service: new ModeService(deps), emitted, calls, missions, files, nowMs, sessions, charterText };
}

async function withSessions(): Promise<{ lead: Started; leader: Started; bySubject: Map<string, Started> }> {
	const lead = await start();
	const leader = await start();
	return {
		lead,
		leader,
		bySubject: new Map([
			[subjectKey(LEAD), lead],
			[subjectKey(LEADER), leader],
		]),
	};
}

describe("mode service", () => {
	test("an approved request switches access, re-prompts once, and emits modeChanged with the record", async () => {
		const live = await withSessions();
		try {
			const f = fixture(live.bySubject);
			const { result, snapshot } = await f.service.requestLeadPlus(LEAD, baseRecord());
			expect(result).toEqual({ approved: true });
			expect(snapshot.mode).toBe("leadPlus");
			expect(f.calls).toEqual([`access:${live.lead.sessionId}:readWrite`, `steer:${live.lead.sessionId}`]);
			const changed = f.emitted.filter((event) => event.kind === "leader.modeChanged");
			expect(changed).toHaveLength(1);
			expect(changed[0]?.data.objective).toBe("port the lens");
			expect(changed[0]?.data.mutationKind).toBe("code");
			expect(changed[0]?.data.from).toBe("lead");
			expect(changed[0]?.data.to).toBe("leadPlus");
		} finally {
			await live.lead.close();
			await live.leader.close();
		}
	});

	test("a denied request emits nothing and stays in lead", async () => {
		const live = await withSessions();
		try {
			const f = fixture(live.bySubject);
			f.charterText.value = "## Reserved for the user\n\n- database migrations\n";
			const { result, snapshot } = await f.service.requestLeadPlus(
				LEAD,
				baseRecord({ mutationKind: "database migration" }),
			);
			expect(result.approved).toBe(false);
			expect(snapshot.mode).toBe("lead");
			expect(f.calls).toEqual([]);
			expect(f.emitted).toEqual([]);
		} finally {
			await live.lead.close();
			await live.leader.close();
		}
	});

	test("a manual setMode during a live turn cancels and re-prompts once", async () => {
		const live = await withSessions();
		try {
			const f = fixture(live.bySubject);
			const held = live.leader.prompt("HOLD_FOREVER");
			expect(live.leader.openTurnId).toBe(held);
			const snapshot = await f.service.setMode(LEADER, "leadPlus");
			expect(snapshot.mode).toBe("leadPlus");
			expect(f.calls).toEqual([
				`access:${live.leader.sessionId}:readWrite`,
				`steer:${live.leader.sessionId}`,
				`cancel:${live.leader.sessionId}`,
			]);
			expect(live.leader.openTurnId).toBeUndefined();
		} finally {
			await live.lead.close();
			await live.leader.close();
		}
	});

	test("the clock counts only connected time across a disconnect", async () => {
		const live = await withSessions();
		try {
			const f = fixture(live.bySubject);
			await f.service.requestLeadPlus(LEAD, baseRecord());
			f.service.onClientsChanged(1);
			f.nowMs.value = 45_000;
			f.service.tick();
			expect((await f.service.snapshot(LEAD)).modeActiveMs).toBe(45_000);
			f.service.onClientsChanged(0);
			f.nowMs.value = 105_000;
			f.service.tick();
			expect((await f.service.snapshot(LEAD)).modeActiveMs).toBe(45_000);
		} finally {
			await live.lead.close();
			await live.leader.close();
		}
	});

	test("at 10 active minutes one reminder is emitted and decorate carries one coalesced reminder", async () => {
		const live = await withSessions();
		try {
			const f = fixture(live.bySubject);
			await f.service.requestLeadPlus(LEAD, baseRecord());
			f.service.onClientsChanged(1);
			f.nowMs.value = 600_000;
			f.service.tick();
			expect(f.emitted.filter((event) => event.kind === "leader.modeReminder")).toHaveLength(1);
			f.service.tick();
			expect(f.emitted.filter((event) => event.kind === "leader.modeReminder")).toHaveLength(1);
			const decorated = await f.service.decorate(LEAD, "done");
			const lines = decorated.split("\n");
			expect(lines[0]).toBe("Lead++ active 10 min · #4 lens port");
			expect(lines[1]).toBe("done");
			expect(lines).toHaveLength(3);
			expect(lines[2]).toContain("port the lens");
			// Two more intervals fall due with no take: still one reminder.
			f.nowMs.value = 840_000;
			f.service.tick();
			f.service.tick();
			const again = await f.service.decorate(LEAD, "done");
			expect(again.split("\n")).toHaveLength(3);
			const plain = await f.service.decorate(LEAD, "done");
			expect(plain.split("\n")).toEqual(["Lead++ active 14 min · #4 lens port", "done"]);
		} finally {
			await live.lead.close();
			await live.leader.close();
		}
	});

	test("closing a mission returns its lead to lead", async () => {
		const live = await withSessions();
		try {
			const f = fixture(live.bySubject);
			await f.service.requestLeadPlus(LEAD, baseRecord());
			expect((await f.service.snapshot(LEAD)).mode).toBe("leadPlus");
			const mission = f.missions.get(MISSION);
			if (mission === undefined) {
				throw new Error("no mission");
			}
			await f.service.onMissionClosed({
				...mission,
				state: "closed",
				disposition: "merged",
				closedAt: new Date(0).toISOString(),
			});
			expect((await f.service.snapshot(LEAD)).mode).toBe("lead");
			const changed = f.emitted.filter((event) => event.kind === "leader.modeChanged");
			expect(changed.at(-1)?.data.cause).toBe("missionClosed");
		} finally {
			await live.lead.close();
			await live.leader.close();
		}
	});
});
