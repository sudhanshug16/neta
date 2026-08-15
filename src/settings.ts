/**
 * Neta settings: how tiers map onto worker backends, and how each backend is
 * launched.
 *
 * The leader asks for a tier; this module turns that into a concrete backend
 * command plus model argument. Everything here is user-editable in
 * `~/.neta/settings.json`, and per project in `.neta/settings.json`, because
 * the shipped defaults are opinions, not facts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "./config.ts";
import { findOnPath } from "./detect.ts";
import { TIERS, type Tier } from "./types.ts";

export interface NetaBackendSettings {
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
	tierModels?: Partial<Record<Tier, string>>;
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
	tiers?: Partial<Record<Tier, NetaTierSettings>>;
	backends?: Record<string, NetaBackendSettings>;
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
		command: "npx",
		args: ["-y", "@agentclientprotocol/claude-agent-acp@0.68.0"],
		tierModels: { junior: "haiku", senior: "sonnet", staff: "default" },
		// A worker is an ordinary Claude Code session, filed under the same id.
		resume: { command: "claude", args: ["--resume", "{session}"] },
	},
	codex: {
		command: "npx",
		args: ["-y", "@agentclientprotocol/codex-acp@1.3.0"],
		tierModels: {
			junior: "gpt-5.6-luna[medium]",
			senior: "gpt-5.6-terra[high]",
			staff: "gpt-5.6-sol[xhigh]",
		},
		resume: { command: "codex", args: ["resume", "{session}"] },
	},
	// OpenCode fronts many providers, so there is no honest default here: the
	// user says which model each tier means, in settings.
	opencode: {
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
		this.leader = { backend: settings?.leader?.backend, strictMcp: settings?.leader?.strictMcp ?? false };
		this.mux = { mode: settings?.mux?.mode ?? "auto", panes: settings?.mux?.panes ?? true };
		this.tiers = { ...DEFAULT_TIERS };
		for (const tier of TIERS) {
			const override = settings?.tiers?.[tier];
			if (override) {
				const base = this.tiers[tier];
				this.tiers[tier] = base ? { ...base, ...override } : override;
			}
		}
		this.backends = { ...DEFAULT_BACKENDS };
		for (const [name, override] of Object.entries(settings?.backends ?? {})) {
			this.backends[name] = { ...this.backends[name], ...override };
		}
	}

	backendNames(): string[] {
		return Object.keys(this.backends);
	}

	/**
	 * Backend names whose launch commands are actually installed (on PATH).
	 * For npx-based backends, this checks if npx itself is installed.
	 */
	installedBackends(env: Record<string, string | undefined> = process.env): string[] {
		const installed: string[] = [];
		for (const name of this.backendNames()) {
			const backend = this.backends[name];
			if (backend.command && findOnPath(backend.command, env)) {
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
		return {
			name,
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

		// If the backend differs from the tier's configured backend, drop the
		// tier's model (it belongs to a different backend's naming scheme) — but
		// the backend's own idea of what this tier means still applies.
		const tierModel = mapping?.backend && backendName !== mapping.backend ? undefined : mapping?.model;
		const model = tierModel ?? backend.tierModels?.[tier];
		const args = [...(backend.args ?? [])];
		const env = { ...(backend.env ?? {}) };
		if (model) {
			for (const arg of backend.modelArgs ?? []) args.push(arg.replace("{model}", model));
			if (backend.modelEnv) env[backend.modelEnv] = model;
		}
		args.push(...((writer ? backend.writerArgs : backend.readOnlyArgs) ?? []));

		return { name: backendName, command: backend.command, args, model, env };
	}
}

/** Unreadable or malformed settings are ignored rather than fatal. */
function readSettingsFile(path: string): NetaSettings {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as NetaSettings;
	} catch {
		return {};
	}
}

/**
 * User settings, then project settings on top. Merged one level deep, so a
 * project can remap a single tier without restating the others.
 */
export function loadNetaSettings(cwd: string, agentDir: string = getAgentDir()): NetaSettings {
	const user = readSettingsFile(join(agentDir, "settings.json"));
	const project = readSettingsFile(join(cwd, CONFIG_DIR_NAME, "settings.json"));
	return {
		leader: { ...user.leader, ...project.leader },
		mux: { ...user.mux, ...project.mux },
		tiers: { ...user.tiers, ...project.tiers },
		backends: { ...user.backends, ...project.backends },
	};
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
export async function persistTierOverride(cwd: string, tier: Tier, override: NetaTierSettings): Promise<void> {
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const settingsDir = join(cwd, CONFIG_DIR_NAME);
	const settingsPath = join(settingsDir, "settings.json");

	// Create .neta directory if it does not exist
	if (!existsSync(settingsDir)) {
		mkdirSync(settingsDir, { recursive: true });
	}

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

	// Write back with pretty-printing
	writeFileSync(settingsPath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
}
