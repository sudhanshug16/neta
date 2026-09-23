import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Access } from "../core/types.ts";

export interface ProviderSettings {
	command: string;
	args: string[];
	env?: Record<string, string>;
	readOnlyArgs?: string[];
	readWriteArgs?: string[];
	resume: boolean;
	defaultModel: string;
	unsandboxedMode?: string;
	disabled?: boolean;
	// Internal ownership marker for a launcher that owns its process group.
	processGroup?: boolean;
}

export interface Settings {
	providers: Record<string, ProviderSettings>;
	// `name` overrides the leader's personal name; absent means "pick one
	// from the name pool at leader creation".
	leader: { provider: string; model?: string; name?: string };
	forbiddenModels: string[];
	meCurator?: { enabled: boolean };
}

export interface PartialSettings {
	providers?: Record<string, Partial<ProviderSettings>>;
	leader?: Partial<Settings["leader"]>;
	forbiddenModels?: string[];
	meCurator?: Partial<Settings["meCurator"]>;
}

export const DEFAULT_PROVIDERS: Record<string, ProviderSettings> = {
	opencode: {
		command: "opencode",
		args: ["serve"],
		readOnlyArgs: [],
		readWriteArgs: [],
		resume: true,
		defaultModel: "",
		unsandboxedMode: "build",
	},
};

export const DEFAULT_SETTINGS: Settings = {
	providers: DEFAULT_PROVIDERS,
	leader: { provider: "opencode" },
	forbiddenModels: [],
	meCurator: { enabled: false },
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
		unsandboxedMode: patch.unsandboxedMode ?? base?.unsandboxedMode,
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
		meCurator: { enabled: patch.meCurator?.enabled ?? base.meCurator?.enabled ?? false },
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
				if (fields.unsandboxedMode !== undefined) {
					if (isString(fields.unsandboxedMode)) kept.unsandboxedMode = fields.unsandboxedMode;
					else warnings.push(`${where}: provider ${name} unsandboxedMode is not a string, ignoring`);
				}
				if (fields.disabled !== undefined) {
					if (typeof fields.disabled === "boolean") {
						kept.disabled = fields.disabled;
					} else {
						warnings.push(`${where}: provider ${name} disabled is not a boolean, ignoring`);
					}
				}
				if (
					name === "opencode" &&
					(kept.command === undefined || kept.command === "opencode") &&
					kept.args?.length === 1 &&
					kept.args[0] === "acp"
				) {
					kept.args = ["serve"];
					warnings.push(`${where}: migrated the shipped OpenCode ACP launch argument to direct control`);
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
			if (leader.name !== undefined) {
				if (isString(leader.name)) {
					kept.name = leader.name;
				} else {
					warnings.push(`${where}: leader name is not a string, ignoring`);
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
	if (layer.meCurator !== undefined) {
		if (typeof layer.meCurator !== "object" || layer.meCurator === null || Array.isArray(layer.meCurator)) {
			warnings.push(`${where}: meCurator is not an object, ignoring`);
		} else {
			const curator = layer.meCurator as Record<string, unknown>;
			const kept: Partial<Settings["meCurator"]> = {};
			if (curator.enabled !== undefined) {
				if (typeof curator.enabled === "boolean") kept.enabled = curator.enabled;
				else warnings.push(`${where}: meCurator.enabled is not a boolean, ignoring`);
			}
			patch.meCurator = kept;
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

export function requireManagedOpenCode(provider: ProviderSettings): void {
	if (provider.command !== "opencode" || provider.args.length !== 1 || provider.args[0] !== "serve") {
		throw new Error("OpenCode sessions use Neta's pinned runtime; remove custom provider command and args");
	}
}

export function launchArgs(p: ProviderSettings, access: Access): string[] {
	const extra = access === "readOnly" ? (p.readOnlyArgs ?? []) : (p.readWriteArgs ?? []);
	return [...p.args, ...extra];
}

export function launchEnvironment(p: ProviderSettings, access: Access): Record<string, string> {
	const environment = { ...p.env };
	if (p.env?.NETA_MANAGED_OPENCODE === "1") environment.NETA_NATIVE_ACCESS = access;
	return environment;
}

export function isForbiddenModel(s: Settings, model: string): boolean {
	return s.forbiddenModels.includes(model);
}

export function providerPath(provider: ProviderSettings): string {
	if (provider.env?.PATH !== undefined) return provider.env.PATH;
	const inherited = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry !== "");
	const extra = [
		join(homedir(), ".local", "bin"),
		join(homedir(), ".opencode", "bin"),
		join(homedir(), ".bun", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	];
	return [...new Set([...inherited, ...extra])].join(delimiter);
}

export function providerCommandAvailable(provider: ProviderSettings, cwd = process.cwd()): boolean {
	const hasPath = provider.command.includes("/");
	const candidates = isAbsolute(provider.command)
		? [provider.command]
		: hasPath
			? [resolve(cwd, provider.command)]
			: providerPath(provider)
					.split(delimiter)
					.map((dir) => join(dir, provider.command));
	return candidates.some((candidate) => {
		try {
			accessSync(candidate, constants.X_OK);
			return statSync(candidate).isFile();
		} catch {
			return false;
		}
	});
}
