/**
 * Neta settings: how tiers map onto worker backends, and how each backend is
 * launched.
 *
 * The leader asks for a tier; this module turns that into a concrete backend
 * command plus model argument. Everything here is user-editable in
 * `~/.neta/settings.json`, and per project in `.neta/settings.json`, because
 * the shipped defaults are opinions, not facts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "./config.ts";
import { findOnPath } from "./detect.ts";
import { LEGACY_TIER_ALIASES, TIERS, type Tier, type TierSettingsKey } from "./types.ts";

export interface NetaBackendSettings {
	/** Exclude this backend from automatic selection and reject explicit use. */
	disabled?: boolean;
	/** Executable whose presence on PATH means this backend's vendor CLI is installed. */
	detect?: string;
	/** Executable that speaks ACP over stdio. */
	command?: string;
	args?: string[];
	/** Appended when a model is requested. `{model}` is replaced with the model id. */
	modelArgs?: string[];
	/** Environment variable that carries the model id, for backends without a model flag. */
	modelEnv?: string;
	/**
	 * Which of this backend's models each tier means, used when a tier names a
	 * backend but no model. Model ids are the ones the backend advertises over
	 * ACP — `neta models <backend>` lists them.
	 */
	tierModels?: Partial<Record<TierSettingsKey, string>>;
	/** Extra environment for the worker process. */
	env?: Record<string, string>;
	/**
	 * Backend-native sandbox flags for a read-only worker, e.g. Codex's
	 * `-c sandbox_mode="read-only"`. Neta's own permission gate already rejects
	 * file-editing tool calls; these close the shell hole on backends that can.
	 * Empty by default because the flags differ per ACP bridge — see docs.
	 */
	readOnlyArgs?: string[];
	/** The same, for the worker that holds the writer slot. */
	writerArgs?: string[];
	/**
	 * How to open one of this backend's sessions in its own interface.
	 * `{session}` is replaced with the backend's session id. This is what
	 * `neta attach` runs.
	 */
	resume?: { command: string; args: string[] };
}

/** Which multiplexer worker panes open in. `auto` prefers zellij, then tmux, then none. */
export type MuxMode = "auto" | "zellij" | "tmux" | "none";

export interface NetaMuxSettings {
	mode?: MuxMode;
	/** Open a pane per worker. Turn off to run every worker headless. */
	panes?: boolean;
}

export interface NetaLeaderSettings {
	/** Backend to lead with when several are installed. */
	backend?: string;
	/**
	 * Hide the user's own MCP servers from the leader, leaving only Neta's.
	 * Off by default: the leader keeps the tools its user configured.
	 */
	strictMcp?: boolean;
}

export interface NetaTierSettings {
	backend?: string;
	/** Backend-specific model identifier or alias. */
	model?: string;
}

export interface NetaSettings {
	leader?: NetaLeaderSettings;
	mux?: NetaMuxSettings;
	tiers?: Partial<Record<TierSettingsKey, NetaTierSettings>>;
	backends?: Record<string, NetaBackendSettings>;
}

/** Claude Fable is historical-only: costs remain known, but Neta must never select it. */
const CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
export const CLAUDE_OPUS_MAX = "opus[1m][max]";

export function isForbiddenClaudeModel(model: string): boolean {
	const parts = model.trim().toLowerCase().split("/");
	if (parts.length > 2 || (parts.length === 2 && parts[0] !== "anthropic")) return false;
	const id = parts.at(-1);
	if (!id) return false;
	const family = id.startsWith("claude-") ? id.slice("claude-".length) : id;
	if (family === "fable") return true;
	if (!family.startsWith("fable")) return false;
	return ["-", ".", "[", ":"].includes(family.charAt("fable".length));
}

export function assertClaudeModelAllowed(claudeLineage: boolean, model: string | undefined, field: string): void {
	if (claudeLineage && model && isForbiddenClaudeModel(model)) {
		throw new Error(
			`Claude Fable model "${model}" is disabled by Neta policy at ${field}. Use ${CLAUDE_OPUS_MAX} or a lower Claude tier.`,
		);
	}
}

