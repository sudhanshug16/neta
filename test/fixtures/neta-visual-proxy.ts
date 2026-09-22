import { createConnection, createServer, type Socket } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeDescriptor } from "../../src/node/lockfile.ts";
import type { SnapshotResult } from "../../src/node/protocol.ts";

// Visual data only: production Neta client, shell and native OpenCode renderer
// still run normally. No fixture actor sends prompts or starts a provider.
export async function visualProxy(input: {
	directory: string;
	descriptor: NodeDescriptor;
	snapshot: SnapshotResult;
	workspaceId: string;
	path: string;
	sessionId: string;
}) {
	const directory = join(input.directory, "visual");
	await mkdir(directory);
	const socket = join(directory, "node.sock");
	const time = (hour: number, minute: number) =>
		`2026-09-18T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`;
	const missions = [
		{
			id: "visual-5",
			number: 5,
			name: "Provider defaults",
			state: "blocked",
			agentIds: ["visual-iris"],
			createdAt: time(14, 58),
		},
		{
			id: "visual-4",
			number: 4,
			name: "Session export",
			state: "running",
			agentIds: ["visual-ash", "visual-pine"],
			createdAt: time(14, 54),
		},
		{
			id: "visual-3",
			number: 3,
			name: "CM auto-response",
			state: "running",
			agentIds: ["visual-sol", "visual-terra"],
			createdAt: time(14, 50),
		},
		{
			id: "visual-2",
			number: 2,
			name: "Fix provider paths",
			state: "mergedNotClosed",
			agentIds: ["visual-beech"],
			createdAt: time(13, 20),
		},
		{
			id: "visual-1",
			number: 1,
			name: "Clipboard paste",
			state: "closed",
			agentIds: ["visual-hazel"],
			createdAt: time(12, 0),
			closedAt: time(12, 28),
			disposition: "merged",
		},
	].map((mission) => ({
		...mission,
		workspaceId: input.workspaceId,
		machineId: input.snapshot.machine.id,
		lead: { kind: "agent", agentId: mission.agentIds[0] },
	}));
	const agents = [
		["iris", "Iris", "5", "blocked", true],
		["ash", "Ash", "4", "running", true],
		["pine", "Pine", "4", "completed", false],
		["sol", "Sol", "3", "running", true],
		["terra", "Terra", "3", "queued", false],
		["beech", "Beech", "2", "completed", true],
		["hazel", "Hazel", "1", "archived", true],
	].map(([id, name, mission, state, canSpawn]) => ({
		id: `visual-${id}`,
		name,
		missionId: `visual-${mission}`,
		state,
		canSpawn,
		...(state === "archived" ? { endedAt: time(12, 28) } : {}),
		workspaceId: input.workspaceId,
		sessionId: state === "archived" ? "visual-archive" : input.sessionId,
		provider: "opencode",
		model: "test/test-model",
		task: "Visual fixture",
	}));
	const snapshot = {
		...input.snapshot,
		machine: { ...input.snapshot.machine, name: "mac-mini" },
		missions,
		agents: agents.filter((agent) => agent.state !== "archived"),
		leaders: input.snapshot.leaders.map((leader) => ({ ...leader, name: "Mace" })),
	};
	const connections = new Set<Socket>();
	const server = createServer((client) => {
		const upstream = createConnection(input.descriptor.socket);
		connections.add(client);
		connections.add(upstream);
		const pending = new Map<string, { method: string; params?: Record<string, unknown> }>();
		let incoming = "",
			outgoing = "";
		client.on("data", (data) => {
			incoming += data.toString();
			for (;;) {
				const index = incoming.indexOf("\n");
				if (index < 0) break;
				const line = incoming.slice(0, index);
				incoming = incoming.slice(index + 1);
				const request = JSON.parse(line);
				pending.set(String(request.id), request);
				upstream.write(line + "\n");
			}
		});
		upstream.on("data", (data) => {
			outgoing += data.toString();
			for (;;) {
				const index = outgoing.indexOf("\n");
				if (index < 0) break;
				const response = JSON.parse(outgoing.slice(0, index));
				outgoing = outgoing.slice(index + 1);
				const request = pending.get(String(response.id));
				pending.delete(String(response.id));
				if (request?.method === "snapshot") {
					response.result = snapshot;
					delete response.error;
				}
				if (request?.method === "missions.list") {
					response.result = { missions: missions.filter((mission) => mission.state === "closed") };
					delete response.error;
				}
				if (request?.method === "missions.get") {
					response.result = {
						mission: missions.find((mission) => mission.id === request.params?.missionId),
						agents: agents.filter((agent) => agent.missionId === request.params?.missionId),
					};
					delete response.error;
				}
				if (request?.method === "conversation.tail" && request.params?.sessionId === "visual-archive") {
					response.result = {
						blocks: [
							{
								seq: 1,
								role: "user",
								kind: "text",
								text: "Fix clipboard paste and verify a single image attachment.",
							},
							{
								seq: 2,
								role: "agent",
								kind: "text",
								text: "The pasted image is attached once. The prompt stays editable.\nI verified text input, Backspace and image paste together.",
							},
							{ seq: 3, role: "tool", kind: "tool", text: "Run clipboard tests — completed" },
							{
								seq: 4,
								role: "agent",
								kind: "text",
								text: "Completed: clipboard input works. The verification logs are saved.",
							},
						],
						prevCursor: null,
					};
					delete response.error;
				}
				client.write(JSON.stringify(response) + "\n");
			}
		});
		client.on("error", () => upstream.destroy());
		upstream.on("error", () => client.destroy());
		client.on("close", () => {
			connections.delete(client);
			upstream.destroy();
		});
		upstream.on("close", () => connections.delete(upstream));
	});
	await new Promise<void>((resolve) => server.listen(socket, resolve));
	await writeFile(join(directory, "node.json"), JSON.stringify({ ...input.descriptor, socket }), { mode: 0o600 });
	await writeFile(
		join(directory, "opencode-view.json"),
		JSON.stringify({
			host: "local",
			workspaceId: input.workspaceId,
			path: input.path,
			owner: "visual-sol",
			tabs: ["leader", "visual-sol", "visual-terra"],
		}),
	);
	return {
		directory,
		close: () => {
			for (const socket of connections) socket.destroy();
			server.close();
		},
	};
}
