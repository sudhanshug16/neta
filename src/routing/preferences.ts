import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../store/files.ts";
import { record } from "./types.ts";

export type ModelPreference = "allow" | "prefer" | "exclude";
export interface ModelPreferences {
	version: 1;
	models: Record<string, ModelPreference>;
}

export function parseModelPreferences(raw: unknown): ModelPreferences {
	const value = record(raw);
	if (
		value.version !== 1 ||
		Object.keys(value).some((key) => !["version", "models"].includes(key)) ||
		!value.models ||
		typeof value.models !== "object" ||
		Array.isArray(value.models) ||
		Object.entries(value.models).some(
			([id, preference]) =>
				!/^\S+\/\S+$/.test(id) ||
				id.length > 300 ||
				typeof preference !== "string" ||
				!["allow", "prefer", "exclude"].includes(preference),
		)
	)
		throw new Error(
			"Invalid model preferences. Use version 1 and exact model IDs mapped to allow, prefer, or exclude.",
		);
	return { version: 1, models: { ...value.models } as Record<string, ModelPreference> };
}

export function loadModelPreferences(root: string): ModelPreferences {
	try {
		return parseModelPreferences(JSON.parse(readFileSync(join(root, "model-preferences.json"), "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, models: {} };
		throw new Error("Cannot read model-preferences.json. Repair it before routing; no model was selected.");
	}
}

export function modelPreference(preferences: ModelPreferences, id: string): ModelPreference {
	return preferences.models[id] ?? "allow";
}

export function requireAllowedModel(preferences: ModelPreferences, id: string): void {
	if (modelPreference(preferences, id) === "exclude")
		throw new Error(`Model ${id} is excluded. Change Model preferences in /routing; no substitute was launched.`);
}

// Operator changes serialize so two UI requests cannot overwrite one another.
let saving: Promise<unknown> = Promise.resolve();
export function saveModelPreference(root: string, id: string, preference: ModelPreference): Promise<ModelPreferences> {
	return saveModelPreferences(root, { [id]: preference });
}

export function saveModelPreferences(
	root: string,
	changes: Record<string, ModelPreference>,
): Promise<ModelPreferences> {
	const next = saving
		.catch(() => undefined)
		.then(async () => {
			parseModelPreferences({ version: 1, models: changes });
			const current = loadModelPreferences(root);
			const updated: ModelPreferences = { version: 1, models: { ...current.models, ...changes } };
			await writeJsonAtomic(join(root, "model-preferences.json"), updated);
			return updated;
		});
	saving = next;
	return next;
}
