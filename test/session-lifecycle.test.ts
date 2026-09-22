import { expect, test } from "bun:test";
import { SessionLifecycle } from "../src/node/session-lifecycle.ts";

test("mixed callers serialize the same binding and failures release it", async () => {
	const lifecycle = new SessionLifecycle();
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const calls: string[] = [];
	const first = lifecycle.run("session", async () => {
		calls.push("resume");
		await barrier;
		throw new Error("candidate failed");
	});
	const caught = first.catch((error: unknown) => error);
	const second = lifecycle.run("session", async () => {
		calls.push("reset");
		return "fresh";
	});
	const third = lifecycle.run("session", async () => {
		calls.push("attach");
	});
	await lifecycle.run("independent", async () => {
		calls.push("independent");
	});
	expect(calls).toEqual(["resume", "independent"]);
	release();
	expect(await caught).toBeInstanceOf(Error);
	expect(await second).toBe("fresh");
	await third;
	expect(calls).toEqual(["resume", "independent", "reset", "attach"]);
	expect(lifecycle.pendingCount).toBe(0);
});
