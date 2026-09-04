// The `neta_mode` path the Node mounts (`modeMount`): 07's grant rule, the
// charter reservations it must honour, the subject a grant applies to, and
// the active-time accounting a grant starts. The charter is a real
// reservation section here, not an empty list — a self-granted Lead++ becomes
// a readWrite provider session at the next `workspace.open`, so the gate has
// to be live.
import { expect, test } from "bun:test";
import type { AgentId, DecisionRecord, Event, Leader, Mission, WorkspaceId } from "../src/core/types.ts";
import type { LeadMode, LeadModeStore } from "../src/modes/index.ts";
import { type ModeMount, modeMount } from "../src/node/handlers-tools.ts";

const WORKSPACE = "git:github.com/example/repo";

function leader(): Leader {
	return {
		workspaceId: WORKSPACE,
		machineId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		name: "Halden",
		sessionId: "s-leader",
		provider: "fake",
		model: "test-model",
		mode: "lead",
		modeSince: "2026-01-01T00:00:00.000Z",
		modeActiveMs: 0,
		state: "idle",
	};
}

function mission(): Mission {
	return {
		id: "m1",
		number: 1,
		workspaceId: WORKSPACE,
		machineId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		name: "Fix the widget",
		objective: "Make it work",
		changes: [],
		lead: { kind: "agent", agentId: "a1" },
		agentIds: ["a1"],
		access: "readWrite",
		state: "running",
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

function record(): DecisionRecord {
	return {
		objective: "Rewrite the migration",
		whyLeadInsufficient: "the agents cannot see the schema",
		missionId: "m1",
		mutationKind: "database migrations",
		estimatedFiles: 3,
		validation: "bun test",
		estimatedMinutes: 20,
		externalEffects: "none",
	};
}

interface World {
	mount: ModeMount;
	leaders: Leader[];
	leadModes: Record<AgentId, LeadMode>;
	events: Array<Omit<Event, "seq">>;
	clients: number;
	advance(ms: number): void;
}

// A fake `leaders/<workspaceId>.json`: the leader record plus 07's lead
// modes, with every write kept so a test can see what landed and in what
// order.
function world(charter: string, opts?: { clients?: number }): World {
	const leaders: Leader[] = [leader()];
	const leadModes: Record<AgentId, LeadMode> = {};
	const events: Array<Omit<Event, "seq">> = [];
	let nowMs = 0;
	const state = {
		clients: opts?.clients ?? 1,
	};
	const store: LeadModeStore = {
		read: () => Promise.resolve({ leader: leaders[leaders.length - 1] as Leader, leadModes: { ...leadModes } }),
		writeLeader: (_workspaceId: WorkspaceId, next: Leader) => {
			leaders.push(next);
			return Promise.resolve();
		},
		writeLeadMode: (_workspaceId: WorkspaceId, agentId: AgentId, mode: LeadMode | undefined) => {
			if (mode === undefined) {
				delete leadModes[agentId];
			} else {
				leadModes[agentId] = mode;
			}
			return Promise.resolve();
		},
	};
	const mount = modeMount({
		store,
		getMission: (id) => (id === "m1" ? mission() : undefined),
		charter: () => charter,
		connectedClients: () => state.clients,
		emit: (event) => {
			events.push(event);
		},
		now: () => nowMs,
		nowIso: () => "2026-02-02T00:00:00.000Z",
	});
	return {
		mount,
		leaders,
		leadModes,
		events,
		get clients(): number {
			return state.clients;
		},
		set clients(count: number) {
			state.clients = count;
		},
		advance: (ms) => {
			nowMs += ms;
		},
	};
}

const RESERVED = `# Charter

## Reserved for the user

- database migrations
- anything that spends money
`;

const LEADER = { kind: "leader", workspaceId: WORKSPACE } as const;
const LEAD = { kind: "lead", workspaceId: WORKSPACE, missionId: "m1", agentId: "a1" } as const;

test("a charter reserving the mutation kind denies and leaves the leader in lead", async () => {
	const w = world(RESERVED);
	const approval = await w.mount.requestMode({ subject: LEADER, mode: "leadPlus", record: record() });
	expect(approval.approved).toBe(false);
	if (approval.approved) {
		throw new Error("expected a denial");
	}
	expect(approval.reason).toBe("reservedByCharter");
	expect(approval.detail).toContain("database migrations");
	expect(w.leaders).toHaveLength(1);
	expect(w.leaders[0]?.mode).toBe("lead");
	expect(w.events).toHaveLength(0);
});

test("a charter reserving the external effects denies too", async () => {
	const w = world(RESERVED);
	const approval = await w.mount.requestMode({
		subject: LEADER,
		mode: "leadPlus",
		record: { ...record(), mutationKind: "source edits", externalEffects: "anything that spends money" },
	});
	expect(approval.approved).toBe(false);
	expect(w.leaders[0]?.mode).toBe("lead");
});

test("with nothing reserved the leader's own request is granted and written", async () => {
	const w = world("# Charter\n\nProse only.\n");
	const approval = await w.mount.requestMode({ subject: LEADER, mode: "leadPlus", record: record() });
	expect(approval.approved).toBe(true);
	expect(w.leaders[w.leaders.length - 1]?.mode).toBe("leadPlus");
	// 07: the record is written flat onto the event, never nested.
	expect(w.events[0]?.kind).toBe("leader.modeChanged");
	expect(w.events[0]?.data.mutationKind).toBe("database migrations");
	expect(w.events[0]?.data.to).toBe("leadPlus");
	expect(w.events[0]?.data.record).toBeUndefined();
});

// 05 declares `neta_mode` for `lead` as well as `leader`, and 07 keys a
// mission lead's mode by its own `agentId`: the grant lands on that record
// and the workspace leader is untouched.
test("a mission lead's request lands on its own record, not the leader's", async () => {
	const w = world("");
	const approval = await w.mount.requestMode({ subject: LEAD, mode: "leadPlus", record: record() });
	expect(approval.approved).toBe(true);
	expect(w.leadModes.a1?.mode).toBe("leadPlus");
	expect(w.leadModes.a1?.missionId).toBe("m1");
	expect(w.leaders).toHaveLength(1);
	expect(w.leaders[0]?.mode).toBe("lead");

	const back = await w.mount.requestMode({ subject: LEAD, mode: "lead" });
	expect(back.approved).toBe(true);
	expect(w.leadModes.a1?.mode).toBe("lead");
	expect(w.leaders[0]?.mode).toBe("lead");
});

test("a lead cannot grant itself Lead++ on another agent's mission", async () => {
	const w = world("");
	const approval = await w.mount.requestMode({
		subject: { kind: "lead", workspaceId: WORKSPACE, missionId: "m1", agentId: "a2" },
		mode: "leadPlus",
		record: record(),
	});
	expect(approval.approved).toBe(false);
	if (approval.approved) {
		throw new Error("expected a denial");
	}
	expect(approval.reason).toBe("notAuthorised");
	expect(w.leadModes.a2).toBeUndefined();
});

test("a request with no record is incomplete, not granted", async () => {
	const w = world("");
	const approval = await w.mount.requestMode({ subject: LEADER, mode: "leadPlus" });
	expect(approval.approved).toBe(false);
	expect(w.leaders[0]?.mode).toBe("lead");
});

test("a return to lead needs no record and is not a change when already there", async () => {
	const w = world(RESERVED);
	const approval = await w.mount.requestMode({ subject: LEADER, mode: "lead" });
	expect(approval.approved).toBe(true);
	// Already in lead: nothing to write, and 07 emits one event per change.
	expect(w.leaders).toHaveLength(1);
	expect(w.events).toHaveLength(0);
});

// The leader's only route out of Lead++. Reporting success without writing
// would leave the workspace in build access until a person flipped it in the
// UI, because Lead++ outlives a restart.
test("a return after a grant leaves the leader in lead", async () => {
	const w = world("# Charter\n\nProse only.\n");
	expect((await w.mount.requestMode({ subject: LEADER, mode: "leadPlus", record: record() })).approved).toBe(true);
	expect(w.leaders[w.leaders.length - 1]?.mode).toBe("leadPlus");

	const back = await w.mount.requestMode({ subject: LEADER, mode: "lead" });
	expect(back.approved).toBe(true);
	expect(w.leaders[w.leaders.length - 1]?.mode).toBe("lead");
	expect(w.events).toHaveLength(2);
	expect(w.events[1]?.kind).toBe("leader.modeChanged");
	expect(w.events[1]?.data.from).toBe("leadPlus");
	expect(w.events[1]?.data.to).toBe("lead");
});

// The manual path: a person choosing Lead++ in the UI carries no decision
// record and passes no charter gate.
test("setMode grants Lead++ with no record and returns without one", async () => {
	const w = world(RESERVED);
	await w.mount.setMode(LEADER, "leadPlus");
	expect(w.leaders[w.leaders.length - 1]?.mode).toBe("leadPlus");
	expect(w.events[0]?.data.cause).toBe("user");
	await w.mount.setMode(LEADER, "lead");
	expect(w.leaders[w.leaders.length - 1]?.mode).toBe("lead");
});

// MANIFESTO: after ten active minutes the canvas shows a persistent warning
// with the elapsed time, and every subsequent Neta tool response reminds the
// leader why Lead++ is on.
test("a tool-granted Lead++ counts active time, warns at ten minutes and decorates every response", async () => {
	const w = world("# Charter\n\nProse only.\n");
	expect((await w.mount.requestMode({ subject: LEADER, mode: "leadPlus", record: record() })).approved).toBe(true);
	// 05: compact JSON stays on the first line; 07's banner joins the
	// reminder block after it.
	expect(await w.mount.decorate(LEADER, "{}")).toBe("{}\nLead++ active 0 min");

	w.advance(600_000);
	w.mount.tick();
	expect(w.events.some((event) => event.kind === "leader.modeReminder")).toBe(true);

	const decorated = await w.mount.decorate(LEADER, "{}");
	expect(decorated.split("\n")[0]).toBe("{}");
	expect(decorated).toContain("Lead++ active 10 min");
	expect(decorated).toContain("Rewrite the migration");
	// The reminder is coalesced: it is taken once, not on every call after.
	expect(await w.mount.decorate(LEADER, "{}")).toBe("{}\nLead++ active 10 min");

	// The running total reaches the leader record, so the canvas strip has a
	// number to show rather than a permanent zero.
	await Promise.resolve();
	await Promise.resolve();
	expect(w.leaders[w.leaders.length - 1]?.modeActiveMs).toBe(600_000);
});

test("time with nobody connected does not count", async () => {
	const w = world("# Charter\n\nProse only.\n", { clients: 0 });
	expect((await w.mount.requestMode({ subject: LEADER, mode: "leadPlus", record: record() })).approved).toBe(true);
	w.advance(600_000);
	w.mount.tick();
	expect(await w.mount.decorate(LEADER, "{}")).toBe("{}\nLead++ active 0 min");
	w.clients = 1;
	w.mount.tick();
	w.advance(120_000);
	w.mount.tick();
	expect(await w.mount.decorate(LEADER, "{}")).toBe("{}\nLead++ active 2 min");
});
