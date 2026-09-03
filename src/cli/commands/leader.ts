// `neta mode`, `neta models` and `neta model <id>` (08, T8.7): thin clients
// of `leader.setMode`, `models.list` and `conversation.setModel` plus
// formatting. Only `neta` and `neta open` start the Node, so these connect
// with `start: false` and report an unreachable Node as exit 2. Text goes to
// stdout, errors to stderr as `neta: <msg>`.
//
// The protocol's `models.list` carries only `{id, name, provider}`; the
// `default` and `forbidden` flags come from `$NETA_DIR/settings.json` read
// through 03's `loadSettings` (provider `defaultModel`, exact `forbiddenModels`
// match). The forbidden check therefore happens client-side and exits 3
// without calling the Node.
import { loadSettings } from "../../acp/settings.ts";
import type { Leader } from "../../core/types.ts";
import { netaDir } from "../../node/lockfile.ts";
import type {
	ConversationSetModelResult,
	LeaderSetModeResult,
	MissionsListResult,
	ModelInfo,
	ModelsListResult,
	WorkspaceOpenResult,
} from "../../node/protocol.ts";
import { CliError, type NodeClient } from "../client.ts";

const COUNT_RE = /^[1-9][0-9]*$/;
const LIST_LIMIT = 200;

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

// `lead`, or `lead++  12m active` in whole active minutes.
function formatModeLine(leader: Leader): string {
	if (leader.mode === "leadPlus") {
		const minutes = Math.floor(Math.max(0, leader.modeActiveMs) / 60000);
		return `lead++  ${minutes}m active`;
	}
	return "lead";
}

async function openLeader(client: NodeClient): Promise<WorkspaceOpenResult> {
	return client.request<WorkspaceOpenResult>("workspace.open", { path: process.cwd() });
}

// A `--mission <n>` number to its mission id; an unknown number is exit 1,
// the same message `mission <n>` prints.
async function resolveMissionId(client: NodeClient, workspaceId: string, raw: string): Promise<string> {
	if (!COUNT_RE.test(raw)) {
		throw new CliError(1, `bad mission number: ${raw}`);
	}
	const number = Number.parseInt(raw, 10);
	let cursor: string | undefined;
	for (;;) {
		const page = await client.request<MissionsListResult>("missions.list", {
			workspaceId,
			limit: LIST_LIMIT,
			...(cursor === undefined ? {} : { cursor }),
		});
		const found = page.missions.find((mission) => mission.number === number);
		if (found !== undefined) {
			return found.id;
		}
		if (page.nextCursor === undefined) {
			break;
		}
		cursor = page.nextCursor;
	}
	throw new CliError(1, `no mission #${number} in this workspace`);
}

export async function modeCommand(
	client: NodeClient,
	arg: string | undefined,
	flags: Record<string, string | true>,
): Promise<number> {
	try {
		if (arg !== undefined && arg !== "lead" && arg !== "lead++") {
			throw new CliError(1, `bad mode: ${arg}`);
		}
		const opened = await openLeader(client);
		let missionId: string | undefined;
		if (typeof flags.mission === "string") {
			missionId = await resolveMissionId(client, opened.workspace.id, flags.mission);
		}
		if (arg === undefined) {
			// The protocol has no read path for a mission lead's mode, so a
			// read always reports the workspace leader (after validating the
			// `--mission` number above).
			process.stdout.write(`${formatModeLine(opened.leader)}\n`);
			return 0;
		}
		// The manual path (07): the person's own choice, no decision record —
		// a record belongs to the leader's own `neta_mode` requests, never to
		// a client. `lead++` on the wire is `leadPlus`.
		const mode = arg === "lead++" ? "leadPlus" : "lead";
		await client.request<LeaderSetModeResult>("leader.setMode", {
			workspaceId: opened.workspace.id,
			mode,
			...(missionId === undefined ? {} : { missionId }),
		});
		process.stdout.write(`mode ${arg}\n`);
		return 0;
	} catch (error) {
		return fail(error);
	}
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

// `provider/model` names one entry exactly; a bare id must be unique across
// providers. Anything else is exit 1; forbidden is decided by the caller.
export function resolveModel(models: ModelInfo[], id: string): { provider: string; id: string } {
	if (id.length === 0) {
		throw new CliError(1, `bad model id: ${id}`);
	}
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
	const matches = models.filter((entry) => entry.id === id);
	if (matches.length === 0) {
		throw new CliError(1, `unknown model: ${id}`);
	}
	if (matches.length > 1) {
		throw new CliError(
			1,
			`ambiguous model id: ${id} (${matches.map((entry) => `${entry.provider}/${entry.id}`).join(", ")})`,
		);
	}
	const only = matches[0];
	if (only === undefined) {
		throw new CliError(1, `unknown model: ${id}`);
	}
	return { provider: only.provider, id: only.id };
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
