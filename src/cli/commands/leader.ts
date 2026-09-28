// `neta models` and `neta model <id>`: thin clients
// of `models.list` and `conversation.setModel` plus
// formatting. Only `neta` and `neta open` start the Node, so these connect
// with `start: false` and report an unreachable Node as exit 2. Text goes to
// stdout, errors to stderr as `neta: <msg>`.
//
// The protocol's `models.list` carries only `{id, name, provider}`; the
// `default` and `forbidden` flags come from `$NETA_DIR/settings.json` read
// through 03's `loadSettings` (provider `defaultModel`, exact `forbiddenModels`
// match). The forbidden check therefore happens client-side and exits 3
// without calling the Node.

import { netaDir } from "../../node/lockfile.ts";
import type {
	ConversationSetModelResult,
	ModelInfo,
	ModelsListResult,
	WorkspaceOpenResult,
} from "../../node/protocol.ts";
import { loadSettings } from "../../session/settings.ts";
import { CliError, type NodeClient } from "../client.ts";

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fail(error: unknown): number {
	if (error instanceof CliError) {
		process.stderr.write(`neta: ${error.message}\n`);
		return error.code;
	}
	process.stderr.write(`neta: ${messageOf(error)}\n`);
	return 1;
}

async function openLeader(client: NodeClient): Promise<WorkspaceOpenResult> {
	return client.request<WorkspaceOpenResult>("workspace.open", { path: process.cwd() });
}

export interface ModelRow {
	provider: string;
	model: string;
	default: boolean;
	forbidden: boolean;
}

function compareModels(a: ModelInfo, b: ModelInfo): number {
	if (a.provider !== b.provider) {
		return a.provider < b.provider ? -1 : 1;
	}
	if (a.id !== b.id) {
		return a.id < b.id ? -1 : 1;
	}
	return 0;
}

export async function modelsCommand(client: NodeClient, flags: Record<string, string | true>): Promise<number> {
	try {
		// Open first: the leader's session is what makes the provider's
		// models listable on a freshly started Node.
		await openLeader(client);
		const listed = await client.request<ModelsListResult>("models.list", {});
		const { settings } = loadSettings({ netaDir: netaDir() });
		const rows: ModelRow[] = [...listed.models].sort(compareModels).map((model) => ({
			provider: model.provider,
			model: model.id,
			default: settings.providers[model.provider]?.defaultModel === model.id,
			forbidden: settings.forbiddenModels.includes(model.id),
		}));
		if (flags.json === true) {
			process.stdout.write(`${JSON.stringify(rows)}\n`);
			return 0;
		}
		for (const row of rows) {
			const marker = row.forbidden ? "forbidden" : row.default ? "default" : "";
			process.stdout.write(
				`${row.provider.padEnd(12)}  ${row.model.padEnd(28)}${marker === "" ? "" : `  ${marker}`}\n`,
			);
		}
		return 0;
	} catch (error) {
		return fail(error);
	}
}

// Model ids may themselves contain a slash (OpenCode's provider/model id).
// Match an advertised id first, then accept Neta's provider/id qualifier.
export function resolveModel(models: ModelInfo[], id: string): { provider: string; id: string } {
	if (id.length === 0) {
		throw new CliError(1, `bad model id: ${id}`);
	}
	const matches = models.filter((entry) => entry.id === id);
	if (matches.length > 1) {
		throw new CliError(
			1,
			`ambiguous model id: ${id} (${matches.map((entry) => `${entry.provider}/${entry.id}`).join(", ")})`,
		);
	}
	if (matches[0] !== undefined) return { provider: matches[0].provider, id: matches[0].id };
	const slash = id.indexOf("/");
	if (slash >= 0) {
		const provider = id.slice(0, slash);
		const model = id.slice(slash + 1);
		const found = models.find((entry) => entry.provider === provider && entry.id === model);
		if (found === undefined) {
			throw new CliError(1, `unknown model: ${id}`);
		}
		return { provider: found.provider, id: found.id };
	}
	throw new CliError(1, `unknown model: ${id}`);
}

export async function modelCommand(client: NodeClient, id: string): Promise<number> {
	try {
		if (id.length === 0) {
			throw new CliError(1, `bad model id: ${id}`);
		}
		const opened = await openLeader(client);
		const listed = await client.request<ModelsListResult>("models.list", {});
		const resolved = resolveModel(listed.models, id);
		const { settings } = loadSettings({ netaDir: netaDir() });
		if (settings.forbiddenModels.includes(resolved.id)) {
			throw new CliError(3, `forbidden model: ${resolved.provider}/${resolved.id}`);
		}
		await client.request<ConversationSetModelResult>("conversation.setModel", {
			sessionId: opened.leader.sessionId,
			model: resolved.id,
		});
		process.stdout.write(`model ${resolved.provider}/${resolved.id}\n`);
		return 0;
	} catch (error) {
		return fail(error);
	}
}
