import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type CatalogSnapshot, finite, type Measurement, type ModelFacts, record, type Scope } from "./types.ts";

const HOUR = 3_600_000;
const MAX_STALE = 24 * HOUR;
const SCOPES: Scope[] = ["coding", "agents", "overall"];

export function parseModelFacts(raw: unknown, fetchedAt: number): ModelFacts[] {
	const models: ModelFacts[] = [];
	for (const [providerId, provider] of Object.entries(record(raw))) {
		for (const [modelId, value] of Object.entries(record(record(provider).models))) {
			const model = record(value);
			if (typeof model.name !== "string" || !model.name.trim() || model.status === "deprecated") continue;
			const cost = record(model.cost);
			models.push({
				id: `${providerId}/${modelId}`,
				name: model.name,
				inputPrice: finite(cost.input),
				outputPrice: finite(cost.output),
				context: finite(record(model.limit).context),
				tools: typeof model.tool_call === "boolean" ? model.tool_call : undefined,
				reference: { source: "models.dev", fetchedAt },
			});
		}
	}
	if (!models.length) throw new Error("Model catalog was empty or malformed");
	return models;
}

export function attachPublicAI(models: ModelFacts[], payload: unknown, scope: Scope, fetchedAt: number): void {
	const data = record(payload);
	if (
		!Array.isArray(data.models) ||
		typeof data.generatedAt !== "string" ||
		!Number.isFinite(Date.parse(data.generatedAt))
	)
		throw new Error("Invalid PublicAI snapshot");
	const measurements = new Map<string, Measurement>();
	const seen = new Set<string>();
	for (const value of data.models) {
		const row = record(value);
		const recommended = record(record(row.access).recommended);
		if (typeof recommended.model !== "string" || typeof row.id !== "string") continue;
		const id = recommended.model;
		// Multiple benchmark variants for one callable ID are ambiguous, not interchangeable.
		if (seen.has(id)) {
			measurements.delete(id);
			continue;
		}
		seen.add(id);
		const ranked = scope === "overall" ? row.ranked === true : row.rankedInScope === true;
		const score = finite(scope === "overall" ? row.index : row.scopeScore);
		if (!ranked || score === undefined || score > 100) continue;
		measurements.set(id, {
			source: "PublicAI",
			score,
			generatedAt: data.generatedAt,
			fetchedAt,
			id: row.id,
			covered: finite(row.covered),
			agreement: typeof row.agreement === "string" ? row.agreement : undefined,
		});
	}
	for (const model of models) {
		// A successful snapshot replaces this scope, including missing/unranked rows.
		// Never promote an old value to fresh when a model drops out of the top 100.
		model.measurements = { ...model.measurements };
		delete model.measurements[scope];
		const score =
			measurements.get(model.id) ??
			(model.id.startsWith("openrouter/") ? measurements.get(model.id.slice(11)) : undefined);
		if (score) model.measurements[scope] = score;
	}
}

function validSnapshot(value: unknown, now: number): value is CatalogSnapshot {
	const data = record(value);
	const timestamp = (v: unknown) => finite(v) !== undefined && Number(v) <= now;
	if (
		data.version !== 1 ||
		!timestamp(data.fetchedAt) ||
		!Array.isArray(data.models) ||
		(data.warnings !== undefined &&
			(!Array.isArray(data.warnings) || !data.warnings.every((v) => typeof v === "string")))
	)
		return false;
	const ids = new Set<string>();
	return data.models.every((value: unknown) => {
		const m = record(value);
		if (
			typeof m.id !== "string" ||
			!m.id ||
			ids.has(m.id) ||
			typeof m.name !== "string" ||
			!m.name ||
			(m.tools !== undefined && typeof m.tools !== "boolean") ||
			!["inputPrice", "outputPrice", "context"].every((k) => m[k] === undefined || finite(m[k]) !== undefined)
		)
			return false;
		ids.add(m.id);
		const reference = record(m.reference);
		if (reference.source !== "models.dev" || !timestamp(reference.fetchedAt)) return false;
		if (m.measurements === undefined) return true;
		if (m.measurements === null || typeof m.measurements !== "object" || Array.isArray(m.measurements)) return false;
		return Object.entries(record(m.measurements)).every(([scope, raw]) => {
			const measure = record(raw);
			return (
				SCOPES.includes(scope as Scope) &&
				measure.source === "PublicAI" &&
				finite(measure.score) !== undefined &&
				Number(measure.score) <= 100 &&
				timestamp(measure.fetchedAt) &&
				typeof measure.generatedAt === "string" &&
				Number.isFinite(Date.parse(measure.generatedAt)) &&
				typeof measure.id === "string" &&
				measure.id.length > 0 &&
				(measure.covered === undefined || finite(measure.covered) !== undefined) &&
				(measure.agreement === undefined || typeof measure.agreement === "string")
			);
		});
	});
}

