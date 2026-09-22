import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Effort, finite, type RoutingConfig, record } from "./types.ts";

export function parseRoutingConfig(raw: unknown): RoutingConfig {
	const value = record(raw);
	if (value.mode === "fixed") {
		const models = record(value.models);
		if (
			Object.keys(value).some((key) => !["mode", "models"].includes(key)) ||
			Object.keys(models).length !== 5 ||
			[1, 2, 3, 4, 5].some((level) => typeof models[level] !== "string" || !/^\S+\/\S+$/.test(String(models[level])))
		)
			throw new Error(
				"Fixed routing requires exactly five models, keyed 1 through 5, with exact provider/model IDs.",
			);
		return { mode: "fixed", models: { ...models } as Record<Effort, string> };
	}
	if (
		value.mode !== "jev" ||
		Object.keys(value).some((key) => !["mode", "model", "maxReferencePrice"].includes(key)) ||
		(value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) ||
		(value.maxReferencePrice !== undefined && finite(value.maxReferencePrice) === undefined)
	)
		throw new Error("Routing requires mode 'jev' or 'fixed'; Jev accepts model and a nonnegative maxReferencePrice.");
	return {
		mode: "jev",
		model: value.model as string | undefined,
		maxReferencePrice: value.maxReferencePrice as number | undefined,
	};
}

/** A workspace config replaces the user config as a whole; errors never change modes. */
export function loadRoutingConfig(netaDirectory: string, workspaceRoot?: string): RoutingConfig {
	const paths = [join(netaDirectory, "routing.json")];
	if (workspaceRoot) paths.unshift(join(workspaceRoot, ".neta", "routing.json"));
	for (const path of paths) {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new Error(`Cannot read Neta routing config at ${path}.`);
		}
		try {
			return parseRoutingConfig(JSON.parse(text));
		} catch {
			throw new Error(
				`Invalid Neta routing config at ${path}. Use mode 'jev' or mode 'fixed' with five provider/model IDs; no agent was launched.`,
			);
		}
	}
	return { mode: "jev" };
}
