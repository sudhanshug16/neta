import { describe, expect, test } from "bun:test";
import { NETA_MCP_SERVER_NAME, netaBin, netaMcpServer } from "../src/acp/mcp.ts";

describe("neta tool proxy server spec", () => {
	test("NETA_BIN wins over process.execPath", () => {
		expect(netaBin({ NETA_BIN: "/usr/local/bin/neta" })).toEqual({ command: "/usr/local/bin/neta", prefixArgs: [] });
		const fallback = netaBin({});
		expect(fallback.command).toBe(process.execPath);
		expect(fallback.prefixArgs).toEqual([process.argv[1]]);
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
