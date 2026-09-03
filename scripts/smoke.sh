#!/usr/bin/env bash
# T12.4 end-to-end smoke: the built bundle opens a workspace and yields one
# mission, with no real provider. Needs only `node`, `git` and a built
# `dist/main.js`. Takes no arguments, exits 0 only on success, and prints
# `smoke: ok` as its last line.
#
# The node is started explicitly: on-demand autostart shells out to an
# installed `neta` on PATH, which a release tarball cannot assume.
#
# Honest note on the mission step. The released bundle has no protocol path
# that creates missions (production serves no tools.* methods; the MCP proxy
# plus router stay test-local), and test/fixtures/fake-acp-agent.mjs has no
# directive that calls neta_mission. So after one real chat prompt through
# the fake agent, this script persists exactly what a leader-led
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
FIXTURE="$ROOT/test/fixtures/fake-acp-agent.mjs"
TIMEOUT_SECS="${SMOKE_TIMEOUT_SECS:-120}"

command -v node >/dev/null 2>&1 || { echo "smoke: node is required" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "smoke: git is required" >&2; exit 1; }
[ -f "$BUNDLE" ] || { echo "smoke: $BUNDLE is missing (run bun run build first)" >&2; exit 1; }
[ -f "$FIXTURE" ] || { echo "smoke: $FIXTURE is missing" >&2; exit 1; }

WORK="$(mktemp -d)"
export NETA_DIR="$WORK/neta"
trap 'node "$BUNDLE" node stop >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

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

PROMPT="please create a smoke mission named smoke-mission via neta_mission"
MISSION_NAME="smoke mission"
MISSION_OBJECTIVE="prove the released bundle end to end"

mkdir -p "$NETA_DIR" "$WORK/repo"
cat >"$NETA_DIR/settings.json" <<EOF
{
	"providers": {
		"fake": {
			"command": "node",
			"args": ["$FIXTURE"],
			"resume": true,
			"defaultModel": "test-model"
		}
	},
	"leader": { "provider": "fake", "model": "test-model" },
	"forbiddenModels": []
}
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

# One prompt through the CLI chat; the fake agent echoes it back.
(cd "$WORK/repo" && printf '%s\n' "$PROMPT" | node "$BUNDLE" >"$WORK/chat.log" 2>"$WORK/chat.err") \
	|| { cat "$WORK/chat.err" >&2; fail "chat prompt failed"; }
grep -Fq "echo:$PROMPT" "$WORK/chat.log" || fail "chat reply never arrived"

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

kill "$WATCHDOG_PID" >/dev/null 2>&1 || true
echo "smoke: ok"
