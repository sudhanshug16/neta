import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachPublicAI, createCatalog, parseModelFacts } from "../src/routing/catalog.ts";
import { loadRoutingConfig, parseRoutingConfig } from "../src/routing/config.ts";
import { createModelRouter } from "../src/routing/router.ts";
import type { CatalogSnapshot, Effort, ModelFacts, RoutingConfig, Scope } from "../src/routing/types.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temp() {
	const root = await mkdtemp(join(tmpdir(), "neta-routing-"));
	roots.push(root);
	return root;
}
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const fixed: RoutingConfig = {
	mode: "fixed",
	models: { 1: "openai/luna", 2: "openai/luna", 3: "openai/terra", 4: "openai/terra", 5: "openai/astra" },
};
const models: ModelFacts[] = ["luna", "terra", "astra"].map((name, i) => ({
	id: `openai/${name}`,
	name,
	tools: true,
	inputPrice: i + 1,
	outputPrice: i + 2,
	context: 32_768,
	reference: { source: "models.dev", fetchedAt: NOW },
}));
const snapshot: CatalogSnapshot = { version: 1, fetchedAt: NOW, models };
function fakeFetch(fn: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
	return Object.assign(async (input: string | URL | Request, init?: RequestInit) => fn(String(input), init), {
		preconnect() {},
	});
}
function result(keys: string[], choice = keys[0], confidence = 0.95) {
	return {
		model: "jev-1.13.0",
		answers: {
			model: {
				type: "choice",
				choice,
				confidence,
				probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
			},
		},
	};
}
function routerFixture(answer?: (keys: string[]) => unknown) {
	let catalogCalls = 0;
	const requests: {
		state: { effort: number; task: string; mission: string };
		questions: { model: { criteria: Record<string, string> } };
	}[] = [];
	const route = createModelRouter({
		catalog: {
			load: async () => {
				catalogCalls++;
				return { snapshot, warnings: [] };
			},
		},
		apiKey: () => "test-only",
		now: () => NOW,
		fetcher: fakeFetch((_url, init) => {
			const body = JSON.parse(String(init?.body));
			requests.push(body);
			const keys = Object.keys(body.questions.model.criteria);
			return Response.json(answer ? answer(keys) : result(keys));
		}),
	});
	return { route, requests, catalogCalls: () => catalogCalls };
}
const task = { task: "Confirm startup", objective: "Response check", effort: 1 as const };

test("fixed config requires all five exact IDs, preserves repeats, and rejects typos", () => {
	expect(parseRoutingConfig(fixed)).toEqual(fixed);
	for (const value of [
		{ mode: "local" },
		{ mode: "fixed", models: { 1: "luna" } },
		{ ...fixed, fallbacks: true },
		{ mode: "jev", maxReferencePrice: -1 },
		{ mode: "jev", model: " " },
	])
		expect(() => parseRoutingConfig(value)).toThrow();
});

test("workspace config replaces user config; changes reload and invalid JSON never changes mode", async () => {
	const root = await temp();
	const workspace = join(root, "workspace");
	await mkdir(join(workspace, ".neta"), { recursive: true });
	expect(loadRoutingConfig(root, workspace)).toEqual({ mode: "jev" });
	await writeFile(join(root, "routing.json"), JSON.stringify(fixed));
	expect(loadRoutingConfig(root, workspace)).toEqual(fixed);
	await writeFile(join(workspace, ".neta/routing.json"), '{"mode":"jev"}');
	expect(loadRoutingConfig(root, workspace).mode).toBe("jev");
	await writeFile(join(workspace, ".neta/routing.json"), '{"mode":"broken"}');
	expect(() => loadRoutingConfig(root, workspace)).toThrow("Invalid Neta routing config");
	await writeFile(join(workspace, ".neta/routing.json"), "bad JSON");
	expect(() => loadRoutingConfig(root, workspace)).toThrow("Invalid Neta routing config");
});

test("fixed mapping routes all five efforts with no metadata or classifier access", async () => {
	const f = routerFixture();
	for (const effort of [1, 2, 3, 4, 5] as Effort[]) {
		const chosen = await f.route({ ...task, effort }, models, fixed);
		expect(chosen.model).toBe(fixed.models[effort]);
		expect(chosen.routing?.method).toBe("fixed");
	}
	expect(f.catalogCalls()).toBe(0);
	expect(f.requests).toHaveLength(0);
	await expect(f.route(task, [{ id: "openai/astra" }], fixed)).rejects.toThrow("no substitute");
});

