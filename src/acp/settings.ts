import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
	// Internal launch metadata. Settings files cannot set this field; Neta sets
	// it when it replaces the shipped npx tuple with an ACP executable.
	codexAcp?: boolean;
	// Internal launch metadata for Neta's bundled Claude ACP dependency.
	claudeAcp?: boolean;
	// Internal ownership marker for a launcher that spawns its ACP child.
	processGroup?: boolean;
}

export interface Settings {
	providers: Record<string, ProviderSettings>;
	// `name` overrides the leader's personal name; absent means "pick one
	// from the name pool at leader creation".
	leader: { provider: string; model?: string; name?: string };
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
		args: ["-y", "@agentclientprotocol/claude-agent-acp@0.74.0"],
		readOnlyArgs: [],
		readWriteArgs: [],
		resume: true,
		defaultModel: "sonnet",
		unsandboxedMode: "bypassPermissions",
	},
	codex: {
		command: "npx",
		args: ["-y", "@agentclientprotocol/codex-acp@1.10.0"],
		readOnlyArgs: [],
		readWriteArgs: [],
		resume: true,
		defaultModel: "",
		unsandboxedMode: "agent-full-access",
	},
	opencode: {
		command: "opencode",
		args: ["acp"],
		readOnlyArgs: [],
		readWriteArgs: [],
		resume: true,
		defaultModel: "",
		unsandboxedMode: "build",
	},
};

const RETIRED_DEFAULT_ARGS: Record<string, string[]> = {
	claude: ["-y", "@agentclientprotocol/claude-agent-acp@0.68.0"],
	codex: ["-y", "@agentclientprotocol/codex-acp@1.3.0"],
};

export const DEFAULT_SETTINGS: Settings = {
	providers: DEFAULT_PROVIDERS,
	leader: { provider: "claude" },
	forbiddenModels: [],
};

const CODEX_ACP_PACKAGE = "@agentclientprotocol/codex-acp";
const CODEX_ACP_VERSION = "1.10.0";
const CODEX_ACP_NPX_ARGS = ["-y", `${CODEX_ACP_PACKAGE}@${CODEX_ACP_VERSION}`];
const CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
const CLAUDE_ACP_VERSION = "0.74.0";
const CLAUDE_ACP_NPX_ARGS = ["-y", `${CLAUDE_ACP_PACKAGE}@${CLAUDE_ACP_VERSION}`];
const OPENCODE_PACKAGE = "opencode-ai";
const OPENCODE_VERSION = "1.2.26";
const OPENCODE_ACP_ARGS = ["acp"];
const requireFromNeta = createRequire(import.meta.url);

