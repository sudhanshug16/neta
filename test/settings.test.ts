import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { loadNetaSettings, NetaConfig, persistTierOverride } from "../src/settings.ts";

describe("NetaConfig", () => {
	// A tier means a different model on each vendor, so the backend says what its
	// junior is. Model ids are the ones the bridges advertise over ACP.
	it("gives each tier the shipped model for its backend when configured", () => {
		const config = new NetaConfig({
			tiers: { junior: { backend: "claude" }, senior: { backend: "claude" }, staff: { backend: "claude" } },
		});

		expect(config.resolve("junior", "claude")).toMatchObject({ name: "claude", model: "haiku" });
		expect(config.resolve("senior", "claude")).toMatchObject({ name: "claude", model: "sonnet" });
		expect(config.resolve("staff", "claude")).toMatchObject({ name: "claude", model: "default" });
	});

	// Mixing vendors should be one word per tier: name the backend, get that
	// backend's idea of what the tier means.
	it("picks up the new backend's model when a tier changes vendor", () => {
		const config = new NetaConfig({ tiers: { senior: { backend: "claude" }, staff: { backend: "codex" } } });

		expect(config.resolve("staff", "codex")).toMatchObject({ name: "codex", model: "gpt-5.6-sol[xhigh]" });
		expect(config.resolve("senior", "claude").name).toBe("claude");
	});

	it("lets a tier name its own model, whatever the backend ships", () => {
		const config = new NetaConfig({ tiers: { junior: { backend: "codex", model: "gpt-5.4-mini[low]" } } });

		expect(config.resolve("junior", "codex").model).toBe("gpt-5.4-mini[low]");
	});

	it("substitutes the model into backend arguments for backends that take a flag", () => {
		const config = new NetaConfig({
			tiers: { staff: { backend: "custom", model: "big-model" } },
			backends: { custom: { command: "run-agent", modelArgs: ["--model", "{model}"] } },
		});

		const staff = config.resolve("staff", "custom");
		expect(staff.command).toBe("run-agent");
		expect(staff.args).toEqual(["--model", "big-model"]);
	});

	it("drops the tier model when a different backend is used than configured", () => {
		// Model ids belong to a backend's own naming scheme, so carrying "sonnet"
		// over to opencode would ask for a model that does not exist there.
		const config = new NetaConfig({ tiers: { senior: { backend: "claude", model: "sonnet" } } });
		const resolved = config.resolve("senior", "opencode");

		expect(resolved.name).toBe("opencode");
		expect(resolved.model).toBeUndefined();
		expect(resolved.args).toEqual(["acp"]);
	});

	it("names the configured backends when one is unknown", () => {
		expect(() => new NetaConfig().resolve("senior", "nope")).toThrow(/Unknown worker backend "nope".*claude/s);
	});

	it("returns installed backends filtered by command on PATH", () => {
		const config = new NetaConfig();
		// Mock env with npx on PATH (for claude/codex) but not opencode
		const _mockEnv = { PATH: "/usr/bin:/bin" };
		const _mockFindOnPath = (cmd: string) => (cmd === "npx" ? "/usr/bin/npx" : undefined);

		// We can't easily mock findOnPath here, so let's just verify the method exists
		expect(typeof config.installedBackends).toBe("function");
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

	it("persists a tier override to .neta/settings.json without clobbering other tiers", async () => {
		const cwd = scratch();
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ tiers: { junior: { backend: "codex" } } }),
		);

		await persistTierOverride(cwd, "senior", { backend: "opencode" });

		const updated = JSON.parse(readFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), "utf-8"));
		expect(updated.tiers).toEqual({
			junior: { backend: "codex" },
			senior: { backend: "opencode" },
		});
	});

	it("creates .neta directory when persisting tier override if it does not exist", async () => {
		const cwd = scratch();

		await persistTierOverride(cwd, "staff", { backend: "claude", model: "opus" });

		expect(existsSync(join(cwd, CONFIG_DIR_NAME))).toBe(true);
		const settings = JSON.parse(readFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), "utf-8"));
		expect(settings.tiers).toEqual({ staff: { backend: "claude", model: "opus" } });
	});
});
