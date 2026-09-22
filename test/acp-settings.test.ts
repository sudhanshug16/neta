import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_SETTINGS,
	installedClaudeAcpProvider,
	installedCodexAcpProvider,
	installedOpenCodeAcpProvider,
	isForbiddenModel,
	launchArgs,
	launchEnvironment,
	loadSettings,
	mergeSettings,
	providerCommandAvailable,
	providerFor,
	providerPath,
	stagedCodexAcpProvider,
	UnknownProviderError,
} from "../src/acp/settings.ts";

describe("provider settings", () => {
	test("defaults load with no files", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-settings-"));
		const { settings, warnings } = loadSettings({ netaDir: dir });
		expect(warnings).toEqual([]);
		expect(settings.leader).toEqual({ provider: "claude" });
		expect(settings.forbiddenModels).toEqual([]);
		expect(Object.keys(settings.providers).sort()).toEqual(["claude", "codex", "opencode"]);
		expect(settings.providers.claude?.defaultModel).toBe("sonnet");
		expect(settings.providers.claude?.unsandboxedMode).toBe("bypassPermissions");
		expect(settings.providers.codex?.unsandboxedMode).toBe("agent-full-access");
		expect(settings.providers.opencode?.unsandboxedMode).toBe("build");
	});

	test("workspace beats user beats defaults, arrays replace", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-settings-"));
		const root = mkdtempSync(join(tmpdir(), "neta-ws-"));
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({
				providers: { claude: { args: ["user-args"], defaultModel: "user-model" } },
				leader: { provider: "codex" },
				forbiddenModels: ["user-banned"],
			}),
		);
		mkdirSync(join(root, ".neta"), { recursive: true });
		writeFileSync(
			join(root, ".neta", "settings.json"),
			JSON.stringify({ providers: { claude: { defaultModel: "ws-model" } } }),
		);
		const { settings, warnings } = loadSettings({ netaDir: dir, workspaceRoot: root });
		expect(warnings).toEqual([]);
		expect(settings.leader.provider).toBe("codex");
		expect(settings.forbiddenModels).toEqual(["user-banned"]);
		expect(settings.providers.claude?.args).toEqual(["user-args"]);
		expect(settings.providers.claude?.defaultModel).toBe("ws-model");
		expect(settings.providers.claude?.command).toBe("npx");
	});

	test("exact retired shipped adapters advance without changing custom pins", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-settings-"));
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({
				providers: {
					claude: { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@0.68.0"] },
					codex: {
						command: "custom-npx",
						args: ["-y", "@agentclientprotocol/codex-acp@1.3.0"],
						env: { OPENAI_BASE_URL: "https://example.invalid" },
					},
					opencode: { args: ["acp", "--pinned"] },
				},
			}),
		);
		const { settings, warnings } = loadSettings({ netaDir: dir });
		expect(settings.providers.claude?.args).toEqual(DEFAULT_SETTINGS.providers.claude?.args);
		expect(warnings.some((warning) => warning.includes("retired shipped adapter"))).toBe(true);
		expect(settings.providers.codex?.command).toBe("custom-npx");
		expect(settings.providers.codex?.args).toEqual(["-y", "@agentclientprotocol/codex-acp@1.3.0"]);
		expect(settings.providers.codex?.env).toEqual({ OPENAI_BASE_URL: "https://example.invalid" });
		expect(settings.providers.opencode?.args).toEqual(["acp", "--pinned"]);
	});

	test("leader name overrides across layers and a wrong-typed one is dropped", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-settings-"));
		const root = mkdtempSync(join(tmpdir(), "neta-ws-"));
		expect(loadSettings({ netaDir: dir }).settings.leader.name).toBeUndefined();
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ leader: { name: "Halden" } }));
		expect(loadSettings({ netaDir: dir }).settings.leader.name).toBe("Halden");
		mkdirSync(join(root, ".neta"), { recursive: true });
		writeFileSync(join(root, ".neta", "settings.json"), JSON.stringify({ leader: { name: "Wren" } }));
		const layered = loadSettings({ netaDir: dir, workspaceRoot: root });
		expect(layered.warnings).toEqual([]);
		expect(layered.settings.leader.name).toBe("Wren");
		expect(layered.settings.leader.provider).toBe("claude");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ leader: { name: 7 } }));
		const bad = loadSettings({ netaDir: dir });
		expect(bad.settings.leader.name).toBeUndefined();
		expect(bad.warnings.some((w) => w.includes("leader name is not a string"))).toBe(true);
	});

	test("bad JSON warns and keeps the lower layer", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-settings-"));
		writeFileSync(join(dir, "settings.json"), "{nope");
		const { settings, warnings } = loadSettings({ netaDir: dir });
		expect(warnings).toHaveLength(1);
		expect(settings).toEqual(mergeSettings(DEFAULT_SETTINGS, {}));
	});

	test("wrong-typed fields are dropped with warnings", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-settings-"));
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ providers: { claude: { args: "nope", resume: "yes" } }, forbiddenModels: "x" }),
		);
		const { settings, warnings } = loadSettings({ netaDir: dir });
		expect(warnings.length).toBeGreaterThan(0);
		expect(settings.providers.claude?.args).toEqual(DEFAULT_SETTINGS.providers.claude?.args);
		expect(settings.providers.claude?.resume).toBe(true);
		expect(settings.forbiddenModels).toEqual([]);
	});

	test("disabled providers throw, launchArgs follow access", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-settings-"));
		const { settings } = loadSettings({ netaDir: dir });
		expect(providerFor(settings, "claude").command).toBe("npx");
		expect(() => providerFor(settings, "missing")).toThrow(UnknownProviderError);
		const disabled = mergeSettings(settings, { providers: { claude: { disabled: true } } });
		expect(() => providerFor(disabled, "claude")).toThrow(UnknownProviderError);
		const codex = providerFor(settings, "codex");
		expect(launchEnvironment(codex, "readOnly").INITIAL_AGENT_MODE).toBe("read-only");
		expect(launchEnvironment(codex, "readWrite").INITIAL_AGENT_MODE).toBe("agent");
		expect(launchArgs(providerFor(settings, "claude"), "readOnly")).toEqual(settings.providers.claude?.args);
	});

	test("uses only a matching Codex ACP installation resolved from Neta", () => {
		const root = mkdtempSync(join(tmpdir(), "neta-codex-acp-"));
		const packageJson = join(root, "package.json");
		const adapter = join(root, "bin", "codex-acp");
		mkdirSync(join(root, "bin"));
		writeFileSync(adapter, "#!/bin/sh\n");
		chmodSync(adapter, 0o755);
		writeFileSync(packageJson, JSON.stringify({ version: "1.10.0", bin: { "codex-acp": "bin/codex-acp" } }));
		const defaultCodex = providerFor(DEFAULT_SETTINGS, "codex");
		const installed = installedCodexAcpProvider(
			{ ...defaultCodex, env: { CODEX_PATH: "/custom/codex" } },
			() => packageJson,
		);
		if (installed === undefined) throw new Error("matching Codex ACP installation was not resolved");
		expect(installed).toMatchObject({ command: adapter, args: [], codexAcp: true });
		expect(installed.env).toEqual({ CODEX_PATH: "/custom/codex" });
		expect(launchEnvironment(installed, "readOnly").INITIAL_AGENT_MODE).toBe("read-only");
		expect(launchEnvironment(installed, "readWrite").INITIAL_AGENT_MODE).toBe("agent");
	});

	test("uses only a matching Claude ACP installation resolved from Neta through Node", () => {
		const root = mkdtempSync(join(tmpdir(), "neta-claude-acp-"));
		const packageJson = join(root, "package.json");
		const adapter = join(root, "dist", "index.js");
		mkdirSync(join(root, "dist"));
		writeFileSync(adapter, "export {};\n");
		writeFileSync(packageJson, JSON.stringify({ version: "0.74.0", bin: { "claude-agent-acp": "dist/index.js" } }));
		const defaultClaude = providerFor(DEFAULT_SETTINGS, "claude");
		const installed = installedClaudeAcpProvider(
			{ ...defaultClaude, env: { ANTHROPIC_API_KEY: "test-key" } },
			() => packageJson,
		);
		if (installed === undefined) throw new Error("matching Claude ACP installation was not resolved");
		expect(installed).toMatchObject({ command: process.execPath, args: [adapter], claudeAcp: true });
		expect(installed.env).toEqual({ ANTHROPIC_API_KEY: "test-key" });
	});

	test("prefers a staged Codex adapter for the default tuple without npx", () => {
		const root = mkdtempSync(join(tmpdir(), "neta-codex-stage-"));
		const entry = join(root, "codex-acp.mjs");
		writeFileSync(entry, "export {};\n");
		const staged = stagedCodexAcpProvider(providerFor(DEFAULT_SETTINGS, "codex"), entry);
		if (staged === undefined) throw new Error("staged Codex adapter was not resolved");
		expect(staged).toMatchObject({ command: process.execPath, args: [entry], codexAcp: true });
		expect(launchEnvironment(staged, "readOnly").INITIAL_AGENT_MODE).toBe("read-only");
		expect(
			stagedCodexAcpProvider({ ...providerFor(DEFAULT_SETTINGS, "codex"), args: ["acp"] }, entry),
		).toBeUndefined();
	});

	test("keeps npx for missing or mismatched Codex ACP and all custom launch tuples", () => {
		const root = mkdtempSync(join(tmpdir(), "neta-codex-acp-"));
		const packageJson = join(root, "package.json");
		writeFileSync(packageJson, JSON.stringify({ version: "1.9.0", bin: { "codex-acp": "bin/codex-acp" } }));
		const defaultCodex = providerFor(DEFAULT_SETTINGS, "codex");
		expect(installedCodexAcpProvider(defaultCodex, () => packageJson)).toBeUndefined();
		expect(
			installedCodexAcpProvider(defaultCodex, () => {
				throw new Error("missing");
			}),
		).toBeUndefined();
		const custom = { ...defaultCodex, command: "custom-codex", args: ["acp"], env: { CODEX_PATH: "/custom/codex" } };
		expect(installedCodexAcpProvider(custom, () => packageJson)).toBeUndefined();
	});

	test("keeps npx for missing or mismatched Claude ACP and all custom launch tuples", () => {
		const root = mkdtempSync(join(tmpdir(), "neta-claude-acp-"));
		const packageJson = join(root, "package.json");
		writeFileSync(packageJson, JSON.stringify({ version: "0.73.0", bin: { "claude-agent-acp": "dist/index.js" } }));
		const defaultClaude = providerFor(DEFAULT_SETTINGS, "claude");
		expect(installedClaudeAcpProvider(defaultClaude, () => packageJson)).toBeUndefined();
		expect(
			installedClaudeAcpProvider(defaultClaude, () => {
				throw new Error("missing");
			}),
		).toBeUndefined();
		expect(installedClaudeAcpProvider({ ...defaultClaude, args: ["agent"] }, () => packageJson)).toBeUndefined();
	});

	test("uses only a matching OpenCode installation resolved from Neta through Node", () => {
		const root = mkdtempSync(join(tmpdir(), "neta-opencode-"));
		const packageJson = join(root, "package.json");
		const launcher = join(root, "bin", "opencode");
		mkdirSync(join(root, "bin"));
		writeFileSync(launcher, "module.exports = {};\n");
		const defaultOpenCode = providerFor(DEFAULT_SETTINGS, "opencode");
		writeFileSync(packageJson, JSON.stringify({ version: "1.2.26", bin: { opencode: "bin/opencode" } }));
		const installed = installedOpenCodeAcpProvider(
			{ ...defaultOpenCode, env: { OPENCODE_BIN_PATH: "/custom/opencode" } },
			() => packageJson,
		);
		if (installed === undefined) throw new Error("matching OpenCode installation was not resolved");
		expect(installed).toMatchObject({ command: process.execPath, args: [launcher, "acp"] });
		expect(installed.env).toEqual({ OPENCODE_BIN_PATH: "/custom/opencode" });
	});

	test("keeps the external OpenCode command for missing, mismatched, and custom launch tuples", () => {
		const root = mkdtempSync(join(tmpdir(), "neta-opencode-"));
		const packageJson = join(root, "package.json");
		writeFileSync(packageJson, JSON.stringify({ version: "1.2.25", bin: { opencode: "bin/opencode" } }));
		const defaultOpenCode = providerFor(DEFAULT_SETTINGS, "opencode");
		expect(installedOpenCodeAcpProvider(defaultOpenCode, () => packageJson)).toBeUndefined();
		expect(
			installedOpenCodeAcpProvider(defaultOpenCode, () => {
				throw new Error("missing");
			}),
		).toBeUndefined();
		expect(
			installedOpenCodeAcpProvider({ ...defaultOpenCode, command: "/custom/opencode" }, () => packageJson),
		).toBeUndefined();
	});

	test("isForbiddenModel is exact-match", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-settings-"));
		const { settings } = loadSettings({ netaDir: dir });
		const withBan = mergeSettings(settings, { forbiddenModels: ["claude-fable-5"] });
		expect(isForbiddenModel(withBan, "claude-fable-5")).toBe(true);
		expect(isForbiddenModel(withBan, "claude-fable")).toBe(false);
		expect(isForbiddenModel(withBan, "claude-fable-50")).toBe(false);
	});

	test("provider commands resolve from the augmented path and reject directories", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-provider-bin-"));
		const command = join(dir, "adapter");
		writeFileSync(command, "#!/bin/sh\n");
		chmodSync(command, 0o755);
		const base = { command: "adapter", args: ["acp"], resume: true, defaultModel: "" };
		expect(providerCommandAvailable({ ...base, env: { PATH: dir } })).toBe(true);
		expect(providerCommandAvailable({ ...base, command: ".", env: { PATH: dir } }, dir)).toBe(false);
		expect(providerCommandAvailable({ ...base, command: "./adapter" }, dir)).toBe(true);
		expect(providerPath(base)).toContain(join(process.env.HOME ?? "", ".local", "bin"));
	});
});
