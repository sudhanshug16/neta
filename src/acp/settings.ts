import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Access } from "../core/types.ts";

export interface ProviderSettings {
	command: string;
	args: string[];
	env?: Record<string, string>;
	readOnlyArgs?: string[];
	readWriteArgs?: string[];
	resume: boolean;
	defaultModel: string;
	disabled?: boolean;
}

export interface Settings {
	providers: Record<string, ProviderSettings>;
	leader: { provider: string; model?: string };
	forbiddenModels: string[];
}

export interface PartialSettings {
	providers?: Record<string, Partial<ProviderSettings>>;
	leader?: Partial<Settings["leader"]>;
	forbiddenModels?: string[];
}

export const DEFAULT_PROVIDERS: Record<string, ProviderSettings> = {
	claude: {
		command: "npx",
		args: ["-y", "@agentclientprotocol/claude-agent-acp@0.68.0"],
		readOnlyArgs: [],
		readWriteArgs: [],
		resume: true,
		defaultModel: "sonnet",
	},
	codex: {
		command: "npx",
		args: ["-y", "@agentclientprotocol/codex-acp@1.3.0"],
		readOnlyArgs: ["-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"'],
		readWriteArgs: ["-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"'],
		resume: true,
		defaultModel: "gpt-5.6-terra[medium]",
	},
	opencode: {
		command: "opencode",
		args: ["acp"],
		readOnlyArgs: [],
		readWriteArgs: [],
		resume: true,
		defaultModel: "",
	},
};

export const DEFAULT_SETTINGS: Settings = {
	providers: DEFAULT_PROVIDERS,
	leader: { provider: "claude" },
	forbiddenModels: [],
};

function copyEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
	return env === undefined ? undefined : { ...env };
}

function mergeProvider(base: ProviderSettings | undefined, patch: Partial<ProviderSettings>): ProviderSettings {
	return {
		command: patch.command ?? base?.command ?? "",
		args: [...(patch.args ?? base?.args ?? [])],
		env: copyEnv(patch.env ?? base?.env),
		readOnlyArgs: patch.readOnlyArgs === undefined ? base?.readOnlyArgs : [...patch.readOnlyArgs],
		readWriteArgs: patch.readWriteArgs === undefined ? base?.readWriteArgs : [...patch.readWriteArgs],
		resume: patch.resume ?? base?.resume ?? true,
		defaultModel: patch.defaultModel ?? base?.defaultModel ?? "",
		disabled: patch.disabled ?? base?.disabled,
	};
}

// Field by field per provider; arrays (and env) replace, never concatenate;
// new providers are added. A merged provider with no command is invalid and
// dropped by `loadSettings` with a warning.
export function mergeSettings(base: Settings, patch: PartialSettings): Settings {
	const providers: Record<string, ProviderSettings> = {};
	for (const [name, provider] of Object.entries(base.providers)) {
		providers[name] = mergeProvider(provider, {});
	}
	for (const [name, provider] of Object.entries(patch.providers ?? {})) {
		providers[name] = mergeProvider(providers[name], provider);
	}
	return {
		providers,
		leader: { ...base.leader, ...patch.leader },
		forbiddenModels: patch.forbiddenModels === undefined ? [...base.forbiddenModels] : [...patch.forbiddenModels],
	};
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringMap(value: unknown): value is Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every((entry) => typeof entry === "string");
}

// Validate one layer; a wrong-typed field is dropped with a warning, never a
// throw. Returns the surviving patch.
function validateLayer(raw: unknown, where: string, warnings: string[]): PartialSettings {
	const patch: PartialSettings = {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warnings.push(`${where}: expected an object, ignoring`);
		return patch;
	}
	const layer = raw as Record<string, unknown>;
	if (layer.providers !== undefined) {
		if (typeof layer.providers !== "object" || layer.providers === null || Array.isArray(layer.providers)) {
			warnings.push(`${where}: providers is not an object, ignoring`);
		} else {
			const providers: Record<string, Partial<ProviderSettings>> = {};
			for (const [name, entry] of Object.entries(layer.providers as Record<string, unknown>)) {
				if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
					warnings.push(`${where}: provider ${name} is not an object, ignoring`);
					continue;
				}
				const fields = entry as Record<string, unknown>;
				const kept: Partial<ProviderSettings> = {};
				if (fields.command !== undefined) {
					if (isString(fields.command)) {
						kept.command = fields.command;
					} else {
						warnings.push(`${where}: provider ${name} command is not a string, ignoring`);
					}
				}
				if (fields.args !== undefined) {
					if (isStringArray(fields.args)) {
						kept.args = fields.args;
					} else {
						warnings.push(`${where}: provider ${name} args is not a string array, ignoring`);
					}
				}
				if (fields.env !== undefined) {
					if (isStringMap(fields.env)) {
						kept.env = fields.env;
					} else {
						warnings.push(`${where}: provider ${name} env is not a string map, ignoring`);
					}
				}
				for (const key of ["readOnlyArgs", "readWriteArgs"] as const) {
					if (fields[key] !== undefined) {
						if (isStringArray(fields[key])) {
							kept[key] = fields[key] as string[];
						} else {
							warnings.push(`${where}: provider ${name} ${key} is not a string array, ignoring`);
						}
					}
				}
				if (fields.resume !== undefined) {
					if (typeof fields.resume === "boolean") {
						kept.resume = fields.resume;
					} else {
						warnings.push(`${where}: provider ${name} resume is not a boolean, ignoring`);
					}
				}
				if (fields.defaultModel !== undefined) {
					if (isString(fields.defaultModel)) {
						kept.defaultModel = fields.defaultModel;
					} else {
						warnings.push(`${where}: provider ${name} defaultModel is not a string, ignoring`);
					}
				}
				if (fields.disabled !== undefined) {
					if (typeof fields.disabled === "boolean") {
						kept.disabled = fields.disabled;
					} else {
						warnings.push(`${where}: provider ${name} disabled is not a boolean, ignoring`);
					}
				}
				providers[name] = kept;
			}
			patch.providers = providers;
		}
	}
	if (layer.leader !== undefined) {
		if (typeof layer.leader !== "object" || layer.leader === null || Array.isArray(layer.leader)) {
			warnings.push(`${where}: leader is not an object, ignoring`);
		} else {
			const leader = layer.leader as Record<string, unknown>;
			const kept: Partial<Settings["leader"]> = {};
			if (leader.provider !== undefined) {
				if (isString(leader.provider)) {
					kept.provider = leader.provider;
				} else {
					warnings.push(`${where}: leader provider is not a string, ignoring`);
				}
			}
			if (leader.model !== undefined) {
				if (isString(leader.model)) {
					kept.model = leader.model;
				} else {
					warnings.push(`${where}: leader model is not a string, ignoring`);
				}
			}
			patch.leader = kept;
		}
	}
	if (layer.forbiddenModels !== undefined) {
		if (isStringArray(layer.forbiddenModels)) {
			patch.forbiddenModels = layer.forbiddenModels;
		} else {
			warnings.push(`${where}: forbiddenModels is not a string array, ignoring`);
		}
	}
	return patch;
}