/**
 * Claude policy follows the effective launcher, not its user-chosen key. The
 * shipped ACP package, Claude detection hint, and Claude resume command are
 * stable structural signals retained by aliases made from the shipped config.
 */
export function isEffectiveClaudeBackend(name: string, backend: NetaBackendSettings): boolean {
	if (name === "claude") return true;
	if (backend.detect === "claude") return true;
	if (backend.resume?.command === "claude" && backend.resume.args.includes("--resume")) return true;
	if (backend.command && basename(backend.command) === "claude-agent-acp") return true;
	return (backend.args ?? []).some((arg) => arg === CLAUDE_ACP_PACKAGE || arg.startsWith(`${CLAUDE_ACP_PACKAGE}@`));
}

/**
 * Shipped backend launchers.
 *
 * The ACP entry points are the ones the backends' own docs point at. If a
 * backend changes its invocation, override `backends.<name>` in settings
 * instead of waiting for a release.
 */
/**
 * Shipped backend launchers, with the model each tier means.
 *
 * The model ids are what these backends answer with over ACP, checked against
 * the running bridges. Codex folds the reasoning level into the id, which is
 * why a tier can pick "think harder" without a separate setting.
 */
export const DEFAULT_BACKENDS: Record<string, NetaBackendSettings> = {
	claude: {
		detect: "claude",
		command: "npx",
		args: ["-y", "@agentclientprotocol/claude-agent-acp@0.68.0"],
		tierModels: {
			apprentice: "haiku",
			journeyman: "sonnet",
			expert: "opus[1m]",
			architect: CLAUDE_OPUS_MAX,
		},
		// A worker is an ordinary Claude Code session, filed under the same id.
		resume: { command: "claude", args: ["--resume", "{session}"] },
	},
	codex: {
		detect: "codex",
		command: "npx",
		args: ["-y", "@agentclientprotocol/codex-acp@1.3.0"],
		tierModels: {
			apprentice: "gpt-5.6-luna[high]",
			journeyman: "gpt-5.6-terra[medium]",
			expert: "gpt-5.6-sol[medium]",
			architect: "gpt-5.6-sol[max]",
		},
		resume: { command: "codex", args: ["resume", "{session}"] },
	},
	// OpenCode fronts many providers, so there is no honest default here: the
	// user says which model each tier means, in settings.
	opencode: {
		detect: "opencode",
		command: "opencode",
		args: ["acp"],
		resume: { command: "opencode", args: ["--session", "{session}"] },
	},
};

/**
 * Shipped tier mapping. Tiers are unconfigured by default; the assignment
 * policy spreads them across installed backends when no explicit configuration
 * exists. Users can configure specific backends for tiers in settings.
 */
export const DEFAULT_TIERS: Partial<Record<Tier, NetaTierSettings>> = {};

export interface ResolvedBackend {
	name: string;
	/** True when the effective launcher is Claude-derived, regardless of its key. */
	claudeLineage: boolean;
	command: string | undefined;
	args: string[];
	model: string | undefined;
	env: Record<string, string>;
}

export class NetaConfig {
	private readonly tiers: Partial<Record<Tier, NetaTierSettings>>;
	private readonly backends: Record<string, NetaBackendSettings>;
	readonly leader: Required<NetaLeaderSettings> | { backend: undefined; strictMcp: boolean };
	readonly mux: Required<NetaMuxSettings>;

	constructor(settings?: NetaSettings) {
		const normalized = normalizeSettings(settings ?? {});
		this.leader = { backend: normalized.leader?.backend, strictMcp: normalized.leader?.strictMcp ?? false };
		this.mux = { mode: normalized.mux?.mode ?? "auto", panes: normalized.mux?.panes ?? true };
		this.tiers = { ...DEFAULT_TIERS };
		for (const tier of TIERS) {
			const override = normalized.tiers?.[tier];
			if (override) {
				const base = this.tiers[tier];
				this.tiers[tier] = base ? { ...base, ...override } : override;
			}
		}
		this.backends = effectiveBackendSettings(normalized);
		assertSettingsClaudePolicy(normalized, this.backends);
	}

