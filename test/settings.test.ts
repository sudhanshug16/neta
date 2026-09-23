import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_SETTINGS,
	isForbiddenModel,
	loadSettings,
	mergeSettings,
	providerCommandAvailable,
	providerFor,
	providerPath,
	UnknownProviderError,
} from "../src/session/settings.ts";

describe("OpenCode settings", () => {
	test("defaults select only OpenCode", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-settings-"));
		const { settings, warnings } = loadSettings({ netaDir: dir });
		expect(warnings).toEqual([]);
		expect(settings.leader).toEqual({ provider: "opencode" });
		expect(Object.keys(settings.providers)).toEqual(["opencode"]);
		expect(settings.providers.opencode?.args).toEqual(["serve"]);
		expect(settings.forbiddenModels).toEqual([]);
	});

	test("workspace beats user beats defaults, arrays replace", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-settings-"));
		const root = mkdtempSync(join(tmpdir(), "neta-ws-"));
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({
				providers: { opencode: { args: ["user-args"], defaultModel: "user-model" } },
				forbiddenModels: ["user-banned"],
			}),
		);
		mkdirSync(join(root, ".neta"), { recursive: true });
		writeFileSync(
			join(root, ".neta", "settings.json"),
			JSON.stringify({ providers: { opencode: { defaultModel: "ws-model" } } }),
		);
		const { settings, warnings } = loadSettings({ netaDir: dir, workspaceRoot: root });
		expect(warnings).toEqual([]);
		expect(settings.leader.provider).toBe("opencode");
		expect(settings.forbiddenModels).toEqual(["user-banned"]);
		expect(settings.providers.opencode?.args).toEqual(["user-args"]);
		expect(settings.providers.opencode?.defaultModel).toBe("ws-model");
	});

	test("saved legacy provider entries remain readable without entering defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-settings-"));
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({
				providers: { claude: { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@0.68.0"] } },
			}),
		);
		const { settings, warnings } = loadSettings({ netaDir: dir });
		expect(warnings).toEqual([]);
		expect(settings.leader.provider).toBe("opencode");
		expect(settings.providers.claude?.args).toEqual(["-y", "@agentclientprotocol/claude-agent-acp@0.68.0"]);
	});

	test("the previous shipped OpenCode ACP command advances to direct control", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-settings-"));
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ providers: { opencode: { args: ["acp"] } } }));
		const { settings, warnings } = loadSettings({ netaDir: dir });
		expect(settings.providers.opencode?.args).toEqual(["serve"]);
		expect(warnings.some((warning) => warning.includes("direct control"))).toBe(true);
	});

	test("leader name layers and wrong type are handled", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-settings-"));
		const root = mkdtempSync(join(tmpdir(), "neta-ws-"));
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ leader: { name: "Halden" } }));
		mkdirSync(join(root, ".neta"), { recursive: true });
		writeFileSync(join(root, ".neta", "settings.json"), JSON.stringify({ leader: { name: "Wren" } }));
		expect(loadSettings({ netaDir: dir, workspaceRoot: root }).settings.leader.name).toBe("Wren");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ leader: { name: 7 } }));
		const invalid = loadSettings({ netaDir: dir });
		expect(invalid.settings.leader.name).toBeUndefined();
		expect(invalid.warnings.some((warning) => warning.includes("leader name is not a string"))).toBe(true);
	});

	test("bad JSON and wrong typed fields preserve lower settings", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-settings-"));
		writeFileSync(join(dir, "settings.json"), "{nope");
		expect(loadSettings({ netaDir: dir }).settings).toEqual(mergeSettings(DEFAULT_SETTINGS, {}));
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ providers: { opencode: { args: "nope", resume: "yes" } }, forbiddenModels: "x" }),
		);
		const { settings, warnings } = loadSettings({ netaDir: dir });
		expect(warnings.length).toBeGreaterThan(0);
		expect(settings.providers.opencode?.args).toEqual(["serve"]);
		expect(settings.providers.opencode?.resume).toBe(true);
		expect(settings.forbiddenModels).toEqual([]);
	});

	test("disabled providers fail and model bans are exact", () => {
		const disabled = mergeSettings(DEFAULT_SETTINGS, { providers: { opencode: { disabled: true } } });
		expect(() => providerFor(disabled, "opencode")).toThrow(UnknownProviderError);
		expect(() => providerFor(DEFAULT_SETTINGS, "missing")).toThrow(UnknownProviderError);
		const banned = mergeSettings(DEFAULT_SETTINGS, { forbiddenModels: ["provider/model"] });
		expect(isForbiddenModel(banned, "provider/model")).toBe(true);
		expect(isForbiddenModel(banned, "provider/model-2")).toBe(false);
	});

	test("provider command search rejects directories", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-provider-bin-"));
		const command = join(dir, "adapter");
		writeFileSync(command, "#!/bin/sh\n");
		chmodSync(command, 0o755);
		const base = { command: "adapter", args: ["serve"], resume: true, defaultModel: "" };
		expect(providerCommandAvailable({ ...base, env: { PATH: dir } })).toBe(true);
		expect(providerCommandAvailable({ ...base, command: ".", env: { PATH: dir } }, dir)).toBe(false);
		expect(providerCommandAvailable({ ...base, command: "./adapter" }, dir)).toBe(true);
		expect(providerPath(base)).toContain(join(process.env.HOME ?? "", ".local", "bin"));
	});
});
