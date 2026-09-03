import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { main, parse, readVersion } from "../src/cli/main.ts";

function commandOf(argv: string[]): Exclude<ReturnType<typeof parse>, { usage: string }> {
	const parsed = parse(argv);
	if ("usage" in parsed) throw new Error(`expected a command for [${argv.join(" ")}], got usage: ${parsed.usage}`);
	return parsed;
}

function usageOf(argv: string[]): string {
	const parsed = parse(argv);
	if (!("usage" in parsed)) throw new Error(`expected usage for [${argv.join(" ")}], got a command`);
	return parsed.usage;
}

describe("cli command table", () => {
	test("bare neta attaches", () => {
		expect(commandOf([])).toEqual({ name: "attach", args: [], flags: {} });
	});

	test("node lifecycle", () => {
		expect(commandOf(["node", "start"])).toEqual({ name: "node", sub: "start", args: [], flags: {} });
		expect(commandOf(["node", "start", "--detach"])).toEqual({
			name: "node",
			sub: "start",
			args: [],
			flags: { detach: true },
		});
		expect(commandOf(["node", "stop"])).toEqual({ name: "node", sub: "stop", args: [], flags: {} });
		expect(commandOf(["node", "status"])).toEqual({ name: "node", sub: "status", args: [], flags: {} });
		expect(commandOf(["node", "status", "--json"])).toEqual({
			name: "node",
			sub: "status",
			args: [],
			flags: { json: true },
		});
	});

	test("open with and without a path", () => {
		expect(commandOf(["open"])).toEqual({ name: "open", args: [], flags: {} });
		expect(commandOf(["open", "/tmp/work"])).toEqual({ name: "open", args: ["/tmp/work"], flags: {} });
	});

	test("missions filters", () => {
		expect(commandOf(["missions"])).toEqual({ name: "missions", args: [], flags: {} });
		expect(commandOf(["missions", "--all"])).toEqual({ name: "missions", args: [], flags: { all: true } });
		expect(commandOf(["missions", "--since", "3d"])).toEqual({
			name: "missions",
			args: [],
			flags: { since: "3d" },
		});
		expect(commandOf(["missions", "--since=90m", "--json"])).toEqual({
			name: "missions",
			args: [],
			flags: { since: "90m", json: true },
		});
	});

	test("mission detail", () => {
		expect(commandOf(["mission", "7"])).toEqual({ name: "mission", args: ["7"], flags: {} });
		expect(commandOf(["mission", "7", "--json"])).toEqual({
			name: "mission",
			args: ["7"],
			flags: { json: true },
		});
	});

	test("events window and follow", () => {
		expect(commandOf(["events"])).toEqual({ name: "events", args: [], flags: {} });
		expect(commandOf(["events", "--follow"])).toEqual({ name: "events", args: [], flags: { follow: true } });
		expect(commandOf(["events", "--since", "3d"])).toEqual({
			name: "events",
			args: [],
			flags: { since: "3d" },
		});
		expect(commandOf(["events", "--follow", "--json"])).toEqual({
			name: "events",
			args: [],
			flags: { follow: true, json: true },
		});
	});

	test("mode read and set", () => {
		expect(commandOf(["mode"])).toEqual({ name: "mode", args: [], flags: {} });
		expect(commandOf(["mode", "lead"])).toEqual({ name: "mode", args: ["lead"], flags: {} });
		expect(commandOf(["mode", "lead++"])).toEqual({ name: "mode", args: ["lead++"], flags: {} });
		expect(commandOf(["mode", "--mission", "3"])).toEqual({ name: "mode", args: [], flags: { mission: "3" } });
		expect(commandOf(["mode", "lead", "--mission", "3"])).toEqual({
			name: "mode",
			args: ["lead"],
			flags: { mission: "3" },
		});
	});

	test("models and model", () => {
		expect(commandOf(["models"])).toEqual({ name: "models", args: [], flags: {} });
		expect(commandOf(["models", "--json"])).toEqual({ name: "models", args: [], flags: { json: true } });
		expect(commandOf(["model", "claude/sonnet"])).toEqual({
			name: "model",
			args: ["claude/sonnet"],
			flags: {},
		});
	});

	test("mcp requires both flags in any order", () => {
		expect(commandOf(["mcp", "--actor", "a", "--token", "t"])).toEqual({
			name: "mcp",
			args: [],
			flags: { actor: "a", token: "t" },
		});
		expect(commandOf(["mcp", "--token=t", "--actor=a"])).toEqual({
			name: "mcp",
			args: [],
			flags: { actor: "a", token: "t" },
		});
	});

	test("version", () => {
		expect(commandOf(["version"])).toEqual({ name: "version", args: [], flags: {} });
	});
});

