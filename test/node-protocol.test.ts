import { describe, expect, test } from "bun:test";
import { ulid } from "../src/core/ids.ts";
import { decodeFrame, encodeFrame, FramingError, isEnvelope, isNotice, isReply } from "../src/node/protocol.ts";

describe("protocol framing", () => {
	test("an envelope round-trips", () => {
		const id = ulid();
		const frame = decodeFrame(encodeFrame({ v: 1, id, method: "neta_ping", params: { a: 1 } }));
		expect(isEnvelope(frame)).toBe(true);
		expect(frame).toEqual({ v: 1, id, method: "neta_ping", params: { a: 1 } });
	});

	test("replies and notices narrow", () => {
		const id = ulid();
		const ok = decodeFrame(encodeFrame({ v: 1, id, ok: true, result: [1] }));
		expect(isReply(ok)).toBe(true);
		expect(isEnvelope(ok)).toBe(false);
		const err = decodeFrame(encodeFrame({ v: 1, id, ok: false, error: { code: "NO", message: "no" } }));
		expect(isReply(err)).toBe(true);
		const notice = decodeFrame(encodeFrame({ v: 1, method: "changed", params: null }));
		expect(isNotice(notice)).toBe(true);
		expect(isReply(notice)).toBe(false);
	});

	test("old versions, missing ids and non-ULID ids throw FramingError", () => {
		expect(() => decodeFrame('{"v":0,"id":"x","method":"m"}')).toThrow(FramingError);
		// No id means a notice, which only needs a method.
		expect(isNotice(decodeFrame('{"v":1,"method":"m"}'))).toBe(true);
		expect(() => decodeFrame('{"v":1,"id":"not-a-ulid","method":"m"}')).toThrow(FramingError);
		expect(() => decodeFrame('{"v":1,"id":"not-a-ulid","ok":true,"result":1}')).toThrow(FramingError);
		expect(() => decodeFrame("{oops")).toThrow(FramingError);
		expect(() => decodeFrame('{"v":1,"id":"x","ok":false,"error":{"code":1}}')).toThrow(FramingError);
	});

	test("unknown method names pass decode and fail dispatch later", () => {
		const frame = decodeFrame(encodeFrame({ v: 1, id: ulid(), method: "neta_frobnicator" }));
		expect(isEnvelope(frame)).toBe(true);
	});
});