	backendNames(): string[] {
		return Object.entries(this.backends)
			.filter(([, backend]) => !backend.disabled)
			.map(([name]) => name);
	}

	isBackendDisabled(name: string): boolean {
		return this.backends[name]?.disabled === true;
	}

	isClaudeBackend(name: string): boolean {
		const backend = this.backends[name];
		return backend ? isEffectiveClaudeBackend(name, backend) : false;
	}

	/**
	 * Backend names whose vendor CLIs are actually installed (on PATH). Custom
	 * backends without a detect hint use their launch command.
	 */
	installedBackends(env: Record<string, string | undefined> = process.env): string[] {
		const installed: string[] = [];
		for (const name of this.backendNames()) {
			const backend = this.backends[name];
			const binary = backend.detect ?? backend.command;
			if (binary && findOnPath(binary, env)) {
				installed.push(name);
			}
		}
		return installed;
	}

	/** How to open one of this backend's sessions in its own interface. */
	resumeCommand(backendName: string, sessionId: string): { command: string; args: string[] } | undefined {
		const resume = this.backends[backendName]?.resume;
		if (!resume) return undefined;
		return { command: resume.command, args: resume.args.map((arg) => arg.replace("{session}", sessionId)) };
	}

	tierMapping(): Partial<Record<Tier, NetaTierSettings>> {
		return { ...this.tiers };
	}

	/**
	 * Launch settings for a backend by name, with no tier and therefore no
	 * model argument. Used for the leader's own backend, which runs on that
	 * CLI's default model.
	 */
	launcher(name: string): ResolvedBackend {
		const backend = this.backends[name];
		if (!backend) {
			throw new Error(`Unknown backend "${name}". Configured backends: ${this.backendNames().join(", ")}.`);
		}
		if (backend.disabled) throw new Error(`Backend "${name}" is disabled in settings.`);
		return {
			name,
			claudeLineage: this.isClaudeBackend(name),
			command: backend.command,
			args: [...(backend.args ?? [])],
			model: undefined,
			env: { ...(backend.env ?? {}) },
		};
	}

	/**
	 * Turn a tier and backend name into a launchable backend. The backend name
	 * should be computed by the caller (via tier mapping, spread policy, or
	 * explicit override). Throws with the available names when the backend is
	 * unknown, so the leader gets a usable error instead of a silent fallback.
	 */
	resolve(tier: Tier, backendName: string, writer = false): ResolvedBackend {
		const mapping = this.tiers[tier];
		const backend = this.backends[backendName];
		if (!backend) {
			throw new Error(
				`Unknown worker backend "${backendName}". Configured backends: ${this.backendNames().join(", ")}.`,
			);
		}
		if (backend.disabled) throw new Error(`Backend "${backendName}" is disabled in settings.`);

		// If the backend differs from the tier's configured backend, drop the
		// tier's model (it belongs to a different backend's naming scheme) — but
		// the backend's own idea of what this tier means still applies.
		const tierModel = mapping?.backend && backendName !== mapping.backend ? undefined : mapping?.model;
		const claudeLineage = this.isClaudeBackend(backendName);
		const model =
			tierModel ??
			backend.tierModels?.[tier] ??
			(claudeLineage ? DEFAULT_BACKENDS.claude.tierModels?.[tier] : undefined);
		assertClaudeModelAllowed(claudeLineage, model, `resolved ${tier} model`);
		const args = [...(backend.args ?? [])];
		const env = { ...(backend.env ?? {}) };
		if (model) {
			for (const arg of backend.modelArgs ?? []) args.push(arg.replace("{model}", model));
			if (backend.modelEnv) env[backend.modelEnv] = model;
		}
		args.push(...((writer ? backend.writerArgs : backend.readOnlyArgs) ?? []));

		return { name: backendName, claudeLineage, command: backend.command, args, model, env };
	}
}

