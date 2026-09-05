import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConversationInboxStore } from "../src/store/conversation-inbox.ts";
import { paths } from "../src/store/paths.ts";

let dir = "";
afterEach(async () => {
	if (dir !== "") await rm(dir, { recursive: true, force: true });
	delete process.env.NETA_DIR;
});

describe("conversation inbox", () => {
	test("persists privately, scrubs delivered payloads, and isolates sessions", async () => {
		dir = await mkdtemp(join(tmpdir(), "neta-inbox-"));
		process.env.NETA_DIR = dir;
		const store = openConversationInboxStore();
		const attachment = {
			id: "a",
			kind: "image" as const,
			name: "a.png",
			mimeType: "image/png",
			dataBase64: "c2VjcmV0",
		};
		const one = await store.enqueue("s1", "one", [attachment]);
		await store.enqueue("s2", "two", []);
		expect((await store.list("s1")).map((item) => item.text)).toEqual(["one"]);
		expect((await store.list("s2")).map((item) => item.text)).toEqual(["two"]);
		await store.markDelivering("s1", one.id);
		await store.markDelivered("s1", one.id, "turn");
		expect((await store.list("s1"))[0]?.attachments[0]?.dataBase64).toBe("");
		expect((await stat(paths().conversationInbox("s1"))).mode & 0o777).toBe(0o600);
	});

	test("never compacts nonterminal messages and counts uncertain payload bytes", async () => {
		dir = await mkdtemp(join(tmpdir(), "neta-inbox-"));
		process.env.NETA_DIR = dir;
		const store = openConversationInboxStore();
		for (let index = 0; index < 20; index++) await store.enqueue("s", String(index), []);
		await expect(store.enqueue("s", "overflow", [])).rejects.toThrow("20 messages");
		expect((await store.list("s")).filter((item) => item.status === "queued")).toHaveLength(20);
	});

	test("restart-visible delivering entries become uncertain without retry data loss", async () => {
		dir = await mkdtemp(join(tmpdir(), "neta-inbox-"));
		process.env.NETA_DIR = dir;
		const first = openConversationInboxStore();
		const item = await first.enqueue("s", "maybe", []);
		await first.markDelivering("s", item.id);
		const reopened = openConversationInboxStore();
		expect((await reopened.list("s"))[0]?.status).toBe("delivering");
		await reopened.markUncertain("s", item.id);
		expect((await reopened.list("s"))[0]?.status).toBe("uncertain");
	});
});
