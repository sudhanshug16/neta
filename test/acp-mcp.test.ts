import { describe, expect, test } from "bun:test";
import { NETA_MCP_SERVER_NAME, netaBin, netaMcpServer } from "../src/session/mcp.ts";

describe("neta tool proxy server spec", () => {
	test("NETA_BIN wins over process.execPath", () => {
		expect(netaBin({ NETA_BIN: "/usr/local/bin/neta" })).toEqual({ command: "/usr/local/bin/neta", prefixArgs: [] });
		const fallback = netaBin({});
		expect(fallback.command).toBe(process.execPath);
		expect(fallback.prefixArgs).toEqual([process.argv[1]]);
	});

	// The same `/$bunfs/root/...` argv[1] bug the detached `node start` child
	// had (`test/cli-node.test.ts`): inside the compiled exe that ships in
	// `NetaDesktop.app`, passing `process.argv[1]` on made every ACP session's
	// `neta` MCP server `<exe> /$bunfs/root/neta mcp ...`, and that child
	// exits 1 with `unknown command`, so no actor could reach a Neta tool.
	test("the compiled exe drops the script argument", () => {
		const exe = "/Apps/NetaDesktop.app/Contents/Resources/neta";
		expect(netaBin({}, { execPath: exe, script: "/$bunfs/root/neta" })).toEqual({ command: exe, prefixArgs: [] });
		const spec = netaMcpServer({
			actorId: "actor-1",
			token: "token-1",
			bin: netaBin({}, { execPath: exe, script: "/$bunfs/root/neta" }),
		});
		expect(spec.command).toBe(exe);
		expect(spec.args).toEqual(["mcp", "--actor", "actor-1", "--token", "token-1"]);
		expect(spec.args.join(" ")).not.toContain("bunfs");
	});

	test("a script-hosted run keeps the script argument", () => {
		expect(netaBin({}, { execPath: "/usr/local/bin/node", script: "/repo/dist/main.js" })).toEqual({
			command: "/usr/local/bin/node",
			prefixArgs: ["/repo/dist/main.js"],
		});
	});

	test("no script and no exe falls back to the runtime alone", () => {
		expect(netaBin({}, { execPath: "/usr/local/bin/node" })).toEqual({
			command: "/usr/local/bin/node",
			prefixArgs: [],
		});
	});

	test("NETA_BIN still wins inside the compiled exe", () => {
		expect(
			netaBin(
				{ NETA_BIN: "/usr/local/bin/neta" },
				{ execPath: "/Apps/NetaDesktop.app/Contents/Resources/neta", script: "/$bunfs/root/neta" },
			),
		).toEqual({ command: "/usr/local/bin/neta", prefixArgs: [] });
	});

	test("argv order is exactly as specified", () => {
		const spec = netaMcpServer({
			actorId: "actor-1",
			token: "token-1",
			bin: { command: "neta", prefixArgs: [] },
		});
		expect(spec.name).toBe(NETA_MCP_SERVER_NAME);
		expect(spec.command).toBe("neta");
		expect(spec.args).toEqual(["mcp", "--actor", "actor-1", "--token", "token-1"]);
	});

	test("the socket path lands in env, not args", () => {
		const spec = netaMcpServer({
			actorId: "actor-1",
			token: "token-1",
			socketPath: "/tmp/neta/node.sock",
			bin: { command: "neta", prefixArgs: [] },
		});
		expect(spec.env).toEqual([{ name: "NETA_SOCKET", value: "/tmp/neta/node.sock" }]);
		expect(spec.args.join(" ")).not.toContain("node.sock");
		const bare = netaMcpServer({ actorId: "actor-1", token: "token-1", bin: { command: "neta", prefixArgs: [] } });
		expect(bare.env).toEqual([]);
	});

	test("two actors give two specs", () => {
		const bin = { command: "neta", prefixArgs: [] as string[] };
		const a = netaMcpServer({ actorId: "a", token: "ta", bin });
		const b = netaMcpServer({ actorId: "b", token: "tb", bin });
		expect(a.args).not.toEqual(b.args);
		expect(a.args).toContain("a");
		expect(b.args).toContain("b");
	});
});
