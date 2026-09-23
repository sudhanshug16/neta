#!/usr/bin/env bash
# T12.4 end-to-end smoke: the built bundle opens a workspace and yields one
# mission, with no real provider. Needs `node`, `bun`, `git`, the managed
# OpenCode runtime and a built `dist/main.js`. It exits 0 only on success and prints
# `smoke: ok` as its last line.
#
# The node is started explicitly so the bundle is the process under test.
#
# The fake model does not call neta_mission. After one real chat prompt
# through OpenCode, this script persists exactly what a leader-led
# neta_mission with no agents would have written (mission row #1 plus one
# mission.created event) while the node is stopped, restarts the node, and
# proves the bundle serves it back via `neta missions` and the event log.
set -euo pipefail

if [ "$#" -ne 0 ]; then
	echo "usage: scripts/smoke.sh (takes no arguments)" >&2
	exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$ROOT/dist/main.js"
FIXTURE="$ROOT/test/fixtures/fake-openai-server.mjs"
TIMEOUT_SECS="${SMOKE_TIMEOUT_SECS:-120}"

command -v node >/dev/null 2>&1 || { echo "smoke: node is required" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "smoke: bun is required" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "smoke: git is required" >&2; exit 1; }
[ -f "$BUNDLE" ] || { echo "smoke: $BUNDLE is missing (run bun run build first)" >&2; exit 1; }
[ -f "$FIXTURE" ] || { echo "smoke: $FIXTURE is missing" >&2; exit 1; }
[ -f "$ROOT/vendor/opencode/runtime/neta-fork.json" ] || { echo "smoke: managed OpenCode runtime is missing (run bun run setup:opencode)" >&2; exit 1; }

WORK="$(mktemp -d)"
export NETA_DIR="$WORK/neta"
PROVIDER_PID=""
WATCHDOG_PID=""
cleanup() {
	node "$BUNDLE" node stop >/dev/null 2>&1 || true
	[ -z "$PROVIDER_PID" ] || kill "$PROVIDER_PID" >/dev/null 2>&1 || true
	[ -z "$WATCHDOG_PID" ] || kill "$WATCHDOG_PID" >/dev/null 2>&1 || true
	rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
	echo "smoke: $*" >&2
	exit 1
}

# Fail rather than hang: the whole run must finish within 120 seconds.
# Killed only on the success path; every other exit leaves it to die with
# the run (its kill lands on a dead pid and is harmless).
(
	sleep "$TIMEOUT_SECS" || sleep 120
	echo "smoke: timed out after ${TIMEOUT_SECS}s" >&2
	kill -TERM $$ 2>/dev/null || true
) &
WATCHDOG_PID=$!

PROMPT="Give a smoke response."
MISSION_NAME="smoke mission"
MISSION_OBJECTIVE="prove the released bundle end to end"

mkdir -p "$NETA_DIR" "$WORK/repo"
node "$FIXTURE" >"$WORK/provider.url" 2>"$WORK/provider.err" &
PROVIDER_PID=$!
for _ in {1..100}; do
	[ -s "$WORK/provider.url" ] && break
	if ! kill -0 "$PROVIDER_PID" >/dev/null 2>&1; then
		cat "$WORK/provider.err" >&2
		fail "fake model failed to start"
	fi
	sleep 0.1
done
PROVIDER_URL="$(head -n 1 "$WORK/provider.url")"
[ -n "$PROVIDER_URL" ] || fail "fake model did not report its endpoint"
SMOKE_MODEL_URL="$PROVIDER_URL" SMOKE_WORK="$WORK" node --input-type=module <<'EOF'
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const work = process.env.SMOKE_WORK;
const env = {
	XDG_DATA_HOME: join(work, "data"),
	XDG_CONFIG_HOME: join(work, "config"),
	XDG_CACHE_HOME: join(work, "cache"),
	XDG_STATE_HOME: join(work, "state"),
	OPENCODE_TEST_HOME: join(work, "home"),
	OPENCODE_TEST_MANAGED_CONFIG_DIR: join(work, "managed"),
	OPENCODE_DISABLE_MODELS_FETCH: "true",
	OPENCODE_DISABLE_AUTOUPDATE: "true",
	OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
	OPENCODE_DISABLE_PROJECT_CONFIG: "true",
	OPENCODE_CONFIG_CONTENT: JSON.stringify({
		model: "test/test-model",
		small_model: "test/test-model",
		enabled_providers: ["test"],
		formatter: false,
		lsp: false,
		provider: {
			test: {
				name: "Smoke Fixture",
				npm: "@ai-sdk/openai-compatible",
				env: [],
				options: { apiKey: "fixture", baseURL: `${process.env.SMOKE_MODEL_URL}/v1` },
				models: {
					"test-model": {
						name: "Fixture",
						limit: { context: 100000, output: 10000 },
						cost: { input: 0, output: 0 },
					},
				},
			},
		},
	}),
};
writeFileSync(
	join(process.env.NETA_DIR, "settings.json"),
	JSON.stringify({
		providers: {
			opencode: {
				command: "opencode",
				args: ["serve"],
				resume: true,
				defaultModel: "test/test-model",
				env,
			},
		},
		leader: { provider: "opencode", model: "test/test-model" },
		forbiddenModels: [],
	}),
);
EOF

