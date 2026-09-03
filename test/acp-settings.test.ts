import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_SETTINGS,
	isForbiddenModel,
	launchArgs,
	loadSettings,
	mergeSettings,
	providerFor,
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
		expect(launchArgs(codex, "readOnly")).toContain('sandbox_mode="read-only"');
		expect(launchArgs(codex, "readWrite")).toContain('sandbox_mode="workspace-write"');
		expect(launchArgs(providerFor(settings, "claude"), "readOnly")).toEqual(settings.providers.claude?.args);
	});

	test("isForbiddenModel is exact-match", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-settings-"));
		const { settings } = loadSettings({ netaDir: dir });
		const withBan = mergeSettings(settings, { forbiddenModels: ["claude-fable-5"] });
		expect(isForbiddenModel(withBan, "claude-fable-5")).toBe(true);
		expect(isForbiddenModel(withBan, "claude-fable")).toBe(false);
		expect(isForbiddenModel(withBan, "claude-fable-50")).toBe(false);
	});
});