function assertSettingsClaudePolicy(
	settings: NetaSettings,
	effectiveBackends: Record<string, NetaBackendSettings>,
): void {
	for (const [tier, setting] of Object.entries(settings.tiers ?? {})) {
		if (setting.model) {
			const claudeLineage =
				setting.backend === undefined ||
				(effectiveBackends[setting.backend] !== undefined &&
					isEffectiveClaudeBackend(setting.backend, effectiveBackends[setting.backend]));
			assertClaudeModelAllowed(claudeLineage, setting.model, `tiers.${tier}.model`);
		}
	}
	for (const [name, configured] of Object.entries(settings.backends ?? {})) {
		const effective = effectiveBackends[name];
		if (!effective || !isEffectiveClaudeBackend(name, effective)) continue;
		for (const [tier, model] of Object.entries(configured.tierModels ?? {})) {
			assertClaudeModelAllowed(true, model, `backends.${name}.tierModels.${tier}`);
		}
	}
}

function mergeBackendSettings(
	base: NetaBackendSettings | undefined,
	override: NetaBackendSettings,
): NetaBackendSettings {
	const env = base?.env || override.env ? { ...base?.env, ...override.env } : undefined;
	const tierModels =
		base?.tierModels || override.tierModels
			? { ...normalizeTierModels(base?.tierModels), ...normalizeTierModels(override.tierModels) }
			: undefined;
	return {
		...base,
		...override,
		...(env ? { env } : {}),
		...(tierModels ? { tierModels } : {}),
	};
}

function effectiveBackendSettings(settings: NetaSettings): Record<string, NetaBackendSettings> {
	const effective = { ...DEFAULT_BACKENDS };
	for (const [name, override] of Object.entries(settings.backends ?? {})) {
		effective[name] = mergeBackendSettings(effective[name], override);
	}
	return effective;
}

function normalizeTierModels(tierModels: NetaBackendSettings["tierModels"] | undefined): Partial<Record<Tier, string>> {
	const normalized: Partial<Record<Tier, string>> = {};
	for (const [legacy, tier] of Object.entries(LEGACY_TIER_ALIASES)) {
		const model = tierModels?.[legacy as TierSettingsKey];
		if (model !== undefined) normalized[tier as Tier] = model;
	}
	for (const tier of TIERS) {
		const model = tierModels?.[tier];
		if (model !== undefined) normalized[tier] = model;
	}
	return normalized;
}

function normalizeTierSettings(tiers: NetaSettings["tiers"] | undefined): Partial<Record<Tier, NetaTierSettings>> {
	const normalized: Partial<Record<Tier, NetaTierSettings>> = {};
	for (const [legacy, tier] of Object.entries(LEGACY_TIER_ALIASES)) {
		const setting = tiers?.[legacy as TierSettingsKey];
		if (setting) normalized[tier as Tier] = setting;
	}
	for (const tier of TIERS) {
		const setting = tiers?.[tier];
		if (setting) normalized[tier] = { ...normalized[tier], ...setting };
	}
	return normalized;
}