export function stagedCodexAcpProvider(
	provider: ProviderSettings,
	entry = join(dirname(fileURLToPath(import.meta.url)), "codex-acp.mjs"),
): ProviderSettings | undefined {
	if (!isDefaultCodexLaunch(provider)) return undefined;
	try {
		accessSync(entry, constants.R_OK);
		if (!statSync(entry).isFile()) return undefined;
		return { ...provider, command: process.execPath, args: [entry], codexAcp: true };
	} catch {
		return undefined;
	}
}

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
				// Settings files generated from an older shipped catalog often
				// contain the complete built-in launch tuple. Advance only that
				// exact tuple; partial or custom provider pins remain authoritative.
				const retired = RETIRED_DEFAULT_ARGS[name];
				if (
					retired !== undefined &&
					kept.command === "npx" &&
					kept.args !== undefined &&
					kept.args.length === retired.length &&
					kept.args.every((arg, index) => arg === retired[index])
				) {
					kept.args = [...(DEFAULT_PROVIDERS[name]?.args ?? kept.args)];
					warnings.push(`${where}: provider ${name} used a retired shipped adapter; using the current default`);
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

export function launchEnvironment(p: ProviderSettings, access: Access): Record<string, string> {
	const environment = { ...p.env };
	if (p.env?.NETA_MANAGED_OPENCODE === "1") environment.NETA_NATIVE_ACCESS = access;
	if (p.codexAcp === true || p.args.some((arg) => arg.includes("@agentclientprotocol/codex-acp@"))) {
		environment.INITIAL_AGENT_MODE = access === "readOnly" ? "read-only" : "agent";
	}
	return environment;
}

function isDefaultCodexLaunch(provider: ProviderSettings): boolean {
	return (
		provider.command === "npx" &&
		provider.args.length === CODEX_ACP_NPX_ARGS.length &&
		provider.args.every((arg, index) => arg === CODEX_ACP_NPX_ARGS[index])
	);
}

function isDefaultClaudeLaunch(provider: ProviderSettings): boolean {
	return (
		provider.command === "npx" &&
		provider.args.length === CLAUDE_ACP_NPX_ARGS.length &&
		provider.args.every((arg, index) => arg === CLAUDE_ACP_NPX_ARGS[index])
	);
}

function isDefaultOpenCodeLaunch(provider: ProviderSettings): boolean {
	return (
		provider.command === "opencode" &&
		provider.args.length === OPENCODE_ACP_ARGS.length &&
		provider.args.every((arg, index) => arg === OPENCODE_ACP_ARGS[index])
	);
}

// The resolver is deliberately rooted at this module, never at the workspace
// cwd. A production install may omit this development dependency, in which
// case callers retain the npx fallback.
export function installedCodexAcpProvider(
	provider: ProviderSettings,
	resolvePackageJson: (request: string) => string = requireFromNeta.resolve,
): ProviderSettings | undefined {
	if (!isDefaultCodexLaunch(provider)) return undefined;
	try {
		const packageJson = resolvePackageJson(`${CODEX_ACP_PACKAGE}/package.json`);
		const manifest: unknown = JSON.parse(readFileSync(packageJson, "utf8"));
		if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return undefined;
		const record = manifest as Record<string, unknown>;
		const bin = record.bin;
		const bins =
			typeof bin === "object" && bin !== null && !Array.isArray(bin) ? (bin as Record<string, unknown>) : undefined;
		const entry =
			typeof bin === "string" ? bin : typeof bins?.["codex-acp"] === "string" ? bins["codex-acp"] : undefined;
		if (record.version !== CODEX_ACP_VERSION || entry === undefined) return undefined;
		const command = resolve(dirname(packageJson), entry);
		accessSync(command, constants.X_OK);
		if (!statSync(command).isFile()) return undefined;
		return { ...provider, command, args: [], codexAcp: true };
	} catch {
		return undefined;
	}
}

// Resolve from this module so a workspace cannot substitute its own adapter.
// Claude's published entry is JavaScript and may be readable without an
// executable bit, so launch it explicitly through the current Node runtime.
export function installedClaudeAcpProvider(
	provider: ProviderSettings,
	resolvePackageJson: (request: string) => string = requireFromNeta.resolve,
): ProviderSettings | undefined {
	if (!isDefaultClaudeLaunch(provider)) return undefined;
	try {
		const packageJson = resolvePackageJson(`${CLAUDE_ACP_PACKAGE}/package.json`);
		const manifest: unknown = JSON.parse(readFileSync(packageJson, "utf8"));
		if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return undefined;
		const record = manifest as Record<string, unknown>;
		const bin = record.bin;
		const bins =
			typeof bin === "object" && bin !== null && !Array.isArray(bin) ? (bin as Record<string, unknown>) : undefined;
		const entry =
			typeof bin === "string"
				? bin
				: typeof bins?.["claude-agent-acp"] === "string"
					? bins["claude-agent-acp"]
					: undefined;
		if (record.version !== CLAUDE_ACP_VERSION || entry === undefined) return undefined;
		const command = resolve(dirname(packageJson), entry);
		accessSync(command, constants.R_OK);
		if (!statSync(command).isFile()) return undefined;
		return { ...provider, command: process.execPath, args: [command], claudeAcp: true };
	} catch {
		return undefined;
	}
}

// OpenCode publishes a CommonJS launcher which finds its platform-native
// optional dependency. Resolve that launcher from Neta, then run it through
// Node so neither a workspace nor PATH chooses the executable.
export function installedOpenCodeAcpProvider(
	provider: ProviderSettings,
	resolvePackageJson: (request: string) => string = requireFromNeta.resolve,
): ProviderSettings | undefined {
	if (!isDefaultOpenCodeLaunch(provider)) return undefined;
	try {
		const packageJson = resolvePackageJson(`${OPENCODE_PACKAGE}/package.json`);
		const manifest: unknown = JSON.parse(readFileSync(packageJson, "utf8"));
		if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return undefined;
		const record = manifest as Record<string, unknown>;
		const bin = record.bin;
		const bins =
			typeof bin === "object" && bin !== null && !Array.isArray(bin) ? (bin as Record<string, unknown>) : undefined;
		const entry = typeof bin === "string" ? bin : typeof bins?.opencode === "string" ? bins.opencode : undefined;
		if (record.version !== OPENCODE_VERSION || entry === undefined) return undefined;
		const command = resolve(dirname(packageJson), entry);
		accessSync(command, constants.R_OK);
		if (!statSync(command).isFile()) return undefined;
		return { ...provider, command: process.execPath, args: [command, ...OPENCODE_ACP_ARGS], processGroup: true };
	} catch {
		return undefined;
	}
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