test("explicit overrides bypass effort, config, cache and Jev but require a connected ID", async () => {
	const route = createModelRouter({
		catalog: {
			load: async () => {
				throw new Error("must not load");
			},
		},
		config: () => {
			throw new Error("must not load");
		},
	});
	expect(await route({ task: "x", objective: "y", model: "openai/astra" }, models)).toEqual({
		provider: "opencode",
		model: "openai/astra",
	});
	expect((await route({ task: "x", objective: "y", model: "luna", provider: "openai" }, models)).model).toBe(
		"openai/luna",
	);
	await expect(route({ ...task, model: "missing" }, models)).rejects.toThrow("no substitute");
});

test("missing effort or key never inherits a model or invokes metadata services", async () => {
	let loaded = false;
	const route = createModelRouter({
		catalog: {
			load: async () => {
				loaded = true;
				return { snapshot, warnings: [] };
			},
		},
	});
	await expect(route({ task: "x", objective: "y" }, models)).rejects.toThrow("requires effort");
	await expect(route(task, models)).rejects.toThrow("TYPESAFE_API_KEY");
	expect(loaded).toBe(false);
});

test("Jev receives task, objective, difficulty and only eligible connected metadata", async () => {
	const f = routerFixture();
	const selected = await f.route(task, [{ id: "openai/luna" }, { id: "unmatched/model" }]);
	expect(selected.model).toBe("openai/luna");
	expect(selected.routing?.method).toBe("jev");
	expect(selected.routing?.facts?.reference?.source).toBe("models.dev");
	expect(f.requests[0].state).toMatchObject({ effort: 1, task: task.task, mission: task.objective });
	expect(Object.keys(f.requests[0].questions.model.criteria)).toEqual(["candidate_0", "none"]);
	expect(selected.routing?.warnings.join(" ")).toContain("unknown capability");
	expect(f.catalogCalls()).toBe(1);
	expect(f.requests).toHaveLength(1);
});

test("explicit abstention is distinguished from low-confidence selection", async () => {
	await expect(
		routerFixture((keys) => result(keys, "none", 0.2)).route({ ...task, effort: 2 }, models),
	).rejects.toThrow(
		"explicitly returned no suitable model for effort 2 among 3 eligible connected models (0 with PublicAI scores; classification confidence 0.200)",
	);
	const f = routerFixture((keys) => {
		const value = result(keys, "candidate_1", 0.2);
		value.answers.model.probabilities = { candidate_0: 0.25, candidate_1: 0.38, candidate_2: 0.35, none: 0.02 };
		return value;
	});
	const selected = await f.route({ ...task, effort: 2 }, models);
	expect(selected.model).toBe("openai/luna");
	expect(selected.routing?.confidence).toBe(0.2);
	expect(selected.routing?.warnings.join(" ")).toContain("highest-ranked option among 3 candidates");
	expect(selected.routing?.warnings.join(" ")).toContain("low classification confidence (0.200)");
	expect(f.requests).toHaveLength(1);
});

test("Jev receives the previous model and direction when adjusting existing effort", async () => {
	const f = routerFixture();
	const adjustment = { previousModel: "openai/luna", previousEffort: 2 as const, direction: "up" as const };
	await f.route({ ...task, effort: 3, adjustment }, models);
	expect(f.requests[0].state).toMatchObject({ effort: 3, adjustment });
	expect(f.requests).toHaveLength(1);
});

function mismatched(keys: string[], choice = "candidate_0") {
	const value = result(keys, choice);
	value.answers.model.probabilities = { candidate_0: 0.1, candidate_1: 0.7, candidate_2: 0.2, none: 0 };
	return value;
}