function readLayer(path: string, warnings: string[]): PartialSettings {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}, ignoring`);
		return {};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text) as unknown;
	} catch {
		warnings.push(`${path}: bad JSON, ignoring`);
		return {};
	}
	return validateLayer(raw, path, warnings);
}

// `<netaDir>/settings.json`, then `<workspaceRoot>/.neta/settings.json`; the
// workspace layer wins. Missing files are fine; anything unparsable is
// dropped with a warning and the lower layer survives.
export function loadSettings(o: { netaDir: string; workspaceRoot?: string }): {
	settings: Settings;
	warnings: string[];
} {
	const warnings: string[] = [];
	let settings = mergeSettings(DEFAULT_SETTINGS, {});
	const layers = [join(o.netaDir, "settings.json")];
	if (o.workspaceRoot !== undefined) {
		layers.push(join(o.workspaceRoot, ".neta", "settings.json"));
	}
	for (const path of layers) {
		settings = mergeSettings(settings, readLayer(path, warnings));
	}
	// A merged provider with no command or args cannot launch: drop it.
	for (const [name, provider] of Object.entries(settings.providers)) {
		if (provider.command === "" || provider.args.length === 0) {
			delete settings.providers[name];
			warnings.push(`provider ${name} has no command or args, ignoring`);
		}
	}
	return { settings, warnings };
}

export class UnknownProviderError extends Error {
	readonly provider: string;

	constructor(provider: string) {
		super(`unknown or disabled provider: ${provider}`);
		this.name = "UnknownProviderError";
		this.provider = provider;
	}
}

export function providerFor(s: Settings, name: string): ProviderSettings {
	const provider = s.providers[name];
	if (provider === undefined || provider.disabled === true) {
		throw new UnknownProviderError(name);
	}
	return provider;
}

export function launchArgs(p: ProviderSettings, access: Access): string[] {
	const extra = access === "readOnly" ? (p.readOnlyArgs ?? []) : (p.readWriteArgs ?? []);
	return [...p.args, ...extra];
}

export function isForbiddenModel(s: Settings, model: string): boolean {
	return s.forbiddenModels.includes(model);
}
