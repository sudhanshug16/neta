import { spawn as spawnPty } from "node-pty";
import readline from "node:readline";
let pty; let seq = 0; let replay = []; let bytes = 0; let truncated = false; let generation;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	try {
		if (message.method === "start") {
			generation = message.generation; seq = 0; replay = []; bytes = 0; truncated = false;
			pty = spawnPty(message.command, message.args, { cwd: message.cwd, cols: message.cols, rows: message.rows, name: "xterm-256color", env: message.env });
			pty.onData((data) => { const chunk = { generation, seq: ++seq, dataBase64: Buffer.from(data).toString("base64") }; replay.push(chunk); bytes += Buffer.byteLength(data); while (bytes > 1024 * 1024 && replay.length > 1) { const old = replay.shift(); bytes -= Buffer.from(old.dataBase64, "base64").byteLength; truncated = true; } send({ event: "output", chunk }); });
			pty.onExit(({ exitCode, signal }) => send({ event: "state", generation, phase: "exited", exitCode, signal }));
			send({ id: message.id, result: { pid: pty.pid, generation, replay, replayTruncated: truncated } });
		} else if (message.method === "input") { pty.write(Buffer.from(message.dataBase64, "base64").toString()); send({ id: message.id, result: {} }); }
		else if (message.method === "resize") { pty.resize(message.cols, message.rows); send({ id: message.id, result: {} }); }
		else if (message.method === "snapshot") send({ id: message.id, result: { pid: pty.pid, generation, replay, replayTruncated: truncated } });
		else if (message.method === "close") { pty?.kill(); process.exit(0); }
	} catch (error) { send({ id: message.id, error: String(error) }); }
});