export function createCatalog(options: { cachePath: string; fetcher?: typeof fetch; now?: () => number }) {
	const fetcher = options.fetcher ?? fetch;
	const now = options.now ?? Date.now;
	let snapshot: CatalogSnapshot | undefined;
	let diskRead = false;
	const retryAt = new Map<string, number>();
	let pending: Promise<void> | undefined;
	async function json(url: string, source: string): Promise<unknown> {
		if (now() < (retryAt.get(source) ?? 0)) throw new Error("Metadata source in backoff");
		try {
			const response = await fetcher(url, {
				signal: AbortSignal.timeout(5_000),
				headers: { "User-Agent": "Neta-Model-Router/1.0" },
			});
			if (!response.ok) {
				if (response.status === 429) {
					const header = response.headers.get("retry-after");
					const delay =
						header && Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header ?? "") - now();
					retryAt.set(source, now() + (Number.isFinite(delay) && delay > 0 ? delay : HOUR));
				}
				throw new Error("Metadata request failed");
			}
			return await response.json();
		} catch (error) {
			retryAt.set(source, Math.max(retryAt.get(source) ?? 0, now() + 60_000));
			throw error;
		}
	}
	async function refresh(): Promise<void> {
		if (!diskRead) {
			diskRead = true;
			try {
				const saved: unknown = JSON.parse(await readFile(options.cachePath, "utf8"));
				if (validSnapshot(saved, now())) snapshot = saved;
			} catch {
				/* A missing or invalid cache requires a fresh fetch. */
			}
		}
		if (snapshot && now() >= snapshot.fetchedAt && now() - snapshot.fetchedAt < HOUR) return;
		const warnings: string[] = [];
		let models = structuredClone(snapshot?.models ?? []);
		try {
			const fresh = parseModelFacts(await json("https://models.dev/api.json", "models.dev"), now());
			const previous = new Map(models.map((m) => [m.id, m]));
			for (const model of fresh) {
				const old = previous.get(model.id);
				if (old?.name === model.name) model.measurements = old.measurements;
			}
			models = fresh;
		} catch {
			warnings.push(
				"models.dev refresh failed or is rate limited; cached reference metadata retains its original fetch date.",
			);
		}
		if (models.length) {
			for (const scope of SCOPES) {
				try {
					const data = await json(
						`https://publicai.io/model-index/api?scope=${scope}&reports=false&minBoards=1&limit=100`,
						"PublicAI",
					);
					attachPublicAI(models, data, scope, now());
				} catch {
					warnings.push(
						`PublicAI ${scope} refresh failed or is rate limited; cached measurements retain their original dates.`,
					);
				}
			}
		}
		warnings.push(
			"PublicAI coverage is limited to returned ranked rows; missing or unmatched models remain unscored. Scores may use different agent harnesses or reasoning settings.",
		);
		snapshot = { version: 1, fetchedAt: now(), models, warnings };
		const temporary = `${options.cachePath}.${randomUUID()}.tmp`;
		try {
			await mkdir(dirname(options.cachePath), { recursive: true, mode: 0o700 });
			await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
			await rename(temporary, options.cachePath);
		} catch {
			warnings.push("Model metadata could not be cached on disk.");
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}
	return {
		async load(): Promise<{ snapshot: CatalogSnapshot; warnings: string[] }> {
			pending ??= refresh().finally(() => {
				pending = undefined;
			});
			await pending;
			const result: CatalogSnapshot = structuredClone(snapshot ?? { version: 1, fetchedAt: 0, models: [] });
			const warnings = [...(result.warnings ?? [])];
			result.models = result.models.filter((m) => now() - (m.reference?.fetchedAt ?? 0) <= MAX_STALE);
			if (result.models.length !== snapshot?.models.length)
				warnings.push("Reference metadata older than 24 hours was excluded.");
			for (const model of result.models) {
				for (const scope of SCOPES) {
					const measurement = model.measurements?.[scope];
					if (measurement && now() - measurement.fetchedAt > MAX_STALE) {
						delete model.measurements?.[scope];
						warnings.push(`Expired PublicAI ${scope} measurement excluded for ${model.id}.`);
					}
				}
			}
			return { snapshot: result, warnings };
		},
	};
}
