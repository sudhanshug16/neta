import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, InboxMessage, Leader, Mission } from "../src/core/types.ts";
import type { ReportPorts } from "../src/node/agent-runtime.ts";
import { ParentDispatcher } from "../src/node/parent-dispatcher.ts";
import { openParentReportStore, type ParentReport, parentReportId } from "../src/store/parent-reports.ts";

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error("dispatcher fixture did not settle");
		await Bun.sleep(5);
	}
}

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "neta-dispatch-"));
	const reports = openParentReportStore(dir);
	let agent: Agent = {
		id: "child",
		sessionId: "child-session",
		missionId: "mission",
		workspaceId: "work",
		name: "Child",
		task: "inspect",
		provider: "fake",
		model: "small",
		skills: [],
		access: "readOnly",
		canSpawn: true,
		state: "interrupted",
		startedAt: "2026-01-01",
	};
	const leader: Leader = {
		workspaceId: "work",
		machineId: "local",
		sessionId: "parent",
		name: "Parent",
		provider: "fake",
		model: "small",
		mode: "lead",
		modeSince: "2026-01-01",
		modeActiveMs: 0,
		state: "idle",
	};
	const mission: Mission = {
		id: "mission",
		number: 1,
		workspaceId: "work",
		machineId: "local",
		name: "Inspect",
		objective: "inspect",
		changes: [],
		lead: { kind: "agent", agentId: "child" },
		agentIds: ["child"],
		access: "readOnly",
		state: "running",
		createdAt: "2026-01-01",
	};
	const receipts = new Map<string, InboxMessage>();
	const accepted: string[] = [];
	const ports: ReportPorts = {
		reports,
		changed: () => {},
		store: {
			listAgents: () => [agent],
			getAgent: () => agent,
			putAgent: async (value) => {
				agent = value;
			},
			getMission: () => mission,
			getLeader: () => leader,
			recentConversation: async () => [],
		},
		send: async (sessionId, text, sourceId) => {
			let receipt = receipts.get(sourceId);
			if (!receipt) {
				receipt = { id: sourceId, sessionId, createdAt: "2026-01-01", text, attachments: [], status: "queued" };
				receipts.set(sourceId, receipt);
				accepted.push(text);
			}
			return receipt;
		},
	};
	const record = (turnId: string): Promise<ParentReport> =>
		reports.record({
			id: parentReportId("child-session", turnId),
			actorId: "child",
			sessionId: "child-session",
			turnId,
			workspaceId: "work",
			missionId: "mission",
			model: "small",
			text: turnId,
			createdAt: `2026-01-01T00:00:0${turnId === "A" ? "0" : "1"}Z`,
			status: "pending",
		});
	return { dir, reports, ports, record, accepted, mission };
}

test("parent result order survives an earlier transient delivery failure and dispatcher restart", async () => {
	const f = await fixture();
	let failed = false;
	const send = f.ports.send;
	f.ports.send = async (...args) => {
		if (args[1] === "A") throw new Error("parent unavailable");
		return send(...args);
	};
	const first = new ParentDispatcher(f.ports, () => {
		failed = true;
	});
	let second: ParentDispatcher | undefined;
	try {
		first.enqueue(await f.record("A"));
		first.enqueue(await f.record("B"));
		await until(() => failed);
		await Bun.sleep(20);
		expect(f.accepted).toEqual([]);
		first.stop();
		f.ports.send = send;
		second = new ParentDispatcher({ ...f.ports, reports: openParentReportStore(f.dir) }, () => {});
		for (const report of await openParentReportStore(f.dir).pending()) second.enqueue(report);
		await until(() => f.accepted.length === 2);
		expect(f.accepted).toEqual(["A", "B"]);
		await until(async () => (await f.reports.pending()).length === 0);
	} finally {
		first.stop();
		second?.stop();
		await rm(f.dir, { recursive: true, force: true });
	}
});

test("crash after durable inbox insertion before outbox acknowledgment reuses receipt on restart", async () => {
	const f = await fixture();
	let failed = false;
	const first = new ParentDispatcher(
		{
			...f.ports,
			reports: {
				...f.reports,
				settle: async () => {
					throw new Error("simulated crash before acknowledgment");
				},
			},
		},
		() => {
			failed = true;
		},
	);
	let second: ParentDispatcher | undefined;
	try {
		first.enqueue(await f.record("A"));
		await until(() => failed);
		first.stop();
		expect(f.accepted).toEqual(["A"]);
		const reopened = openParentReportStore(f.dir);
		expect(await reopened.pending()).toHaveLength(1);
		second = new ParentDispatcher({ ...f.ports, reports: reopened }, () => {});
		for (const report of await reopened.pending()) second.enqueue(report);
		await until(async () => (await reopened.pending()).length === 0);
		expect(f.accepted).toEqual(["A"]);
	} finally {
		first.stop();
		second?.stop();
		await rm(f.dir, { recursive: true, force: true });
	}
});

test("one unavailable parent does not delay another parent's result", async () => {
	const f = await fixture();
	let failed = false;
	const send = f.ports.send;
	const getAgent = f.ports.store.getAgent;
	const child = getAgent("child");
	if (!child) throw new Error("Missing fixture child");
	f.ports.store.getAgent = (id) =>
		id === "other-parent" ? { ...child, id, sessionId: "other-parent-session" } : getAgent(id);
	f.ports.send = async (...args) => {
		if (args[1] === "A") throw new Error("first parent unavailable");
		return send(...args);
	};
	const dispatcher = new ParentDispatcher(f.ports, () => {
		failed = true;
	});
	try {
		dispatcher.enqueue(await f.record("A"));
		await until(() => failed);
		const other = { ...(await f.record("B")), parentActorId: "other-parent" };
		dispatcher.enqueue(other);
		await until(() => f.accepted.length === 1);
		expect(f.accepted).toEqual(["B"]);
		await until(async () => (await f.reports.pending()).length === 1);
	} finally {
		dispatcher.stop();
		await rm(f.dir, { recursive: true, force: true });
	}
});