test("only an otherwise valid ranking mismatch retries the identical request and records recovery", async () => {
	const requests: { body: string; signal: AbortSignal; authorization: string }[] = [];
	const route = createModelRouter({
		apiKey: () => "secret-key",
		catalog: { load: async () => ({ snapshot, warnings: [] }) },
		fetcher: fakeFetch((_url, init) => {
			const body = String(init?.body);
			requests.push({
				body,
				signal: init?.signal as AbortSignal,
				authorization: String(new Headers(init?.headers).get("Authorization")),
			});
			const keys = Object.keys(JSON.parse(body).questions.model.criteria);
			return Response.json(requests.length === 1 ? mismatched(keys) : result(keys, "candidate_2"));
		}),
	});
	const selected = await route(task, models);
	expect(selected.model).toBe("openai/terra");
	expect(requests).toHaveLength(2);
	expect(requests[0].body).toBe(requests[1].body);
	expect(requests[0].signal).toBe(requests[1].signal);
	expect(requests[0].authorization).toBe(requests[1].authorization);
	expect(selected.routing?.warnings.join(" ")).toContain("first choice disagreed with its probability ranking");
	expect(selected.routing?.warnings.join(" ")).toContain("second identical classification request");
});

test("two ranking mismatches refuse launch with mapped bounded diagnostics, never raw response data", async () => {
	let calls = 0;
	const route = createModelRouter({
		apiKey: () => "secret-key",
		catalog: { load: async () => ({ snapshot, warnings: [] }) },
		fetcher: fakeFetch((_url, init) => {
			calls++;
			const keys = Object.keys(JSON.parse(String(init?.body)).questions.model.criteria);
			return Response.json({ ...mismatched(keys), model: "secret-upstream-model", raw: "secret-raw-payload" });
		}),
	});
	let error = "";
	try {
		await route(task, models);
	} catch (cause) {
		error = String(cause);
	}
	expect(calls).toBe(2);
	expect(error).toContain("first: chosen openai/astra (0.100000), highest openai/luna (0.700000)");
	expect(error).toContain("second: chosen openai/astra (0.100000), highest openai/luna (0.700000)");
	expect(error).toContain("requested classifier model jev-1.13.0");
	expect(error).toContain("no agent was launched");
	expect(error).not.toContain("secret-");
	expect(error).not.toContain(task.task);
});

test("diagnostics discard unsafe eligible IDs and untrusted classifier model strings", async () => {
	const unsafe = [{ ...models[0], id: "openai/secret-key\nraw" }, models[1], models[2]];
	let calls = 0;
	const route = createModelRouter({
		apiKey: () => "secret-key",
		catalog: { load: async () => ({ snapshot: { ...snapshot, models: unsafe }, warnings: [] }) },
		fetcher: fakeFetch((_url, init) => {
			calls++;
			const keys = Object.keys(JSON.parse(String(init?.body)).questions.model.criteria);
			return Response.json({ ...mismatched(keys), model: "secret-model\nraw", extra: "secret-body" });
		}),
	});
	let error = "";
	try {
		await route(task, unsafe);
	} catch (cause) {
		error = String(cause);
	}
	expect(calls).toBe(2);
	expect(error).toContain("highest candidate_1 (0.700000)");
	expect(error).not.toContain("secret-");
	expect(error).not.toContain("raw");
});

test("abstention, excluded choices, malformed probabilities and HTTP errors never retry", async () => {
	for (const answer of [
		(keys: string[]) => result(keys, "none"),
		(keys: string[]) => mismatched(keys, "none"),
		(keys: string[]) => mismatched(keys, "excluded/model"),
		(keys: string[]) => ({
			...mismatched(keys),
			answers: { model: { ...mismatched(keys).answers.model, probabilities: { candidate_0: 0.1 } } },
		}),
	]) {
		let calls = 0;
		const route = createModelRouter({
			apiKey: () => "test-only",
			catalog: { load: async () => ({ snapshot, warnings: [] }) },
			fetcher: fakeFetch((_url, init) => {
				calls++;
				return Response.json(answer(Object.keys(JSON.parse(String(init?.body)).questions.model.criteria)));
			}),
		});
		await expect(route(task, models)).rejects.toThrow("no agent was launched");
		expect(calls).toBe(1);
	}
	for (const status of [401, 429]) {
		let calls = 0;
		const route = createModelRouter({
			apiKey: () => "test-only",
			catalog: { load: async () => ({ snapshot, warnings: [] }) },
			fetcher: fakeFetch(() => {
				calls++;
				return new Response("secret-raw", { status });
			}),
		});
		await expect(route(task, models)).rejects.toThrow(`HTTP ${status}`);
		expect(calls).toBe(1);
	}
});

