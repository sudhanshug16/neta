// `neta node start|stop|status` and `neta open` (08, T8.3): thin clients of
// the Node over its socket. `status` and `stop` read `node.json` and never
// start anything; `open` connects with `start: true` so the Node starts on
// demand. Text goes to stdout, errors to stderr as `neta: <msg>`.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Workspace } from "../../core/types.ts";
import { startNode } from "../../node/lifecycle.ts";
import { type NodeDescriptor, netaDir, readDescriptor } from "../../node/lockfile.ts";
import { CliError, NodeClient } from "../client.ts";

const START_WAIT_MS = 10000;
const STOP_WAIT_MS = 10000;
const POLL_MS = 100;

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fail(error: unknown): number {
	if (error instanceof CliError) {
		process.stderr.write(`neta: ${error.message}\n`);
		return error.code;
	}
	process.stderr.write(`neta: ${messageOf(error)}\n`);
	return 1;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// ESRCH means dead; EPERM means alive but owned by another user.
		return (error as { code?: unknown }).code !== "ESRCH";
	}
}

function isLive(descriptor: NodeDescriptor | undefined): descriptor is NodeDescriptor {
	return descriptor !== undefined && isAlive(descriptor.pid);
}

// `2h07m` for two hours seven minutes; `7m` under an hour, `9s` under a minute.
function formatUptime(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 1) {
		return `${totalSeconds}s`;
	}
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

async function liveDescriptor(): Promise<NodeDescriptor | undefined> {
	let descriptor: NodeDescriptor | undefined;
	try {
		descriptor = await readDescriptor();
	} catch {
		return undefined;
	}
	return isLive(descriptor) ? descriptor : undefined;
}

async function startForeground(): Promise<number> {
	let node: Awaited<ReturnType<typeof startNode>>;
	try {
		node = await startNode();
	} catch (error) {
		process.stderr.write(`neta: ${messageOf(error)}\n`);
		return 1;
	}
	process.stderr.write(`listening on ${node.descriptor.socket}  pid ${node.descriptor.pid}\n`);
	const shutdown = (): void => {
		void node.stop().catch(() => undefined);
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
	await node.stopped;
	return 0;
}

// Spawn the foreground form above as a detached child, then wait for
// `node.json` to name a live pid (plus a hello, so `started` means
// reachable) and print it.
async function startDetached(): Promise<number> {
	const existing = await liveDescriptor();
	if (existing !== undefined) {
		process.stdout.write(`started  pid ${existing.pid}  ${existing.socket}\n`);
		return 0;
	}
	const script = process.argv[1];
	if (script === undefined || script === "") {
		process.stderr.write("neta: cannot detach without a bundle path\n");
		return 1;
	}
	const child = spawn(process.execPath, [script, "node", "start"], {
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();
	child.on("error", () => undefined);
	const deadline = Date.now() + START_WAIT_MS;
	for (;;) {
		const descriptor = await liveDescriptor();
		if (descriptor !== undefined) {
			let reachable = false;
			try {
				const probe = await NodeClient.connect();
				probe.close();
				reachable = true;
			} catch {
				reachable = false;
			}
			if (reachable) {
				process.stdout.write(`started  pid ${descriptor.pid}  ${descriptor.socket}\n`);
				return 0;
			}
		}
		if (Date.now() >= deadline) {
			process.stderr.write(`neta: timed out waiting for the node to start in ${netaDir()}\n`);
			return 2;
		}
		await sleep(POLL_MS);
	}
}

async function stopNode(): Promise<number> {
	const descriptor = await liveDescriptor();
	if (descriptor === undefined) {
		process.stdout.write("not running\n");
		return 0;
	}
	let client: NodeClient;
	try {
		client = await NodeClient.connect();
	} catch (error) {
		// The pid died under us: that is "not running", not an error.
		if ((await liveDescriptor()) === undefined) {
			process.stdout.write("not running\n");
			return 0;
		}
		return fail(error);
	}
	try {
		await client.request<{ stopping: true }>("node.stop", {});
	} catch (error) {
		client.close();
		if ((await liveDescriptor()) === undefined) {
			process.stdout.write("not running\n");
			return 0;
		}
		return fail(error);
	}
	client.close();
	const deadline = Date.now() + STOP_WAIT_MS;
	for (;;) {
		if (!isAlive(descriptor.pid)) {
			process.stdout.write("stopped\n");
			return 0;
		}
		if (Date.now() >= deadline) {
			process.stderr.write(`neta: timed out waiting for pid ${descriptor.pid} to stop\n`);
			return 1;
		}
		await sleep(POLL_MS);
	}
}

interface StatusJson {
	running: boolean;
	pid: number | null;
	socket: string | null;
	protocol: number | null;
	startedAt: string | null;
}

async function statusNode(json: boolean): Promise<number> {
	let descriptor: NodeDescriptor | undefined;
	try {
		descriptor = await readDescriptor();
	} catch (error) {
		process.stderr.write(`neta: cannot read the node descriptor in ${netaDir()}: ${messageOf(error)}\n`);
		return 1;
	}
	if (!isLive(descriptor)) {
		if (json) {
			const out: StatusJson = { running: false, pid: null, socket: null, protocol: null, startedAt: null };
			process.stdout.write(`${JSON.stringify(out)}\n`);
		} else {
			process.stdout.write("not running\n");
		}
		return 0;
	}
	if (json) {
		const out: StatusJson = {
			running: true,
			pid: descriptor.pid,
			socket: descriptor.socket,
			protocol: descriptor.protocolVersion,
			startedAt: descriptor.startedAt,
		};
		process.stdout.write(`${JSON.stringify(out)}\n`);
		return 0;
	}
	const uptime = formatUptime(Date.now() - Date.parse(descriptor.startedAt));
	process.stdout.write(
		`running  pid ${descriptor.pid}  socket ${descriptor.socket}  protocol ${descriptor.protocolVersion}  uptime ${uptime}\n`,
	);
	return 0;
}

export async function nodeCommand(sub: string, flags: Record<string, string | true>): Promise<number> {
	switch (sub) {
		case "start":
			return flags.detach === true ? startDetached() : startForeground();
		case "stop":
			return stopNode();
		case "status":
			return statusNode(flags.json === true);
		default:
			process.stderr.write(`neta: unknown node command: ${sub}\n`);
			return 1;
	}
}

export async function openCommand(pathArg?: string): Promise<number> {
	const raw = pathArg ?? process.cwd();
	if (raw.startsWith("~")) {
		process.stderr.write(`neta: refusing to open ${raw}: pass an explicit workspace path\n`);
		return 1;
	}
	const resolved = resolve(raw);
	if (resolved === "/") {
		process.stderr.write("neta: refusing to open / (the filesystem root)\n");
		return 1;
	}
	if (resolved === homedir()) {
		process.stderr.write(
			`neta: refusing to open ${resolved} (the home directory): pass an explicit workspace path\n`,
		);
		return 1;
	}
	let client: NodeClient;
	try {
		client = await NodeClient.connect({ start: true });
	} catch (error) {
		return fail(error);
	}
	try {
		const result = await client.request<{ workspace: Workspace }>("workspace.open", { path: resolved });
		const roots = result.workspace.roots;
		const root = (roots.length > 0 ? roots[roots.length - 1]?.path : undefined) ?? resolved;
		process.stdout.write(`${result.workspace.id}  ${result.workspace.name}  ${root}\n`);
		return 0;
	} catch (error) {
		return fail(error);
	} finally {
		client.close();
	}
}
