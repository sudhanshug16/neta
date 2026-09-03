export interface ModelOption {
	id: string;
	name: string;
}

// Which wire shape the provider speaks.
export type ModelSource = "config" | "legacy" | "none";

export interface ModelState {
	source: ModelSource;
	current?: string;
	options: ModelOption[];
	// The config option id carrying the model for `config` sources (the
	// entry's `id`); absent otherwise. Not in the plan's contract, which has
	// no other channel from `modelStateFrom` to the `session/set_config_option`
	// call `planModel` must build.
	configId?: string;
}

export type ModelCall =
	| { method: "session/set_model"; params: { modelId: string } }
	| { method: "session/set_config_option"; params: { configId: string; value: string } };

export interface ModelPlan {
	model?: string;
	call?: ModelCall;
}

export class ForbiddenModelError extends Error {
	readonly model: string;

	constructor(model: string) {
		super(`forbidden model: ${model}`);
		this.name = "ForbiddenModelError";
		this.model = model;
	}
}

export class UnknownModelError extends Error {
	readonly model: string;
	readonly options: ModelOption[];

	constructor(model: string, options: ModelOption[]) {
		super(`unknown model: ${model}`);
		this.name = "UnknownModelError";
		this.model = model;
		this.options = options;
	}
}

interface ConfigOptionLike {
	id?: unknown;
	category?: unknown;
	type?: unknown;
	name?: unknown;
	currentValue?: unknown;
	options?: unknown;
}

interface ModelListLike {
	availableModels?: unknown;
	currentModelId?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function selectValues(entry: ConfigOptionLike): ModelOption[] {
	if (!Array.isArray(entry.options)) {
		return [];
	}
	const out: ModelOption[] = [];
	for (const item of entry.options) {
		if (isRecord(item) && typeof item.value === "string") {
			out.push({ id: item.value, name: typeof item.name === "string" ? item.name : item.value });
		}
	}
	return out;
}

// Reads a `session/new` or `session/resume` response: a `configOptions` entry
// with `category === "model"` wins (source `config`), else
// `models.availableModels` with `currentModelId` (`legacy`), else `none`.
export function modelStateFrom(response: unknown): ModelState {
	if (isRecord(response)) {
		const configOptions = response.configOptions;
		if (Array.isArray(configOptions)) {
			for (const entry of configOptions) {
				if (!isRecord(entry)) {
					continue;
				}
				const like = entry as ConfigOptionLike;
				if (like.category === "model" && like.type === "select" && typeof like.id === "string") {
					return {
						source: "config",
						current: typeof like.currentValue === "string" ? like.currentValue : undefined,
						options: selectValues(like),
						configId: like.id,
					};
				}
			}
		}
		const models = response.models;
		if (isRecord(models)) {
			const like = models as unknown as ModelListLike;
			if (Array.isArray(like.availableModels)) {
				const options: ModelOption[] = [];
				for (const item of like.availableModels) {
					if (isRecord(item) && typeof item.modelId === "string") {
						options.push({ id: item.modelId, name: item.modelId });
					}
				}
				return {
					source: "legacy",
					current: typeof like.currentModelId === "string" ? like.currentModelId : undefined,
					options,
				};
			}
		}
	}
	return { source: "none", options: [] };
}

function firstAllowed(options: ModelOption[], forbidden: readonly string[]): ModelOption | undefined {
	return options.find((option) => !forbidden.includes(option.id));
}

function callFor(state: ModelState, model: string): ModelCall {
	if (state.source === "config") {
		return { method: "session/set_config_option", params: { configId: state.configId ?? "model", value: model } };
	}
	return { method: "session/set_model", params: { modelId: model } };
}

export function planModel(s: ModelState, wanted: string | undefined, forbidden: readonly string[]): ModelPlan {
	if (s.source === "none") {
		return {};
	}
	if (wanted !== undefined && forbidden.includes(wanted)) {
		throw new ForbiddenModelError(wanted);
	}
	if (wanted === undefined) {
		if (s.current !== undefined && !forbidden.includes(s.current)) {
			return { model: s.current };
		}
		if (s.current !== undefined) {
			const next = firstAllowed(s.options, forbidden);
			if (next === undefined) {
				throw new ForbiddenModelError(s.current);
			}
			return { model: next.id, call: callFor(s, next.id) };
		}
		return {};
	}
	if (wanted === s.current) {
		return { model: wanted };
	}
	if (s.options.some((option) => option.id === wanted)) {
		return { model: wanted, call: callFor(s, wanted) };
	}
	throw new UnknownModelError(wanted, s.options);
}