describe("cli durations", () => {
	test("--since 3d is accepted wherever listed", () => {
		expect(commandOf(["missions", "--since", "3d"]).flags).toEqual({ since: "3d" });
		expect(commandOf(["events", "--since", "3d"]).flags).toEqual({ since: "3d" });
		expect(commandOf(["events", "--since", "90m"]).flags).toEqual({ since: "90m" });
	});

	test("--since 3x is rejected", () => {
		expect(usageOf(["missions", "--since", "3x"])).toContain("--since");
		expect(usageOf(["events", "--since", "3x"])).toContain("--since");
		expect(usageOf(["events", "--since", "10s"])).toContain("--since");
		expect(usageOf(["missions", "--since", "d"])).toContain("--since");
	});
});

describe("cli usage errors", () => {
	test("unknown command returns usage", () => {
		expect(usageOf(["frobnicate"])).toContain("unknown command");
		expect(usageOf(["attach"])).toContain("unknown command");
	});

	test("stray and misplaced flags return usage", () => {
		expect(usageOf(["missions", "--bogus"])).toContain("unknown flag");
		expect(usageOf(["version", "--json"])).toContain("takes no arguments");
		expect(usageOf(["model", "x", "--json"])).toContain("unknown flag");
		expect(usageOf(["open", "--json"])).toContain("unknown flag");
		expect(usageOf(["mode", "--json"])).toContain("unknown flag");
		expect(usageOf(["node", "start", "--json"])).toContain("unknown flag");
		expect(usageOf(["node", "stop", "--detach"])).toContain("takes no arguments");
		expect(usageOf(["mcp", "--actor", "a", "--token", "t", "--json"])).toContain("unknown flag");
	});

	test("missing and bad arguments return usage", () => {
		expect(usageOf(["node"])).toContain("start, stop or status");
		expect(usageOf(["node", "restart"])).toContain("unknown node command");
		expect(usageOf(["mission"])).toContain("needs a number");
		expect(usageOf(["mission", "abc"])).toContain("bad mission number");
		expect(usageOf(["mission", "1", "2"])).toContain("bad mission number");
		expect(usageOf(["mode", "turbo"])).toContain("bad mode");
		expect(usageOf(["model"])).toContain("needs an id");
		expect(usageOf(["mcp", "--actor", "a"])).toContain("--token");
		expect(usageOf(["mcp", "--token", "t"])).toContain("--actor");
		expect(usageOf(["open", "a", "b"])).toContain("at most one path");
		expect(usageOf(["missions", "--all", "--since", "3d"])).toContain("not both");
		expect(usageOf(["version", "extra"])).toContain("takes no arguments");
	});
});

describe("cli version", () => {
	test("readVersion equals package.json", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			version: string;
		};
		expect(readVersion()).toBe(pkg.version);
	});

	test("main version returns 0 and prints only the version", async () => {
		const writes: string[] = [];
		const original = process.stdout.write;
		process.stdout.write = ((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			await expect(main(["version"])).resolves.toBe(0);
		} finally {
			process.stdout.write = original;
		}
		expect(writes.join("")).toBe(`${readVersion()}\n`);
	});

	test("main usage returns 1 and names the problem on stderr", async () => {
		const writes: string[] = [];
		const original = process.stderr.write;
		process.stderr.write = ((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		let code: number;
		try {
			code = await main(["frobnicate"]);
		} finally {
			process.stderr.write = original;
		}
		expect(code).toBe(1);
		expect(writes.join("")).toContain("neta: unknown command");
	});
});