function normalizeSettings(settings: NetaSettings): NetaSettings {
	return {
		...settings,
		tiers: normalizeTierSettings(settings.tiers),
		backends: Object.fromEntries(
			Object.entries(settings.backends ?? {}).map(([name, backend]) => [
				name,
				{
					...backend,
					...(backend.tierModels ? { tierModels: normalizeTierModels(backend.tierModels) } : {}),
				},
			]),
		),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): boolean {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): boolean {
	return value === undefined || typeof value === "boolean";
}

function validBackend(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (!isOptionalBoolean(value.disabled)) return false;
	for (const field of ["detect", "command", "modelEnv"] as const) {
		if (!isOptionalString(value[field])) return false;
	}
	for (const field of ["args", "modelArgs", "readOnlyArgs", "writerArgs"] as const) {
		if (value[field] !== undefined && !isStringArray(value[field])) return false;
	}
	if (
		value.env !== undefined &&
		(!isRecord(value.env) || Object.values(value.env).some((item) => typeof item !== "string"))
	) {
		return false;
	}
	if (
		value.tierModels !== undefined &&
		(!isRecord(value.tierModels) || Object.values(value.tierModels).some((item) => typeof item !== "string"))
	) {
		return false;
	}
	if (value.resume !== undefined) {
		if (!isRecord(value.resume) || typeof value.resume.command !== "string" || !isStringArray(value.resume.args))
			return false;
	}
	return true;
}

function validTier(value: unknown): boolean {
	return isRecord(value) && isOptionalString(value.backend) && isOptionalString(value.model);
}

function validSettings(value: unknown): value is NetaSettings {
	if (!isRecord(value)) return false;
	if (
		value.leader !== undefined &&
		(!isRecord(value.leader) || !isOptionalString(value.leader.backend) || !isOptionalBoolean(value.leader.strictMcp))
	) {
		return false;
	}
	if (
		value.mux !== undefined &&
		(!isRecord(value.mux) || !isOptionalString(value.mux.mode) || !isOptionalBoolean(value.mux.panes))
	) {
		return false;
	}
	if (
		value.tiers !== undefined &&
		(!isRecord(value.tiers) || Object.values(value.tiers).some((tier) => !validTier(tier)))
	)
		return false;
	if (
		value.backends !== undefined &&
		(!isRecord(value.backends) || Object.values(value.backends).some((backend) => !validBackend(backend)))
	) {
		return false;
	}
	return true;
}

/** Unreadable or malformed settings are ignored rather than fatal, but never silently. */
function readSettingsFile(path: string): NetaSettings {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (validSettings(parsed)) return quarantineForbiddenClaudeModels(parsed, path);
	} catch {
		// The warning below names the file while keeping leader startup resilient.
	}
	console.error(`Warning: ignoring invalid Neta settings file ${path}.`);
	return {};
}

function quarantineForbiddenClaudeModels(settings: NetaSettings, path: string): NetaSettings {
	const quarantined = structuredClone(settings);
	const effectiveBackends = effectiveBackendSettings(quarantined);
	for (const [tier, setting] of Object.entries(quarantined.tiers ?? {})) {
		const claudeLineage =
			setting.backend === undefined ||
			(effectiveBackends[setting.backend] !== undefined &&
				isEffectiveClaudeBackend(setting.backend, effectiveBackends[setting.backend]));
		if (setting.model && claudeLineage && isForbiddenClaudeModel(setting.model)) {
			console.error(
				`Warning: blocked forbidden Claude Fable model "${setting.model}" in ${path} at tiers.${tier}.model; using the shipped safe Claude tier model.`,
			);
			delete setting.model;
		}
	}
	for (const [name, configured] of Object.entries(quarantined.backends ?? {})) {
		const effective = effectiveBackends[name];
		if (!effective || !isEffectiveClaudeBackend(name, effective)) continue;
		for (const [tier, model] of Object.entries(configured.tierModels ?? {})) {
			if (!isForbiddenClaudeModel(model)) continue;
			console.error(
				`Warning: blocked forbidden Claude Fable model "${model}" in ${path} at backends.${name}.tierModels.${tier}; using the shipped safe Claude tier model.`,
			);
			delete configured.tierModels?.[tier as TierSettingsKey];
		}
	}
	return quarantined;
}

/**
 * User settings, then project settings on top. Tiers and backend entries merge
 * independently, so a project can override one field without losing siblings.
 */
