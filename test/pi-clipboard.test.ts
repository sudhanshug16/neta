import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const temporary: string[] = [];
const helper = join(import.meta.dir, "../src/rmux/pi-clipboard.ts");

afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function run(source: string, env: Record<string, string | undefined> = {}): Buffer {
	return execFileSync(process.execPath, ["--eval", source], { env: { ...process.env, ...env }, encoding: "buffer" });
}

test("Termux clipboard helper preserves exact text and bypasses OSC 52 on success", () => {
	const dir = mkdtempSync(join(tmpdir(), "neta clipboard "));
	temporary.push(dir);
	const received = join(dir, "received");
	const executable = join(dir, "termux-clipboard-set");
	writeFileSync(executable, `#!/bin/sh
cat > ${JSON.stringify(received)}
`);
	chmodSync(executable, 0o755);
	const text = "copy α\ncopy β\n";
	const output = run(`import(${JSON.stringify(helper)}).then(({copyToClipboard}) => copyToClipboard(${JSON.stringify(text)}))`, {
		TERMUX_VERSION: "0.118",
		PATH: `${dir}:/usr/bin:/bin`,
	});
	expect(output).toEqual(Buffer.alloc(0));
	expect(readFileSync(received, "utf8")).toBe(text);
});

test("failed Termux clipboard falls back to exact OSC 52 UTF-8 payload", () => {
	const dir = mkdtempSync(join(tmpdir(), "neta clipboard "));
	temporary.push(dir);
	const executable = join(dir, "termux-clipboard-set");
	writeFileSync(executable, "#!/bin/sh\nexit 1\n");
	chmodSync(executable, 0o755);
	const text = "copy α\ncopy β";
	const output = run(`import(${JSON.stringify(helper)}).then(({copyToClipboard}) => copyToClipboard(${JSON.stringify(text)}))`, {
		TERMUX_VERSION: "0.118",
		PATH: `${dir}:/usr/bin:/bin`,
	});
	expect(output.toString("utf8")).toBe(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
});

test("OSC 52 rejects payloads over its bounded size", () => {
	const text = "x".repeat(75_001);
	const source = `import(${JSON.stringify(helper)}).then(({copyToClipboard}) => copyToClipboard(${JSON.stringify(text)})).catch((error) => { process.stdout.write(error.message); process.exit(0); })`;
	expect(run(source).toString("utf8")).toBe("Clipboard text is too large for OSC 52");
});
