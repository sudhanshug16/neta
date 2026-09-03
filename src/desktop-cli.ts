#!/usr/bin/env node

import { handleWorkerChannelCommand } from "./channel/client.ts";
import { runDesktopBridge } from "./desktop/bridge.ts";
import { runControlPlane, runWorkerBridge } from "./mcp/run.ts";

async function main(args: string[]): Promise<void> {
	if (await handleWorkerChannelCommand(args)) return;
	switch (args[0]) {
		case "desktop-bridge":
			await runDesktopBridge();
			return;
		case "mcp":
			if (args.includes("--worker")) await runWorkerBridge();
			else await runControlPlane();
			return;
		default:
			process.stderr.write("This executable is the private Neta Desktop bridge.\n");
			process.exitCode = 1;
	}
}

void main(process.argv.slice(2));