test("near ties within epsilon and low-confidence valid choices do not retry", async () => {
	const f = routerFixture((keys) => {
		const value = result(keys, "candidate_0", 0.2);
		value.answers.model.probabilities = { candidate_0: 0.3, candidate_1: 0.3000000005, candidate_2: 0.2, none: 0.2 };
		return value;
	});
	const selected = await f.route(task, models);
	expect(selected.model).toBe("openai/astra");
	expect(selected.routing?.warnings.join(" ")).toContain("low classification confidence");
	expect(f.requests).toHaveLength(1);
});

test("classifier sees all eligible models, not only the five cheapest", async () => {
	let count = 0;
	const many = Array.from({ length: 8 }, (_, i) => ({ ...models[0], id: `openai/model-${i}` }));
	const route = createModelRouter({
		apiKey: () => "test-only",
		catalog: { load: async () => ({ snapshot: { ...snapshot, models: many }, warnings: [] }) },
		fetcher: fakeFetch((_url, init) => {
			const keys = Object.keys(JSON.parse(String(init?.body)).questions.model.criteria);
			count = keys.length;
			return Response.json(result(keys, "candidate_7"));
		}),
	});
	expect((await route({ ...task, effort: 5 }, many)).model).toBe("openai/model-7");
	expect(count).toBe(9);
});

test("Jev abstention and malformed replies stop launch rather than falling back", async () => {
	const replies = [
		(keys: string[]) => result(keys, "none"),
		(keys: string[]) => result(keys, "other/model"),
		(keys: string[]) => result(keys, "__proto__"),
		(keys: string[]) => result(keys, keys[0], 2),
		() => ({
			answers: {
				model: { type: "choice", choice: "candidate_0", confidence: 1, probabilities: { candidate_0: 0.5 } },
			},
		}),
		(keys: string[]) => {
			const value = result(keys);
			value.answers.model.probabilities[keys[0]] = 0;
			value.answers.model.probabilities.none = 1;
			return value;
		},
	];
	for (const answer of replies)
		await expect(routerFixture(answer).route(task, models)).rejects.toThrow("no agent was launched");
});

test("Jev transport and JSON failures expose no response body or credentials", async () => {
	for (const fetcher of [
		fakeFetch(() => {
			throw new Error("secret-body");
		}),
		fakeFetch(() => new Response("secret-body")),
		fakeFetch(() => new Response("secret-body", { status: 401 })),
	]) {
		const route = createModelRouter({
			apiKey: () => "secret-key",
			catalog: { load: async () => ({ snapshot, warnings: [] }) },
			fetcher,
		});
		try {
			await route(task, models);
			throw new Error("expected failure");
		} catch (error) {
			expect(String(error)).not.toContain("secret-");
			expect(String(error).toLowerCase()).toContain("no agent was launched");
		}
	}
});

test("Jev rate limits honor Retry-After and allow explicit choices during backoff", async () => {
	let at = NOW;
	let requests = 0;
	const route = createModelRouter({
		apiKey: () => "test-only",
		now: () => at,
		catalog: { load: async () => ({ snapshot, warnings: [] }) },
		fetcher: fakeFetch(() => {
			requests++;
			return new Response("", { status: 429, headers: { "retry-after": "120" } });
		}),
	});
	await expect(route(task, models)).rejects.toThrow("429");
	await expect(route(task, models)).rejects.toThrow("rate limited");
	expect(requests).toBe(1);
	expect((await route({ ...task, model: "openai/luna" }, models)).model).toBe("openai/luna");
	at += 120_001;
	await expect(route(task, models)).rejects.toThrow("429");
	expect(requests).toBe(2);
});

const rawModels = {
	openai: {
		models: { luna: { name: "Luna", tool_call: true, limit: { context: 32000 }, cost: { input: 1, output: 2 } } },
	},
};
function publicAI(scope: Scope, score = 80) {
	return {
		generatedAt: new Date(NOW).toISOString(),
		models: [
			{
				id: `${scope}-variant`,
				access: { recommended: { model: "openai/luna" } },
				ranked: true,
				rankedInScope: true,
				index: score,
				scopeScore: score,
				covered: 3,
				agreement: "high",
			},
		],
	};
}

