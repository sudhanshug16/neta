import { describe, expect, test } from "bun:test";
import { decodeLines, encodeLine, NODE_ERRORS, NodeError, rpcError } from "../src/node/protocol.ts";

describe("ndjson framing", () => {
	test("a message round-trips", () => {
		const message = { jsonrpc: "2.0", id: "1", method: "hello", params: { a: 1 } };
		const { messages, rest } = decodeLines(encodeLine(message));
		expect(messages).toEqual([message]);
		expect(rest).toBe("");
	});

	test("a 3-message buffer split at every byte offset yields those 3 messages", () => {
		const sent = [
			{ jsonrpc: "2.0", id: 1, method: "snapshot", params: {} },
			{ jsonrpc: "2.0", id: 2, method: "node.stop", params: {} },
			{ jsonrpc: "2.0", method: "event", params: { event: { seq: 1 } } },
		];
		const buffer = sent.map((message) => encodeLine(message)).join("");
		for (let split = 0; split < buffer.length; split++) {
			const first = decodeLines(buffer.slice(0, split));
			const second = decodeLines(first.rest + buffer.slice(split));
			expect([...first.messages, ...second.messages]).toEqual(sent);
			expect(second.rest).toBe("");
		}
	});

	test("a partial line is kept in rest", () => {
		const line = encodeLine({ jsonrpc: "2.0", id: 1, result: {} });
		const cut = line.length - 3;
		const { messages, rest } = decodeLines(line.slice(0, cut));
		expect(messages).toEqual([]);
		expect(rest).toBe(line.slice(0, cut));
		const whole = decodeLines(rest + line.slice(cut));
		expect(whole.messages).toHaveLength(1);
		expect(whole.rest).toBe("");
	});

	test("bad JSON throws PARSE", () => {
		let thrown: unknown;
		try {
			decodeLines('{"jsonrpc": "2.0",\n');
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(NodeError);
		expect((thrown as NodeError).symbol).toBe("PARSE");
		expect((thrown as NodeError).code).toBe(NODE_ERRORS.PARSE);
	});

	test("PARSE carries the buffer past the bad line for resync", () => {
		const good = encodeLine({ jsonrpc: "2.0", id: 1, result: {} });
		let thrown: unknown;
		try {
			decodeLines(`{bad\n${good}`);
		} catch (error) {
			thrown = error;
		}
		const data = (thrown as NodeError).data as { rest: string };
		expect(data.rest).toBe(good);
		expect(decodeLines(data.rest).messages).toHaveLength(1);
	});

	test("an oversize line is rejected", () => {
		const big = `{"jsonrpc":"2.0","id":1,"method":"m","params":"${"x".repeat(8 * 1024 * 1024)}"}\n`;
		let thrown: unknown;
		try {
			decodeLines(big);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(NodeError);
		expect((thrown as NodeError).symbol).toBe("LINE_TOO_LARGE");
	});
});

describe("rpcError", () => {
	test("a NodeError keeps its code and carries the symbol in data", () => {
		const line = rpcError("abc", new NodeError("NOT_FOUND", "no such mission"));
		const reply = JSON.parse(line) as {
			jsonrpc: string;
			id: string;
			error: { code: number; message: string; data: { code: string } };
		};
		expect(reply).toEqual({
			jsonrpc: "2.0",
			id: "abc",
			error: { code: -32002, message: "no such mission", data: { code: "NOT_FOUND" } },
		});
	});

	test("anything else is INTERNAL with no stack", () => {
		const line = rpcError(null, new Error("boom"));
		const reply = JSON.parse(line) as {
			jsonrpc: string;
			id: null;
			error: { code: number; message: string; data: { code: string } };
		};
		expect(reply.error.code).toBe(-32603);
		expect(reply.error.data).toEqual({ code: "INTERNAL" });
		expect(line.includes("at ")).toBe(false);
	});
});