git -C "$WORK/repo" init -q
git -C "$WORK/repo" config user.name "Smoke Test"
git -C "$WORK/repo" config user.email "smoke@example.com"
echo "smoke" >"$WORK/repo/README.md"
git -C "$WORK/repo" add README.md
git -C "$WORK/repo" commit -qm "seed" || fail "could not commit the seed repo"

node "$BUNDLE" node start --detach || fail "node start --detach failed"
OPEN_OUT="$(node "$BUNDLE" open "$WORK/repo")" || fail "neta open failed"
echo "$OPEN_OUT" | head -n 1

# One prompt through the CLI chat and the pinned OpenCode runtime.
(cd "$WORK/repo" && printf '%s\n' "$PROMPT" | node "$BUNDLE" >"$WORK/chat.log" 2>"$WORK/chat.err") \
	|| { cat "$WORK/chat.err" >&2; fail "chat prompt failed"; }
grep -Fq "smoke native reply" "$WORK/chat.log" || fail "chat reply never arrived"

# The mission write the released bundle cannot take itself (see header):
# stop the node (its mission mirror is in memory), persist the row plus the
# event, restart, and prove the bundle serves them back.
node "$BUNDLE" node stop >/dev/null || fail "node stop failed"

cat >"$WORK/seed.mjs" <<'EOF'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(now = Date.now()) {
	let time = now;
	let out = "";
	for (let i = 0; i < 10; i++) {
		out = CROCKFORD[time % 32] + out;
		time = Math.floor(time / 32);
	}
	for (let i = 0; i < 16; i++) out += CROCKFORD[Math.floor(Math.random() * 32)];
	return out;
}

const netaDir = process.env.NETA_DIR;
if (!netaDir) throw new Error("NETA_DIR is not set");
const name = process.env.SEED_NAME ?? "smoke mission";
const objective = process.env.SEED_OBJECTIVE ?? "prove the released bundle end to end";

const wsFiles = readdirSync(join(netaDir, "workspaces")).filter((f) => f.endsWith(".json"));
if (wsFiles.length !== 1) throw new Error(`expected one workspace, found ${wsFiles.length}`);
const workspace = JSON.parse(readFileSync(join(netaDir, "workspaces", wsFiles[0]), "utf8"));
const machine = JSON.parse(readFileSync(join(netaDir, "machine.json"), "utf8"));
const enc = encodeURIComponent(workspace.id);
const at = new Date().toISOString();

// Mirrors what neta_mission persists for lead "self" with no agents.
const mission = {
	id: ulid(),
	number: 1,
	workspaceId: workspace.id,
	machineId: machine.id,
	name,
	objective,
	changes: [],
	lead: { kind: "leader" },
	agentIds: [],
	access: "readOnly",
	state: "running",
	createdAt: at,
};

const missionsDir = join(netaDir, "missions", enc);
mkdirSync(missionsDir, { recursive: true });
writeFileSync(join(missionsDir, "counter"), "2\n");
appendFileSync(join(missionsDir, "registry.ndjson"), `${JSON.stringify({ op: "create", at, mission })}\n`);

const event = {
	workspaceId: workspace.id,
	kind: "mission.created",
	missionId: mission.id,
	data: { number: 1, name },
	seq: 1,
	at,
};
const eventsDir = join(netaDir, "events", enc);
mkdirSync(eventsDir, { recursive: true });
writeFileSync(join(eventsDir, "seq"), "2\n");
appendFileSync(join(eventsDir, `${at.slice(0, 4)}-${at.slice(5, 7)}.ndjson`), `${JSON.stringify(event)}\n`);
EOF
SEED_NAME="$MISSION_NAME" SEED_OBJECTIVE="$MISSION_OBJECTIVE" node "$WORK/seed.mjs" \
	|| fail "mission write failed"

node "$BUNDLE" node start --detach >/dev/null || fail "node restart failed"

grep -rq '"kind":"mission.created"' "$NETA_DIR/events" || fail "mission.created not in the event log"

MISSIONS_JSON="$(cd "$WORK/repo" && node "$BUNDLE" missions --json)" || fail "neta missions failed"
node -e '
let missions;
try {
	missions = JSON.parse(process.argv[1]);
} catch {
	console.error("smoke: missions --json did not parse");
	process.exit(1);
}
if (!Array.isArray(missions) || missions.length !== 1 || missions[0].number !== 1) {
	console.error(`smoke: expected exactly mission #1, got ${process.argv[1]}`);
	process.exit(1);
}
' "$MISSIONS_JSON" || fail "expected exactly one mission, numbered 1"

echo "smoke: ok"
