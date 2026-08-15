import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { loadNetaSettings, NetaConfig } from "../src/settings.ts";

describe("NetaConfig", () => {
	it("resolves shipped defaults when settings are empty", () => {
		const config = new NetaConfig();

		expect(config.resolve("junior").name).toBe("claude");
		expect(config.resolve("senior").model).toBe("sonnet");
		expect(config.resolve("staff").model).toBe("opus");
	});

	it("lets settings remap a tier without touching the others", () => {
		const config = new NetaConfig({ tiers: { junior: { backend: "opencode", model: "zai/glm-4.6" } } });

		const junior = config.resolve("junior");
		expect(junior.name).toBe("opencode");
		expect(junior.args).toEqual(["acp", "--model", "zai/glm-4.6"]);
		expect(config.resolve("senior").name).toBe("claude");
	});

	it("substitutes the model into backend arguments and environment", () => {
		const config = new NetaConfig({
			tiers: { staff: { backend: "custom", model: "big-model" } },
			backends: { custom: { command: "run-agent", modelArgs: ["--model", "{model}"] } },
		});

		const staff = config.resolve("staff");
		expect(staff.command).toBe("run-agent");
		expect(staff.args).toEqual(["--model", "big-model"]);

		const withEnv = new NetaConfig({ tiers: { staff: { backend: "claude", model: "opus" } } }).resolve("staff");
		expect(withEnv.env.ANTHROPIC_MODEL).toBe("opus");
	});

	it("drops the tier model when an explicit backend overrides the mapping", () => {
		// Model ids belong to a backend's own naming scheme, so carrying "sonnet"
		// over to opencode would ask for a model that does not exist there.
		const resolved = new NetaConfig().resolve("senior", "opencode");

		expect(resolved.name).toBe("opencode");
		expect(resolved.model).toBeUndefined();
		expect(resolved.args).toEqual(["acp"]);
	});

	it("names the configured backends when one is unknown", () => {
		expect(() => new NetaConfig().resolve("senior", "nope")).toThrow(/Unknown worker backend "nope".*claude/s);
	});

	it("launches a backend without a tier, and therefore without a model", () => {
		const launcher = new NetaConfig().launcher("codex");

		expect(launcher.args).toEqual(["-y", "@agentclientprotocol/codex-acp"]);
		expect(launcher.model).toBeUndefined();
	});
});

describe("loadNetaSettings", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function scratch(): string {
		const dir = mkdtempSync(join(tmpdir(), "neta-settings-"));
		dirs.push(dir);
		return dir;
	}

	it("returns empty settings when no file exists", () => {
		expect(loadNetaSettings(scratch(), scratch())).toEqual({ leader: {}, mux: {}, tiers: {}, backends: {} });
	});

	it("lets a project override one tier from the user's settings", () => {
		const agentDir = scratch();
		const cwd = scratch();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ tiers: { junior: { backend: "codex" }, staff: { backend: "codex" } } }),
		);
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ tiers: { junior: { backend: "opencode" } } }),
		);

		const settings = loadNetaSettings(cwd, agentDir);

		expect(settings.tiers).toEqual({ junior: { backend: "opencode" }, staff: { backend: "codex" } });
	});

	// A broken settings file must not stop the leader from starting; the defaults
	// are usable on their own.
	it("ignores a malformed settings file instead of throwing", () => {
		const agentDir = scratch();
		writeFileSync(join(agentDir, "settings.json"), "{ not json");

		expect(loadNetaSettings(scratch(), agentDir)).toEqual({ leader: {}, mux: {}, tiers: {}, backends: {} });
	});
});
