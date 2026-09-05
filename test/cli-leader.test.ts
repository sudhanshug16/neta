// T8.7: `neta mode`, `neta models` and `neta model <id>` through the built
// bundle against a temp `NETA_DIR` (the T8.2 harness). The harness seeds one
// `fake` provider whose default model is `test-model` and whose agent also
// offers `legacy-other`, so the bare ids below are unambiguous.
import { afterAll, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../src/cli/client.ts";
import { resolveModel } from "../src/cli/commands/leader.ts";
import type { ModelInfo } from "../src/node/protocol.ts";
import { type Harness, startNode as startHarness } from "./helpers/cli-harness.ts";

let harness: Harness | undefined;

async function ensureSetup(): Promise<Harness> {
	if (harness !== undefined) {
		return harness;
	}
	const fresh = await startHarness();
	harness = fresh;
	try {
		const started = await fresh.run(["node", "start", "--detach"]);
		expect(started.code).toBe(0);
		const opened = await fresh.run(["open", process.cwd()]);
		expect(opened.code).toBe(0);
	} catch (error) {
		await fresh.stop();
		harness = undefined;
		throw error;
	}
	return fresh;
}

afterAll(async () => {
	await harness?.stop();
	harness = undefined;
});

describe("mode", () => {
	test("mode prints lead on a fresh leader", async () => {
		const h = await ensureSetup();
		const result = await h.run(["mode"]);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("lead");
	}, 120000);

	test("mode lead++ without an active mission is refused", async () => {
		const h = await ensureSetup();
		const set = await h.run(["mode", "lead++"]);
		expect(set.code).toBe(1);
		expect(set.stderr).toContain("Lead++ requires an active mission");
		const read = await h.run(["mode"]);
		expect(read.code).toBe(0);
		expect(read.stdout.trim()).toBe("lead");
	}, 120000);

	test("mode lead exits 0 and a following mode reflects it", async () => {
		const h = await ensureSetup();
		const set = await h.run(["mode", "lead"]);
		expect(set.code).toBe(0);
		expect(set.stdout.trim()).toBe("mode lead");
		const read = await h.run(["mode"]);
		expect(read.code).toBe(0);
		expect(read.stdout.trim()).toBe("lead");
	}, 120000);

	test("mode --mission with an unknown number exits 1", async () => {
		const h = await ensureSetup();
		const result = await h.run(["mode", "lead", "--mission", "99"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("neta: no mission #99 in this workspace");
	}, 120000);
});

describe("models", () => {
	test("models --json lists the fake provider with one default: true", async () => {
		const h = await ensureSetup();
		const result = await h.run(["models", "--json"]);
		expect(result.code).toBe(0);
		const parsed = JSON.parse(result.stdout) as Array<{
			provider: string;
			model: string;
			default: boolean;
			forbidden: boolean;
		}>;
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed.length).toBeGreaterThan(0);
		for (const entry of parsed) {
			expect(typeof entry.provider).toBe("string");
			expect(typeof entry.model).toBe("string");
			expect(typeof entry.default).toBe("boolean");
			expect(typeof entry.forbidden).toBe("boolean");
		}
		const defaults = parsed.filter((entry) => entry.default === true);
		expect(defaults).toHaveLength(1);
		expect(defaults[0]).toMatchObject({ provider: "fake", model: "test-model" });
		expect(parsed.every((entry) => entry.forbidden === false)).toBe(true);
	}, 120000);

	test("models text marks the default model", async () => {
		const h = await ensureSetup();
		const result = await h.run(["models"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("fake");
		expect(result.stdout).toContain("test-model");
		expect(result.stdout).toContain("default");
	}, 120000);
});

describe("model", () => {
	test("model sets the leader session by bare id", async () => {
		const h = await ensureSetup();
		const result = await h.run(["model", "test-model"]);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("model fake/test-model");
	}, 120000);

	test("model accepts a provider/model id", async () => {
		const h = await ensureSetup();
		const result = await h.run(["model", "fake/test-model"]);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("model fake/test-model");
	}, 120000);

	test("model nope exits 1", async () => {
		const h = await ensureSetup();
		const result = await h.run(["model", "nope"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("neta: unknown model");
	}, 120000);

	test("a forbidden model exits 3", async () => {
		const h = await ensureSetup();
		const settingsPath = join(h.dir, "settings.json");
		const original = await readFile(settingsPath, "utf8");
		const edited = { ...(JSON.parse(original) as Record<string, unknown>), forbiddenModels: ["legacy-other"] };
		await writeFile(settingsPath, JSON.stringify(edited, null, "\t"));
		try {
			const result = await h.run(["model", "legacy-other"]);
			expect(result.code).toBe(3);
			expect(result.stderr).toContain("forbidden model");
			const listed = await h.run(["models", "--json"]);
			expect(listed.code).toBe(0);
			const parsed = JSON.parse(listed.stdout) as Array<{ model: string; forbidden: boolean }>;
			expect(parsed.find((entry) => entry.model === "legacy-other")?.forbidden).toBe(true);
		} finally {
			await writeFile(settingsPath, original);
		}
	}, 120000);
});

describe("resolveModel", () => {
	const models: ModelInfo[] = [
		{ id: "shared", name: "Shared", provider: "a" },
		{ id: "shared", name: "Shared", provider: "b" },
		{ id: "solo", name: "Solo", provider: "a" },
	];

	test("a bare id unique across providers resolves", () => {
		expect(resolveModel(models, "solo")).toEqual({ provider: "a", id: "solo" });
	});

	test("a provider/model id resolves", () => {
		expect(resolveModel(models, "b/shared")).toEqual({ provider: "b", id: "shared" });
	});

	test("a bare id on two providers is ambiguous, exit 1", () => {
		let thrown: unknown;
		try {
			resolveModel(models, "shared");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(CliError);
		expect((thrown as CliError).code).toBe(1);
		expect((thrown as CliError).message).toContain("ambiguous");
	});

	test("an unknown id exits 1", () => {
		let thrown: unknown;
		try {
			resolveModel(models, "nope");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(CliError);
		expect((thrown as CliError).code).toBe(1);
		expect((thrown as CliError).message).toContain("unknown model");
	});

	test("a provider/model id with the wrong provider exits 1", () => {
		let thrown: unknown;
		try {
			resolveModel(models, "c/solo");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(CliError);
		expect((thrown as CliError).code).toBe(1);
	});
});
