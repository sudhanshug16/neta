import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routingHandlers } from "../src/node/handlers-routing.ts";
import type { Connection, NodeContext } from "../src/node/server.ts";
import {
	loadModelPreferences,
	modelPreference,
	parseModelPreferences,
	saveModelPreference,
	saveModelPreferences,
} from "../src/routing/preferences.ts";
import { createModelRouter } from "../src/routing/router.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const contributor = "meta/muse-spark-1.3-contributor";
const standard = "meta/muse-spark-1.3";
const empty = { version: 1 as const, models: {} };

test("model names do not change defaults or override explicit preferences", () => {
	for (const id of [contributor, `openrouter/${contributor}`, "opencode/muse-spark-1.3-contributor-free", standard]) {
		expect(modelPreference(empty, id)).toBe("allow");
		expect(modelPreference({ version: 1, models: { [id]: "exclude" } }, id)).toBe("exclude");
	}
	expect(modelPreference({ version: 1, models: { [contributor]: "prefer" } }, contributor)).toBe("prefer");
});

test("preferences persist, concurrent saves compose, and malformed input fails closed", async () => {
	const root = await mkdtemp(join(tmpdir(), "neta-preferences-"));
	roots.push(root);
	await Promise.all([
		saveModelPreference(root, contributor, "prefer"),
		saveModelPreference(root, standard, "exclude"),
	]);
	expect(loadModelPreferences(root).models).toEqual({ [contributor]: "prefer", [standard]: "exclude" });
	for (const raw of [
		null,
		{},
		{ version: 1, models: [] },
		{ version: 1, models: { bad: "prefer" } },
		{ version: 1, models: { [standard]: "yes" } },
		{ version: 1, models: { [standard]: ["allow"] } },
	])
		expect(() => parseModelPreferences(raw)).toThrow();
	await writeFile(join(root, "model-preferences.json"), "broken");
	expect(() => loadModelPreferences(root)).toThrow("Cannot read");
});

test("bulk preferences persist together, preserve unrelated choices, and reject the entire invalid batch", async () => {
	const root = await mkdtemp(join(tmpdir(), "neta-bulk-preferences-"));
	roots.push(root);
	await saveModelPreference(root, standard, "prefer");
	await saveModelPreferences(root, { [contributor]: "allow", "openai/luna": "exclude" });
	const before = loadModelPreferences(root);
	expect(before.models).toEqual({ [standard]: "prefer", [contributor]: "allow", "openai/luna": "exclude" });
	await expect(saveModelPreferences(root, { [standard]: "exclude", bad: "allow" })).rejects.toThrow(
		"Invalid model preferences",
	);
	expect(loadModelPreferences(root)).toEqual(before);
});

test("operator selections save directly for every model; agents cannot change them", async () => {
	const root = await mkdtemp(join(tmpdir(), "neta-bulk-selection-"));
	roots.push(root);
	const previous = process.env.NETA_DIR;
	process.env.NETA_DIR = root;
	const ctx = {} as NodeContext;
	const operator = { client: "desktop" } as Connection;
	try {
		await saveModelPreference(root, standard, "prefer");
		const models = { [standard]: "exclude" as const, [contributor]: "allow" as const };
		await expect(
			routingHandlers["routing.preferences.save"](ctx, { models }, {
				client: "tools",
			} as Connection),
		).rejects.toThrow("Configure routing");
		expect(loadModelPreferences(root).models).toEqual({ [standard]: "prefer" });
		await routingHandlers["routing.preferences.save"](ctx, { models }, operator);
		expect(loadModelPreferences(root).models).toEqual(models);
		await routingHandlers["routing.preferences.save"](
			ctx,
			{ models: { [standard]: "exclude", [contributor]: "exclude" } },
			operator,
		);
		expect(loadModelPreferences(root).models).toEqual({ [standard]: "exclude", [contributor]: "exclude" });
		await routingHandlers["routing.preferences.save"](ctx, { model: contributor, preference: "prefer" }, operator);
		expect(loadModelPreferences(root).models[contributor]).toBe("prefer");
	} finally {
		if (previous === undefined) delete process.env.NETA_DIR;
		else process.env.NETA_DIR = previous;
	}
});

test("Jev sees only eligible models and explicit user preferences; overrides and fixed mappings cannot bypass exclusions", async () => {
	let preferences = empty as ReturnType<typeof loadModelPreferences>;
	const models = [contributor, standard].map((id) => ({
		id,
		name: id,
		tools: true,
		context: 32768,
		inputPrice: 1,
		outputPrice: 1,
	}));
	const route = createModelRouter({
		preferences: () => preferences,
		apiKey: () => "fixture-key",
		catalog: { load: async () => ({ snapshot: { version: 1, fetchedAt: Date.now(), models }, warnings: [] }) },
		fetcher: Object.assign(
			async (_url: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body));
				const candidate = JSON.parse(body.questions.model.criteria.candidate_0);
				expect(candidate.id).toBe(contributor);
				expect(candidate.userPreference).toBe("prefer");
				expect(candidate).not.toHaveProperty("trainingDisclosure");
				expect(Object.keys(body.questions.model.criteria)).toEqual(["candidate_0", "none"]);
				return Response.json({
					model: "fixture-jev",
					answers: {
						model: {
							type: "choice",
							choice: "candidate_0",
							confidence: 1,
							probabilities: { candidate_0: 1, none: 0 },
						},
					},
				});
			},
			{ preconnect() {} },
		),
	});
	await expect(route({ task: "t", objective: "o", model: contributor }, models)).resolves.toEqual({
		provider: "opencode",
		model: contributor,
	});
	const fixed = await route({ task: "t", objective: "o", effort: 1 }, models, {
		mode: "fixed",
		models: { 1: contributor, 2: contributor, 3: contributor, 4: contributor, 5: contributor },
	});
	expect(fixed.model).toBe(contributor);
	expect(fixed.routing?.warnings).toEqual([]);
	preferences = { version: 1, models: { [contributor]: "prefer", [standard]: "exclude" } };
	await expect(route({ task: "t", objective: "o", model: standard }, models)).rejects.toThrow("excluded");
	await expect(
		route({ task: "t", objective: "o", effort: 1 }, models, {
			mode: "fixed",
			models: { 1: standard, 2: standard, 3: standard, 4: standard, 5: standard },
		}),
	).rejects.toThrow("excluded");
	const selected = await route({ task: "t", objective: "o", effort: 2 }, models);
	expect(selected.model).toBe(contributor);
	expect(selected.routing?.reason).toContain("preferred by you");
	expect(selected.routing?.warnings.join(" ")).not.toContain("train Meta");
});
