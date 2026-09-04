// The `neta_mode` gate the Node mounts (`grantMode`): 07's grant rule, the
// charter reservations it must honour, and the subject a grant applies to.
// The charter is a real reservation section here, not an empty list — a
// self-granted Lead++ becomes a readWrite provider session at the next
// `workspace.open`, so the gate has to be live.
import { expect, test } from "bun:test";
import type { DecisionRecord, Event, Leader, Mission, WorkspaceId } from "../src/core/types.ts";
import { grantMode, type ModeGrantPorts } from "../src/node/handlers-tools.ts";

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
	ports: ModeGrantPorts;
	leaders: Leader[];
	events: Array<{ workspaceId: WorkspaceId; kind: string; data: Record<string, unknown> }>;
	announced: Leader[];
}

function world(charter: string): World {
	const leaders: Leader[] = [leader()];
	const events: World["events"] = [];
	const announced: Leader[] = [];
	return {
		leaders,
		events,
		announced,
		ports: {
			getMission: (id) => (id === "m1" ? mission() : undefined),
			getLeader: () => leaders[leaders.length - 1],
			putLeader: async (next) => {
				leaders.push(next);
			},
			appendEvent: async (event) => {
				events.push(event);
				return event as unknown as Event;
			},
			announce: (next) => {
				announced.push(next);
			},
			charter: () => charter,
			now: () => "2026-02-02T00:00:00.000Z",
		},
	};
}

const RESERVED = `# Charter

## Reserved for the user

- database migrations
- anything that spends money
`;

test("a charter reserving the mutation kind denies and leaves the leader in lead", async () => {
	const w = world(RESERVED);
	const approval = await grantMode(w.ports, {
		subject: { kind: "leader", workspaceId: WORKSPACE },
		mode: "leadPlus",
		record: record(),
	});
	expect(approval.approved).toBe(false);
	if (approval.approved) {
		throw new Error("expected a denial");
	}
	expect(approval.reason).toBe("reservedByCharter");
	expect(approval.detail).toContain("database migrations");
	expect(w.leaders).toHaveLength(1);
	expect(w.leaders[0]?.mode).toBe("lead");
	expect(w.events).toHaveLength(0);
	expect(w.announced).toHaveLength(0);
});

test("a charter reserving the external effects denies too", async () => {
	const w = world(RESERVED);
	const approval = await grantMode(w.ports, {
		subject: { kind: "leader", workspaceId: WORKSPACE },
		mode: "leadPlus",
		record: { ...record(), mutationKind: "source edits", externalEffects: "anything that spends money" },
	});
	expect(approval.approved).toBe(false);
	expect(w.leaders[0]?.mode).toBe("lead");
});

test("with nothing reserved the leader's own request is granted and announced", async () => {
	const w = world("# Charter\n\nProse only.\n");
	const approval = await grantMode(w.ports, {
		subject: { kind: "leader", workspaceId: WORKSPACE },
		mode: "leadPlus",
		record: record(),
	});
	expect(approval.approved).toBe(true);
	expect(w.leaders[w.leaders.length - 1]?.mode).toBe("leadPlus");
	expect(w.announced[0]?.mode).toBe("leadPlus");
	// 07: the record is written flat onto the event, never nested.
	expect(w.events[0]?.kind).toBe("leader.modeChanged");
	expect(w.events[0]?.data.mutationKind).toBe("database migrations");
	expect(w.events[0]?.data.to).toBe("leadPlus");
	expect(w.events[0]?.data.record).toBeUndefined();
});

test("a mission lead's request never touches the workspace leader", async () => {
	const w = world("");
	const approval = await grantMode(w.ports, {
		subject: { kind: "lead", workspaceId: WORKSPACE, missionId: "m1", agentId: "a1" },
		mode: "leadPlus",
		record: record(),
	});
	expect(approval.approved).toBe(false);
	if (approval.approved) {
		throw new Error("expected a refusal");
	}
	// 07 keeps a lead's mode on its own record; there is nowhere to put it
	// yet, and the workspace leader is a different actor.
	expect(approval.reason).toBe("unavailable");
	expect(w.leaders).toHaveLength(1);
	expect(w.leaders[0]?.mode).toBe("lead");
	expect(w.announced).toHaveLength(0);
	expect(w.events).toHaveLength(0);
});

test("a request with no record is incomplete, not granted", async () => {
	const w = world("");
	const approval = await grantMode(w.ports, {
		subject: { kind: "leader", workspaceId: WORKSPACE },
		mode: "leadPlus",
	});
	expect(approval.approved).toBe(false);
	expect(w.leaders[0]?.mode).toBe("lead");
});

test("a return to lead needs no record and is not a change when already there", async () => {
	const w = world(RESERVED);
	const approval = await grantMode(w.ports, { subject: { kind: "leader", workspaceId: WORKSPACE }, mode: "lead" });
	expect(approval.approved).toBe(true);
	// Already in lead: nothing to write, and 07 emits one event per change.
	expect(w.leaders).toHaveLength(1);
	expect(w.events).toHaveLength(0);
	expect(w.announced).toHaveLength(0);
});

// The leader's only route out of Lead++. Reporting success without writing
// would leave the workspace in build access until a person flipped it in the
// UI, because Lead++ outlives a restart.
test("a return after a grant leaves the leader in lead", async () => {
	const w = world("# Charter\n\nProse only.\n");
	expect(
		(
			await grantMode(w.ports, {
				subject: { kind: "leader", workspaceId: WORKSPACE },
				mode: "leadPlus",
				record: record(),
			})
		).approved,
	).toBe(true);
	expect(w.leaders[w.leaders.length - 1]?.mode).toBe("leadPlus");

	const back = await grantMode(w.ports, { subject: { kind: "leader", workspaceId: WORKSPACE }, mode: "lead" });
	expect(back.approved).toBe(true);
	const now = w.leaders[w.leaders.length - 1];
	expect(now?.mode).toBe("lead");
	expect(now?.modeSince).toBe("2026-02-02T00:00:00.000Z");
	// One event and one broadcast for the return, the way `leader.setMode` does.
	expect(w.events).toHaveLength(2);
	expect(w.events[1]?.kind).toBe("leader.modeChanged");
	expect(w.events[1]?.data.from).toBe("leadPlus");
	expect(w.events[1]?.data.to).toBe("lead");
	expect(w.announced).toHaveLength(2);
	expect(w.announced[1]?.mode).toBe("lead");
});

test("a mission lead's return is refused too, not silently approved", async () => {
	const w = world("");
	const approval = await grantMode(w.ports, {
		subject: { kind: "lead", workspaceId: WORKSPACE, missionId: "m1", agentId: "a1" },
		mode: "lead",
	});
	expect(approval.approved).toBe(false);
	if (approval.approved) {
		throw new Error("expected a refusal");
	}
	expect(approval.reason).toBe("unavailable");
	expect(w.leaders).toHaveLength(1);
});
