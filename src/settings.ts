/**
 * Neta settings: how tiers map onto worker backends, and how each backend is
 * launched.
 *
 * The leader never sees model names. It asks for a tier; this module turns that
 * into a concrete backend command plus model argument. Everything here is
 * user-editable in `~/.neta/settings.json`, and per project in
 * `.neta/settings.json`, because the shipped defaults are opinions, not facts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "./config.ts";
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
	backend: string;
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
		args: ["-y", "@zed-industries/claude-code-acp"],
		tierModels: { junior: "haiku", senior: "sonnet", staff: "default" },
		// A worker is an ordinary Claude Code session, filed under the same id.
		resume: { command: "claude", args: ["--resume", "{session}"] },
	},
	codex: {
		command: "npx",
		args: ["-y", "@agentclientprotocol/codex-acp"],
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
 * Shipped tier mapping. Workers run on the Claude subscription by default,
 * which is the whole point of driving real CLIs instead of burning API credit.
 * Point a tier at another backend and it picks up that backend's model for the
 * tier, so mixing vendors is one word per tier.
 */
export const DEFAULT_TIERS: Record<Tier, NetaTierSettings> = {
	junior: { backend: "claude" },
	senior: { backend: "claude" },
	staff: { backend: "claude" },
};

export interface ResolvedBackend {
	name: string;
	command: string | undefined;
	args: string[];
	model: string | undefined;
	env: Record<string, string>;
}

export class NetaConfig {
	private readonly tiers: Record<Tier, NetaTierSettings>;
	private readonly backends: Record<string, NetaBackendSettings>;
	readonly leader: Required<NetaLeaderSettings> | { backend: undefined; strictMcp: boolean };
	readonly mux: Required<NetaMuxSettings>;

	constructor(settings?: NetaSettings) {
		this.leader = { backend: settings?.leader?.backend, strictMcp: settings?.leader?.strictMcp ?? false };
		this.mux = { mode: settings?.mux?.mode ?? "auto", panes: settings?.mux?.panes ?? true };
		this.tiers = { ...DEFAULT_TIERS };
		for (const tier of TIERS) {
			const override = settings?.tiers?.[tier];
			if (override) this.tiers[tier] = { ...this.tiers[tier], ...override };
		}
		this.backends = { ...DEFAULT_BACKENDS };
		for (const [name, override] of Object.entries(settings?.backends ?? {})) {
			this.backends[name] = { ...this.backends[name], ...override };
		}
	}

	backendNames(): string[] {
		return Object.keys(this.backends);
	}

	/** How to open one of this backend's sessions in its own interface. */
	resumeCommand(backendName: string, sessionId: string): { command: string; args: string[] } | undefined {
		const resume = this.backends[backendName]?.resume;
		if (!resume) return undefined;
		return { command: resume.command, args: resume.args.map((arg) => arg.replace("{session}", sessionId)) };
	}

	tierMapping(): Record<Tier, NetaTierSettings> {
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
	 * Turn a tier (plus optional explicit backend) into a launchable backend.
	 * Throws with the available names when the backend is unknown, so the leader
	 * gets a usable error instead of a silent fallback.
	 */
	resolve(tier: Tier, backendOverride?: string, writer = false): ResolvedBackend {
		const mapping = this.tiers[tier];
		const name = backendOverride ?? mapping.backend;
		const backend = this.backends[name];
		if (!backend) {
			throw new Error(`Unknown worker backend "${name}". Configured backends: ${this.backendNames().join(", ")}.`);
		}

		// An explicit backend override drops the tier's model, which belongs to a
		// different backend's naming scheme — but the backend's own idea of what
		// this tier means still applies.
		const tierModel = backendOverride && backendOverride !== mapping.backend ? undefined : mapping.model;
		const model = tierModel ?? backend.tierModels?.[tier];
		const args = [...(backend.args ?? [])];
		const env = { ...(backend.env ?? {}) };
		if (model) {
			for (const arg of backend.modelArgs ?? []) args.push(arg.replace("{model}", model));
			if (backend.modelEnv) env[backend.modelEnv] = model;
		}
		args.push(...((writer ? backend.writerArgs : backend.readOnlyArgs) ?? []));

		return { name, command: backend.command, args, model, env };
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
