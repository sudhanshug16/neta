import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { isForbiddenClaudeModel, loadNetaSettings, NetaConfig, persistTierOverride } from "../src/settings.ts";

describe("NetaConfig", () => {
	// A tier means a different model on each vendor, so the backend says what its
	// tier is. Model ids are the ones the bridges advertise over ACP.
	it("gives every tier the shipped model for both configured backends", () => {
		const config = new NetaConfig();

		expect(config.resolve("apprentice", "claude")).toMatchObject({ name: "claude", model: "haiku" });
		expect(config.resolve("journeyman", "claude")).toMatchObject({ name: "claude", model: "sonnet" });
		expect(config.resolve("expert", "claude")).toMatchObject({ name: "claude", model: "opus[1m]" });
		expect(config.resolve("architect", "claude")).toMatchObject({ name: "claude", model: "opus[1m][max]" });
		expect(config.resolve("apprentice", "codex")).toMatchObject({ name: "codex", model: "gpt-5.6-luna[high]" });
		expect(config.resolve("journeyman", "codex")).toMatchObject({ name: "codex", model: "gpt-5.6-terra[medium]" });
		expect(config.resolve("expert", "codex")).toMatchObject({ name: "codex", model: "gpt-5.6-sol[medium]" });
		expect(config.resolve("architect", "codex")).toMatchObject({ name: "codex", model: "gpt-5.6-sol[max]" });
	});

	// Mixing vendors should be one word per tier: name the backend, get that
	// backend's idea of what the tier means.
	it("picks up the new backend's model when a tier changes vendor", () => {
		const config = new NetaConfig({ tiers: { expert: { backend: "claude" }, architect: { backend: "codex" } } });

		expect(config.resolve("architect", "codex")).toMatchObject({ name: "codex", model: "gpt-5.6-sol[max]" });
		expect(config.resolve("expert", "claude").name).toBe("claude");
	});

	it("lets a tier name its own model, whatever the backend ships", () => {
		const config = new NetaConfig({ tiers: { journeyman: { backend: "codex", model: "gpt-5.4-mini[low]" } } });

		expect(config.resolve("journeyman", "codex").model).toBe("gpt-5.4-mini[low]");
	});

	it("rejects new Claude Fable tier and backend model overrides without substring false positives", () => {
		expect(() => new NetaConfig({ tiers: { architect: { backend: "claude", model: "fable" } } })).toThrow(
			/Claude Fable model "fable" is disabled.*tiers\.architect\.model.*opus\[1m\]\[max\]/,
		);
		expect(
			() =>
				new NetaConfig({
					backends: { claude: { tierModels: { architect: "claude-fable-5[1m]" } } },
				}),
		).toThrow(/backends\.claude\.tierModels\.architect/);

		expect(
			new NetaConfig({ tiers: { architect: { backend: "claude", model: "fablefish" } } }).resolve(
				"architect",
				"claude",
			).model,
		).toBe("fablefish");
		expect(
			new NetaConfig({ tiers: { architect: { backend: "opencode", model: "fable" } } }).resolve(
				"architect",
				"opencode",
			).model,
		).toBe("fable");
	});

	it("detects the Fable family across aliases without substring false positives", () => {
		const cases = [
			["fable", true],
			["FABLE", true],
			["claude-fable-5-latest", true],
			["anthropic/claude-fable-5-20260817-v1", true],
			["claude-fable-5[1m][max]", true],
			["fable.5:high", true],
			["fablefish", false],
			["claude-fablefish-5", false],
			["other/fable", false],
			["storybook/claude-fable-5", false],
			["anthropic/claude-opus-fable", false],
		] as const;

		for (const [model, forbidden] of cases) expect(isForbiddenClaudeModel(model)).toBe(forbidden);
	});

	it("applies Claude policy to structurally derived aliases, not arbitrary backend names or models", () => {
		const claudeAlias = {
			command: "npx",
			args: ["-y", "@agentclientprotocol/claude-agent-acp@0.68.0"],
		};
		const safeAlias = new NetaConfig({ backends: { "review-primary": claudeAlias } });
		expect(safeAlias.resolve("architect", "review-primary")).toMatchObject({
			claudeLineage: true,
			model: "opus[1m][max]",
		});
		expect(
			() =>
				new NetaConfig({
					tiers: { architect: { backend: "review-primary", model: "claude-fable-5-latest" } },
					backends: { "review-primary": claudeAlias },
				}),
		).toThrow(/Claude Fable model.*tiers\.architect\.model/);

		const unrelated = new NetaConfig({
			tiers: { architect: { backend: "claude-looking-name", model: "fable" } },
			backends: { "claude-looking-name": { command: "custom-acp" } },
		});
		expect(unrelated.resolve("architect", "claude-looking-name")).toMatchObject({
			claudeLineage: false,
			model: "fable",
		});
	});

	it("substitutes the model into backend arguments for backends that take a flag", () => {
		const config = new NetaConfig({
			tiers: { architect: { backend: "custom", model: "big-model" } },
			backends: { custom: { command: "run-agent", modelArgs: ["--model", "{model}"] } },
		});

		const architect = config.resolve("architect", "custom");
		expect(architect.command).toBe("run-agent");
		expect(architect.args).toEqual(["--model", "big-model"]);
	});

	it("drops the tier model when a different backend is used than configured", () => {
		// Model ids belong to a backend's own naming scheme, so carrying "sonnet"
		// over to opencode would ask for a model that does not exist there.
		const config = new NetaConfig({ tiers: { expert: { backend: "claude", model: "sonnet" } } });
		const resolved = config.resolve("expert", "opencode");

		expect(resolved.name).toBe("opencode");
		expect(resolved.model).toBeUndefined();
		expect(resolved.args).toEqual(["acp"]);
	});

	it("names the configured backends when one is unknown", () => {
		expect(() => new NetaConfig().resolve("expert", "nope")).toThrow(/Unknown worker backend "nope".*claude/s);
	});

	it("detects shipped backends by their vendor CLIs, not npx", () => {
		const binDir = mkdtempSync(join(tmpdir(), "neta-vendor-bin-"));
		for (const command of ["npx", "codex"]) {
			const executable = join(binDir, command);
			writeFileSync(executable, "#!/bin/sh\n", "utf-8");
			chmodSync(executable, 0o755);
		}
		const config = new NetaConfig();

		try {
			expect(config.installedBackends({ PATH: binDir })).toEqual(["codex"]);
		} finally {
			rmSync(binDir, { recursive: true, force: true });
		}
	});

	it("excludes disabled backends from automatic selection and rejects explicit use", () => {
		const binDir = mkdtempSync(join(tmpdir(), "neta-backend-bin-"));
		const command = "fixture-backend";
		const executable = join(binDir, command);
		writeFileSync(executable, "#!/bin/sh\n", "utf-8");
		chmodSync(executable, 0o755);
		const config = new NetaConfig({
			backends: {
				enabled: { command },
				opencode: { disabled: true },
			},
		});

		try {
			expect(config.backendNames()).toContain("enabled");
			expect(config.backendNames()).not.toContain("opencode");
			expect(config.installedBackends({ PATH: binDir })).toEqual(["enabled"]);
			expect(() => config.launcher("opencode")).toThrow('Backend "opencode" is disabled in settings.');
			expect(() => config.resolve("expert", "opencode")).toThrow('Backend "opencode" is disabled in settings.');
		} finally {
			rmSync(binDir, { recursive: true, force: true });
		}
	});

	it("launches a backend without a tier, and therefore without a model", () => {
		const launcher = new NetaConfig().launcher("codex");

		expect(launcher.args).toEqual(["-y", "@agentclientprotocol/codex-acp@1.3.0"]);
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
			JSON.stringify({ tiers: { journeyman: { backend: "codex" }, architect: { backend: "codex" } } }),
		);
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ tiers: { journeyman: { backend: "opencode" } } }),
		);

		const settings = loadNetaSettings(cwd, agentDir);

		expect(settings.tiers).toEqual({ journeyman: { backend: "opencode" }, architect: { backend: "codex" } });
	});

	it("maps old settings keys to the guild ladder and lets canonical keys win", () => {
		const agentDir = scratch();
		const cwd = scratch();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				tiers: { intern: { backend: "legacy-intern" }, junior: { backend: "legacy-junior" } },
				backends: { claude: { tierModels: { intern: "legacy-haiku", junior: "legacy-sonnet" } } },
			}),
		);
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({
				tiers: { apprentice: { backend: "canonical-apprentice" }, journeyman: { model: "canonical-sonnet" } },
				backends: { claude: { tierModels: { apprentice: "canonical-haiku", journeyman: "canonical-journeyman" } } },
			}),
		);

		const settings = loadNetaSettings(cwd, agentDir);

		expect(settings.tiers).toEqual({
			apprentice: { backend: "canonical-apprentice" },
			journeyman: { backend: "legacy-junior", model: "canonical-sonnet" },
		});
		expect(settings.backends?.claude?.tierModels).toEqual({
			apprentice: "canonical-haiku",
			journeyman: "canonical-journeyman",
		});
	});

	it("merges sibling backend and tier fields from user and project settings", () => {
		const agentDir = scratch();
		const cwd = scratch();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				backends: {
					opencode: {
						command: "user-opencode",
						env: { API_KEY: "user-key" },
						tierModels: { architect: "user-architect" },
					},
				},
				tiers: { architect: { backend: "opencode" } },
			}),
		);
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({
				backends: {
					opencode: {
						disabled: false,
						env: { BASE_URL: "project-url" },
						tierModels: { expert: "project-expert" },
					},
				},
				tiers: { architect: { model: "project-architect" } },
			}),
		);

		const settings = loadNetaSettings(cwd, agentDir);

		expect(settings.backends?.opencode).toEqual({
			command: "user-opencode",
			disabled: false,
			env: { API_KEY: "user-key", BASE_URL: "project-url" },
			tierModels: { architect: "user-architect", expert: "project-expert" },
		});
		expect(settings.tiers?.architect).toEqual({ backend: "opencode", model: "project-architect" });
	});

	it("lets a project re-enable a backend disabled in user settings", () => {
		const agentDir = scratch();
		const cwd = scratch();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ backends: { opencode: { disabled: true } } }));
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ backends: { opencode: { disabled: false } } }),
		);

		const settings = loadNetaSettings(cwd, agentDir);

		expect(settings.backends).toEqual({ opencode: { disabled: false } });
		expect(new NetaConfig(settings).backendNames()).toContain("opencode");
	});

	// A broken settings file must not stop the leader from starting; the defaults
	// are usable on their own.
	it("warns when it ignores a malformed settings file", () => {
		const agentDir = scratch();
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, "{ not json");
		const error = spyOn(console, "error").mockImplementation(() => {});

		try {
			expect(loadNetaSettings(scratch(), agentDir)).toEqual({ leader: {}, mux: {}, tiers: {}, backends: {} });
			expect(error).toHaveBeenCalledWith(`Warning: ignoring invalid Neta settings file ${settingsPath}.`);
		} finally {
			error.mockRestore();
		}
	});

	it("warns when a settings file has an invalid structure", () => {
		const agentDir = scratch();
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ backends: [] }));
		const error = spyOn(console, "error").mockImplementation(() => {});

		try {
			loadNetaSettings(scratch(), agentDir);
			expect(error).toHaveBeenCalledWith(`Warning: ignoring invalid Neta settings file ${settingsPath}.`);
		} finally {
			error.mockRestore();
		}
	});

	it("warns and quarantines old user and project Fable values without rewriting either file", () => {
		const agentDir = scratch();
		const cwd = scratch();
		const userPath = join(agentDir, "settings.json");
		const projectDir = join(cwd, CONFIG_DIR_NAME);
		const projectPath = join(projectDir, "settings.json");
		const userContents = JSON.stringify({
			leader: { strictMcp: true },
			tiers: { architect: { backend: "claude", model: "fable" } },
		});
		const projectContents = JSON.stringify({
			mux: { panes: false },
			backends: { claude: { env: { SAFE: "yes" }, tierModels: { expert: "claude-fable-5[1m]" } } },
		});
		writeFileSync(userPath, userContents);
		mkdirSync(projectDir);
		writeFileSync(projectPath, projectContents);
		const error = spyOn(console, "error").mockImplementation(() => {});

		try {
			const settings = loadNetaSettings(cwd, agentDir);
			const config = new NetaConfig(settings);

			expect(error).toHaveBeenCalledWith(expect.stringContaining(`${userPath} at tiers.architect.model`));
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining(`${projectPath} at backends.claude.tierModels.expert`),
			);
			expect(config.resolve("architect", "claude").model).toBe("opus[1m][max]");
			expect(config.resolve("expert", "claude").model).toBe("opus[1m]");
			expect(settings.leader?.strictMcp).toBe(true);
			expect(settings.mux?.panes).toBe(false);
			expect(settings.backends?.claude?.env).toEqual({ SAFE: "yes" });
			expect(readFileSync(userPath, "utf-8")).toBe(userContents);
			expect(readFileSync(projectPath, "utf-8")).toBe(projectContents);
		} finally {
			error.mockRestore();
		}
	});

	it("quarantines a Fable value that becomes Claude-only after user and project settings merge", () => {
		const agentDir = scratch();
		const cwd = scratch();
		const userPath = join(agentDir, "settings.json");
		writeFileSync(
			userPath,
			JSON.stringify({ tiers: { architect: { backend: "opencode", model: "anthropic/claude-fable-5" } } }),
		);
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ tiers: { architect: { backend: "claude" } } }),
		);
		const error = spyOn(console, "error").mockImplementation(() => {});

		try {
			const settings = loadNetaSettings(cwd, agentDir);
			expect(settings.tiers?.architect).toEqual({ backend: "claude" });
			expect(new NetaConfig(settings).resolve("architect", "claude").model).toBe("opus[1m][max]");
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining(`${userPath} at tiers.architect.model after settings merge`),
			);
		} finally {
			error.mockRestore();
		}
	});

	it("quarantines old Fable values for a custom Claude alias without rewriting settings", () => {
		const agentDir = scratch();
		const cwd = scratch();
		const settingsPath = join(agentDir, "settings.json");
		const contents = JSON.stringify({
			tiers: { architect: { backend: "review-primary", model: "claude-fable-5-latest" } },
			backends: {
				"review-primary": {
					command: "npx",
					args: ["-y", "@agentclientprotocol/claude-agent-acp@0.68.0"],
					tierModels: { expert: "anthropic/claude-fable-5-20260817-v1" },
				},
			},
		});
		writeFileSync(settingsPath, contents);
		const error = spyOn(console, "error").mockImplementation(() => {});

		try {
			const settings = loadNetaSettings(cwd, agentDir);
			expect(settings.tiers?.architect?.model).toBeUndefined();
			expect(settings.backends?.["review-primary"]?.tierModels?.expert).toBeUndefined();
			expect(readFileSync(settingsPath, "utf-8")).toBe(contents);
			expect(error).toHaveBeenCalledWith(expect.stringContaining("backends.review-primary.tierModels.expert"));
		} finally {
			error.mockRestore();
		}
	});

	it("persists a tier override to .neta/settings.json without clobbering other tiers", async () => {
		const cwd = scratch();
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ tiers: { journeyman: { backend: "codex" } } }),
		);

		await persistTierOverride(cwd, "expert", { backend: "opencode" });

		const updated = JSON.parse(readFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), "utf-8"));
		expect(updated.tiers).toEqual({
			journeyman: { backend: "codex" },
			expert: { backend: "opencode" },
		});
	});

	it("creates .neta directory when persisting tier override if it does not exist", async () => {
		const cwd = scratch();

		await persistTierOverride(cwd, "architect", { backend: "claude", model: "opus" });

		expect(existsSync(join(cwd, CONFIG_DIR_NAME))).toBe(true);
		const settings = JSON.parse(readFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), "utf-8"));
		expect(settings.tiers).toEqual({ architect: { backend: "claude", model: "opus" } });
	});

	it("rejects persisting a new Claude Fable override before writing", async () => {
		const cwd = scratch();

		expect(persistTierOverride(cwd, "architect", { backend: "claude", model: "claude-fable-5[1m]" })).rejects.toThrow(
			/Claude Fable model.*disabled.*tiers\.architect\.model/,
		);
		expect(existsSync(join(cwd, CONFIG_DIR_NAME, "settings.json"))).toBe(false);
	});

	it("rejects persisting Fable through a custom Claude alias before writing", async () => {
		const cwd = scratch();
		const settingsDir = join(cwd, CONFIG_DIR_NAME);
		const settingsPath = join(settingsDir, "settings.json");
		mkdirSync(settingsDir);
		writeFileSync(
			settingsPath,
			JSON.stringify({
				backends: {
					"review-primary": {
						command: "npx",
						args: ["-y", "@agentclientprotocol/claude-agent-acp@0.68.0"],
					},
				},
			}),
		);
		const before = readFileSync(settingsPath, "utf-8");

		await expect(
			persistTierOverride(cwd, "architect", { backend: "review-primary", model: "fable-5-latest" }),
		).rejects.toThrow(/Claude Fable model.*tiers\.architect\.model/);
		expect(readFileSync(settingsPath, "utf-8")).toBe(before);
	});

	it("drops a quarantined Fable value when persisting another setting and preserves unrelated keys", async () => {
		const cwd = scratch();
		const settingsDir = join(cwd, CONFIG_DIR_NAME);
		const settingsPath = join(settingsDir, "settings.json");
		mkdirSync(settingsDir);
		writeFileSync(
			settingsPath,
			JSON.stringify({ mux: { panes: false }, tiers: { architect: { backend: "claude", model: "fable" } } }),
		);
		const error = spyOn(console, "error").mockImplementation(() => {});

		try {
			await persistTierOverride(cwd, "expert", { backend: "codex" });
			const updated = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(updated).toEqual({
				mux: { panes: false },
				tiers: { architect: { backend: "claude" }, expert: { backend: "codex" } },
			});
			expect(error).toHaveBeenCalledWith(expect.stringContaining(`${settingsPath} at tiers.architect.model`));
		} finally {
			error.mockRestore();
		}
	});
});
