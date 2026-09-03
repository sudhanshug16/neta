import { describe, expect, test } from "bun:test";
import * as core from "../src/core/index.ts";
import type {
	Agent,
	Block,
	DecisionRecord,
	Event,
	Leader,
	Machine,
	Mission,
	Turn,
	Workspace,
} from "../src/core/types.ts";

const workspace: Workspace = {
	id: "git:github.com/org/repo",
	kind: "git",
	name: "repo",
	remote: "github.com/org/repo",
	roots: [{ machineId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", path: "/tmp/repo" }],
	createdAt: "2026-09-03T17:00:00.000Z",
};

const machine: Machine = {
	id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	name: "mac",
	createdAt: "2026-09-03T17:00:00.000Z",
};

const leader: Leader = {
	workspaceId: workspace.id,
	machineId: machine.id,
	sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	provider: "claude",
	model: "sonnet",
	mode: "lead",
	modeSince: "2026-09-03T17:00:00.000Z",
	modeActiveMs: 0,
	state: "idle",
};

const mission: Mission = {
	id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	number: 1,
	workspaceId: workspace.id,
	machineId: machine.id,
	name: "fix the flaky specs",
	objective: "Make the suite green.",
	changes: [],
	lead: { kind: "leader" },
	agentIds: [],
	access: "readWrite",
	state: "running",
	createdAt: "2026-09-03T17:00:00.000Z",
};

const agent: Agent = {
	id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	missionId: mission.id,
	workspaceId: workspace.id,
	name: "Ember",
	task: "Reproduce the flake.",
	access: "readOnly",
	provider: "claude",
	model: "sonnet",
	skills: [],
	sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	canSpawn: false,
	state: "running",
	startedAt: "2026-09-03T17:00:00.000Z",
};

const record: DecisionRecord = {
	objective: "Write the migration.",
	whyLeadInsufficient: "Files must change.",
	missionId: mission.id,
	mutationKind: "edit",
	estimatedFiles: 3,
	validation: "bun test",
	estimatedMinutes: 20,
	externalEffects: "none",
};

const event: Event = {
	seq: 1,
	at: "2026-09-03T17:00:00.000Z",
	workspaceId: workspace.id,
	kind: "mission.created",
	missionId: mission.id,
	data: { number: 1 },
};

const turn: Turn = {
	id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	sessionId: leader.sessionId,
	startedAt: "2026-09-03T17:00:00.000Z",
	role: "user",
};

const block: Block = {
	turnId: turn.id,
	seq: 1,
	at: "2026-09-03T17:00:00.000Z",
	role: "agent",
	kind: "text",
	text: "hello",
};

describe("core types", () => {
	test("literals of each interface type-check and the module imports", () => {
		expect(workspace.roots).toHaveLength(1);
		expect(machine.name).toBe("mac");
		expect(leader.mode).toBe("lead");
		expect(mission.number).toBe(1);
		expect(agent.canSpawn).toBe(false);
		expect(record.estimatedFiles).toBe(3);
		expect(event.seq).toBe(1);
		expect(turn.role).toBe("user");
		expect(block.kind).toBe("text");
		expect(typeof core.ulid).toBe("function");
	});
});
