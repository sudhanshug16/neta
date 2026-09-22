#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import tty from "node:tty";
import { join } from "node:path";

if (tty.isatty(0)) process.stdin.setRawMode(true);
process.stdin.resume();
const size = () => {
	const value = `SIZE:${process.stdout.columns}x${process.stdout.rows}`;
	if (process.env.NETA_FAKE_PI_SIZE_LOG) appendFileSync(process.env.NETA_FAKE_PI_SIZE_LOG, `${value}\n`);
	process.stdout.write(`${value}\r\n`);
};
const sessionId = process.env.NETA_TARGET_SESSION_ID ?? "unknown";
const sessionDir = process.argv[process.argv.indexOf("--session-dir") + 1];
if (process.env.NETA_FAKE_PI_CLIENT_TRANSCRIPT && sessionDir) writeFileSync(join(sessionDir, "fake-client-transcript.jsonl"), process.env.NETA_FAKE_PI_CLIENT_TRANSCRIPT, { mode: 0o600 });
if (process.env.NETA_PI_EDITOR_READY_PATH) writeFileSync(process.env.NETA_PI_EDITOR_READY_PATH, sessionId, { mode: 0o600 });
if (process.env.NETA_FAKE_PI_START_LOG) appendFileSync(process.env.NETA_FAKE_PI_START_LOG, `${sessionId}\n`);
if (process.env.NETA_FAKE_PI_CWD_LOG) appendFileSync(process.env.NETA_FAKE_PI_CWD_LOG, `${sessionId}:${process.cwd()}\n`);
if (process.env.NETA_FAKE_PI_AUDIT_LOG) appendFileSync(process.env.NETA_FAKE_PI_AUDIT_LOG, `start:${process.env.NETA_DESCRIPTOR ?? "missing"}:${sessionId}\n`);
process.stdout.write(`FAKE_PI_READY:${sessionId}\r\n\x1b]0;must-not-escape\x07`);
size();
process.on("SIGWINCH", size);
process.stdin.on("data", (bytes) => {
	if (process.env.NETA_FAKE_PI_INPUT_LOG) appendFileSync(process.env.NETA_FAKE_PI_INPUT_LOG, bytes);
	if (process.env.NETA_FAKE_PI_SESSION_INPUT_LOG) appendFileSync(process.env.NETA_FAKE_PI_SESSION_INPUT_LOG, `${sessionId}:${bytes.toString("hex")}\n`);
	if (process.env.NETA_FAKE_PI_AUDIT_LOG) appendFileSync(process.env.NETA_FAKE_PI_AUDIT_LOG, `input:${process.env.NETA_DESCRIPTOR ?? "missing"}:${sessionId}:${bytes.toString("hex")}\n`);
	const ordinary = [];
	for (const byte of bytes) {
		if (byte === 0x7f) {
			size();
			process.stdout.write("BACKSPACE_OK\x1b]5");
			setTimeout(() => process.stdout.write("2;c;Y2xpcGJvYXJkLW9r\x07"), 10);
		} else {
			ordinary.push(byte);
		}
	}
	if (ordinary.length > 0) process.stdout.write(`PI_INPUT:${sessionId}:${Buffer.from(ordinary).toString("hex")}\r\n`);
});