test("PublicAI replacements clear missing/unranked metrics and preserve separate provenance", () => {
	const facts = parseModelFacts(rawModels, NOW);
	attachPublicAI(facts, publicAI("coding", 80), "coding", NOW);
	attachPublicAI(facts, publicAI("agents", 70), "agents", NOW + 10);
	expect(facts[0].measurements?.coding).toMatchObject({ score: 80, id: "coding-variant", fetchedAt: NOW });
	expect(facts[0].measurements?.agents).toMatchObject({ score: 70, id: "agents-variant", fetchedAt: NOW + 10 });
	const unranked = publicAI("coding");
	unranked.models[0].rankedInScope = false;
	attachPublicAI(facts, unranked, "coding", NOW + 20);
	expect(facts[0].measurements?.coding).toBeUndefined();
	expect(facts[0].measurements?.agents?.score).toBe(70);
	attachPublicAI(facts, { generatedAt: new Date(NOW).toISOString(), models: [] }, "agents", NOW + 20);
	expect(facts[0].measurements?.agents).toBeUndefined();
});

test("ambiguous benchmark variants are unknown; malformed snapshots do not erase old metrics", () => {
	const facts = parseModelFacts(rawModels, NOW);
	const data = publicAI("coding");
	attachPublicAI(facts, data, "coding", NOW);
	expect(() => attachPublicAI(facts, { models: [] }, "coding", NOW)).toThrow();
	expect(facts[0].measurements?.coding?.score).toBe(80);
	data.models.push({ ...data.models[0], id: "other-variant" });
	attachPublicAI(facts, data, "coding", NOW);
	expect(facts[0].measurements?.coding).toBeUndefined();
});

test("catalog shares concurrent refreshes, caches hourly, and successful empty snapshots replace old scores", async () => {
	const root = await temp();
	let at = NOW;
	let calls = 0;
	let empty = false;
	const fetcher = fakeFetch((url) => {
		calls++;
		if (url.includes("models.dev")) return Response.json(rawModels);
		expect(url).toContain("reports=false");
		expect(url).toContain("limit=100");
		const scope = new URL(url).searchParams.get("scope") as Scope;
		return Response.json(empty ? { ...publicAI(scope), models: [] } : publicAI(scope));
	});
	const catalog = createCatalog({ cachePath: join(root, "cache.json"), fetcher, now: () => at });
	const [first, second] = await Promise.all([catalog.load(), catalog.load()]);
	expect(calls).toBe(4);
	expect(first).toEqual(second);
	await catalog.load();
	expect(calls).toBe(4);
	at += HOUR;
	empty = true;
	const next = await catalog.load();
	expect(calls).toBe(8);
	expect(next.snapshot.models[0].measurements).toEqual({});
});

test("PublicAI backoff preserves original dates, does not block prices, and expires stale scores", async () => {
	const root = await temp();
	let at = NOW;
	let limited = false;
	let publicCalls = 0;
	let modelCalls = 0;
	const catalog = createCatalog({
		cachePath: join(root, "cache.json"),
		now: () => at,
		fetcher: fakeFetch((url) => {
			if (url.includes("models.dev")) {
				modelCalls++;
				return Response.json(rawModels);
			}
			publicCalls++;
			if (limited) return new Response("", { status: 429, headers: { "retry-after": "7200" } });
			return Response.json(publicAI(new URL(url).searchParams.get("scope") as Scope));
		}),
	});
	await catalog.load();
	limited = true;
	at += HOUR;
	const stale = await catalog.load();
	expect(publicCalls).toBe(4);
	expect(stale.snapshot.models[0].measurements?.coding?.fetchedAt).toBe(NOW);
	expect(stale.warnings.join(" ")).toContain("original dates");
	at += HOUR;
	await catalog.load();
	expect(modelCalls).toBe(3);
	expect(publicCalls).toBe(4);
	at += 24 * HOUR;
	const expired = await catalog.load();
	expect(expired.snapshot.models[0].measurements).toEqual({});
});

test("malformed cache is ignored and expired reference metadata cannot route", async () => {
	const root = await temp();
	const path = join(root, "cache.json");
	await writeFile(path, JSON.stringify({ ...snapshot, warnings: "not-an-array" }));
	let calls = 0;
	const fail = fakeFetch(() => {
		calls++;
		throw new Error("offline");
	});
	const invalid = await createCatalog({ cachePath: path, fetcher: fail, now: () => NOW }).load();
	expect(invalid.snapshot.models).toEqual([]);
	expect(calls).toBe(1);
	await writeFile(path, JSON.stringify(snapshot));
	const stale = await createCatalog({ cachePath: path, fetcher: fail, now: () => NOW + 25 * HOUR }).load();
	expect(stale.snapshot.models).toEqual([]);
	expect(stale.warnings.join(" ")).toContain("older than 24 hours");
});