export function loadNetaSettings(cwd: string, agentDir: string = getAgentDir()): NetaSettings {
	const userPath = join(agentDir, "settings.json");
	const projectPath = join(cwd, CONFIG_DIR_NAME, "settings.json");
	const user = normalizeSettings(readSettingsFile(userPath));
	const project = normalizeSettings(readSettingsFile(projectPath));
	const merged: NetaSettings = {
		leader: { ...user.leader, ...project.leader },
		mux: { ...user.mux, ...project.mux },
		tiers: Object.fromEntries(
			TIERS.flatMap((tier) => {
				const merged = { ...user.tiers?.[tier], ...project.tiers?.[tier] };
				return Object.keys(merged).length > 0 ? [[tier, merged]] : [];
			}),
		),
		backends: Object.fromEntries(
			Array.from(new Set([...Object.keys(user.backends ?? {}), ...Object.keys(project.backends ?? {})])).map(
				(name) => [name, mergeBackendSettings(user.backends?.[name], project.backends?.[name] ?? {})],
			),
		),
	};
	const effectiveBackends = effectiveBackendSettings(merged);
	for (const [tier, setting] of Object.entries(merged.tiers ?? {})) {
		const claudeLineage =
			setting.backend === undefined ||
			(effectiveBackends[setting.backend] !== undefined &&
				isEffectiveClaudeBackend(setting.backend, effectiveBackends[setting.backend]));
		if (!claudeLineage || !setting.model || !isForbiddenClaudeModel(setting.model)) continue;
		const sourcePath = project.tiers?.[tier as Tier]?.model ? projectPath : userPath;
		console.error(
			`Warning: blocked forbidden Claude Fable model "${setting.model}" in ${sourcePath} at tiers.${tier}.model after settings merge; using the shipped safe Claude tier model.`,
		);
		delete setting.model;
	}
	for (const [name, configured] of Object.entries(merged.backends ?? {})) {
		const effective = effectiveBackends[name];
		if (!effective || !isEffectiveClaudeBackend(name, effective)) continue;
		for (const [tier, model] of Object.entries(configured.tierModels ?? {})) {
			if (!isForbiddenClaudeModel(model)) continue;
			const sourcePath = project.backends?.[name]?.tierModels?.[tier as Tier] ? projectPath : userPath;
			console.error(
				`Warning: blocked forbidden Claude Fable model "${model}" in ${sourcePath} at backends.${name}.tierModels.${tier} after settings merge; using the shipped safe Claude tier model.`,
			);
			delete configured.tierModels?.[tier as TierSettingsKey];
		}
	}
	return merged;
}

/** Everything the process needs from settings, in one call. */
export function loadConfig(cwd: string, agentDir: string = getAgentDir()): NetaConfig {
	return new NetaConfig(loadNetaSettings(cwd, agentDir));
}

/**
 * Persist a tier override to the project's .neta/settings.json file. Merges
 * the new tier setting without clobbering other tiers or settings keys.
 * Creates the .neta directory if it does not exist.
 *
 * Note: This writes JSON with pretty-printing (2-space indent). JSON comments
 * are not preserved, as the settings files are JSON, not JSONC.
 */
export async function persistTierOverride(
	cwd: string,
	tier: Tier,
	override: NetaTierSettings,
	agentDir: string = getAgentDir(),
): Promise<void> {
	const settingsDir = join(cwd, CONFIG_DIR_NAME);
	const settingsPath = join(settingsDir, "settings.json");

	// Read existing settings or start with empty object
	const existing = readSettingsFile(settingsPath);

	// Merge the new tier setting
	const updated: NetaSettings = {
		...existing,
		tiers: {
			...existing.tiers,
			[tier]: override,
		},
	};
	// Runtime resolution merges user settings with this project file. Validate
	// that same prospective result before touching disk, so a user-only Claude
	// alias cannot make persisted settings accept a model startup rejects.
	const effective = loadNetaSettings(cwd, agentDir);
	new NetaConfig({
		...effective,
		tiers: {
			...effective.tiers,
			[tier]: { ...effective.tiers?.[tier], ...override },
		},
	});

	if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });

	// Write back with pretty-printing
	writeFileSync(settingsPath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
}
