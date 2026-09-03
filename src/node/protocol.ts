import { isUlid } from "../core/ids.ts";

export const PROTOCOL_VERSION = 1;

export interface Envelope {
	v: 1;
	id: string;
	method: string;
	params?: unknown;
}

export interface OkReply {
	v: 1;
	id: string;
	ok: true;
	result: unknown;
}

export interface ErrReply {
	v: 1;
	id: string;
	ok: false;
	error: { code: string; message: string };
}

export interface Notice {
	v: 1;
	method: string;
	params: unknown;
}

export type Frame = Envelope | OkReply | ErrReply | Notice;

export function isEnvelope(f: Frame): f is Envelope {
	return (f as Partial<OkReply>).ok === undefined && (f as Partial<Envelope>).id !== undefined;
}

export function isReply(f: Frame): f is OkReply | ErrReply {
	return (f as Partial<OkReply>).ok !== undefined;
}

export function isNotice(f: Frame): f is Notice {
	return (f as Partial<OkReply>).ok === undefined && (f as Partial<Envelope>).id === undefined;
}

export function encodeFrame(frame: Frame): string {
	return JSON.stringify(frame);
}

export class FramingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FramingError";
	}
}

export const MAX_LINE_BYTES = 64 * 1024 * 1024;

// Validates structure only: version, ULID ids on envelopes and replies, and
// the envelope/reply/notice discriminators. Unknown method names pass here
// and fail at dispatch.
export function decodeFrame(line: string): Frame {
	if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
		throw new FramingError("line exceeds 64 MiB");
	}
	let raw: unknown;
	try {
		raw = JSON.parse(line) as unknown;
	} catch {
		throw new FramingError("malformed JSON");
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new FramingError("a frame is an object");
	}
	const frame = raw as Record<string, unknown>;
	if (frame.v !== PROTOCOL_VERSION) {
		throw new FramingError(`unsupported protocol version: ${String(frame.v)}`);
	}
	if (typeof frame.ok === "boolean") {
		if (typeof frame.id !== "string" || !isUlid(frame.id)) {
			throw new FramingError("a reply needs a ULID id");
		}
		if (frame.ok) {
			return { v: 1, id: frame.id, ok: true, result: frame.result };
		}
		const error = frame.error as { code?: unknown; message?: unknown } | undefined;
		if (typeof error?.code !== "string" || typeof error?.message !== "string") {
			throw new FramingError("an error reply needs { code, message }");
		}
		return { v: 1, id: frame.id, ok: false, error: { code: error.code, message: error.message } };
	}
	if (typeof frame.id === "string") {
		if (!isUlid(frame.id)) {
			throw new FramingError("an envelope needs a ULID id");
		}
		if (typeof frame.method !== "string" || frame.method === "") {
			throw new FramingError("an envelope needs a method");
		}
		return "params" in frame
			? { v: 1, id: frame.id, method: frame.method, params: frame.params }
			: { v: 1, id: frame.id, method: frame.method };
	}
	if (typeof frame.method !== "string" || frame.method === "") {
		throw new FramingError("a notice needs a method");
	}
	return { v: 1, method: frame.method, params: frame.params };
}
