#!/bin/bash
# Deterministic signed-app acceptance run. Product actions use the real composer,
# menu key equivalents and responder chain; the CLI call only seeds an
# isolated workspace before the UI launches.
set -euo pipefail

APP=${1:?usage: run-mvp-e2e.sh /path/to/NetaDesktop.app [evidence-dir]}
if [ "$#" -ge 2 ]; then
	RUN=$2
	if [ -e "$RUN" ]; then
		echo "evidence path already exists: $RUN" >&2
		exit 2
	fi
	mkdir -p "$RUN"
else
	RUN=$(mktemp -d /private/tmp/neta-mvp-acceptance.XXXXXX)
fi
DATA="$RUN/data"; DRIVER="$RUN/driver"; WORKSPACE="$RUN/workspace"
mkdir -p "$DATA" "$DRIVER" "$WORKSPACE"
FIXTURE="$(cd "$(dirname "$0")/../../.." && pwd)/test/fixtures/fake-acp-agent.mjs"
cat > "$DATA/settings.json" <<EOF
{"providers":{"fake":{"command":"/usr/local/bin/node","args":["$FIXTURE","--session-store","$DATA/fake-sessions.json","--config-options"],"resume":true,"defaultModel":"fixture-default"},"fake2":{"command":"/usr/local/bin/node","args":["$FIXTURE","--session-store","$DATA/fake2-sessions.json","--config-options"],"resume":true,"defaultModel":"fixture-fast"},"claude":{"disabled":true},"codex":{"disabled":true},"opencode":{"disabled":true}},"leader":{"provider":"fake","model":"fixture-default","name":"Halden"},"forbiddenModels":[]}
EOF
codesign --verify --deep --strict "$APP" 2> "$RUN/codesign.log"
env NETA_DIR="$DATA" "$APP/Contents/Resources/neta" open "$WORKSPACE" > "$RUN/setup.log"
env NETA_DIR="$DATA" NETA_DEBUG_DRIVER="$DRIVER" "$APP/Contents/MacOS/NetaDesktop" > "$RUN/app.stdout" 2> "$RUN/app.stderr" &
APP_PID=$!
finish() {
	printf 'quit\n' > "$DRIVER/cmd" 2>/dev/null || true
	for _ in $(seq 1 30); do kill -0 "$APP_PID" 2>/dev/null || break; sleep .1; done
	if kill -0 "$APP_PID" 2>/dev/null; then kill "$APP_PID" 2>/dev/null || true; fi
	wait "$APP_PID" 2>/dev/null || true
	env NETA_DIR="$DATA" "$APP/Contents/Resources/neta" node stop >/dev/null 2>&1 || true
}
trap finish EXIT
for _ in $(seq 1 100); do [ -f "$DRIVER/log" ] && break; sleep .1; done
if [ ! -f "$DRIVER/log" ]; then echo "driver did not start" >&2; exit 1; fi
cat > "$DRIVER/cmd" <<'EOF'
state
await-ready 10000
ax-dump
draft FULL_SEQUENCE
ax-press composer-send
wait 1000
state
draft HOLD_FOREVER
ax-press composer-send
wait 300
ax-press composer-stop
wait 500
state
draft EXIT_MID_TURN
ax-press composer-send
wait 1000
state
draft FULL_SEQUENCE RECOVERY
ax-press composer-send
wait 1000
state
EOF
for _ in $(seq 1 150); do
	[ ! -e "$DRIVER/cmd" ] && [ "$(grep -c '^ok state' "$DRIVER/log" 2>/dev/null || true)" -ge 5 ] && break
	sleep .1
done
if [ -e "$DRIVER/cmd" ]; then echo "driver command timeout" >&2; exit 1; fi
if grep -q '^error ' "$DRIVER/log"; then cat "$DRIVER/log" >&2; exit 1; fi
FINAL_STATE=$(grep '^ok state ' "$DRIVER/log" | tail -1)
case "$FINAL_STATE" in
	*"composerChars=0"*"submitting=false"*"stopping=false"*"error=-"*) ;;
	*) echo "composer did not return to idle: $FINAL_STATE" >&2; exit 1 ;;
esac
cp "$DATA/node.json" "$RUN/node.final.json"
find "$DATA/conversations" -maxdepth 1 -type f -exec cp {} "$RUN/" \;
python3 - "$RUN" <<'PY'
import glob, json, os, sys
run = sys.argv[1]
lines = []
for path in glob.glob(os.path.join(run, "*.ndjson")):
    with open(path, encoding="utf-8") as stream:
        lines.extend(json.loads(line) for line in stream if line.strip())
turns = {x["turn"]["id"]: x["turn"] for x in lines if x.get("t") == "turn"}
blocks = [x["block"] for x in lines if x.get("t") == "block"]

def user_turn(text):
    matches = [b for b in blocks if b.get("role") == "user" and b.get("text") == text]
    assert len(matches) == 1, f"expected one user block {text!r}, found {len(matches)}"
    return matches[0]["turnId"]

full = user_turn("FULL_SEQUENCE")
hold = user_turn("HOLD_FOREVER")
exited = user_turn("EXIT_MID_TURN")
recovery = user_turn("FULL_SEQUENCE RECOVERY")
assert turns[full].get("endedAt") and not turns[full].get("cancelled", False), "rich reply did not end"
assert turns[hold].get("endedAt") and turns[hold].get("cancelled") is True, "stop did not persist cancellation"
assert turns[exited].get("endedAt"), "disconnect turn did not end"
exit_blocks = [b for b in blocks if b["turnId"] == exited]
assert any(b.get("text") == "partial before disconnect" for b in exit_blocks), "missing disconnect partial"
assert any(b.get("kind") == "status" and "closed" in b.get("text", "").lower() for b in exit_blocks), "missing disconnect status"
assert turns[recovery].get("endedAt") and not turns[recovery].get("cancelled", False), "post-disconnect prompt did not recover"
full_kinds = {b.get("kind") for b in blocks if b["turnId"] == full}
assert {"plan", "tool", "diff", "text", "usage"} <= full_kinds, f"rich reply missing kinds: {full_kinds}"
assert max(b["seq"] for b in blocks if b["turnId"] == recovery) > max(b["seq"] for b in exit_blocks), "sequence did not advance after recovery"
with open(os.path.join(run, "assertions.txt"), "w", encoding="utf-8") as out:
    out.write("PASS rich-terminal cancel disconnect-terminal recovery-terminal monotonic-seq\n")
PY
printf '%s\n' "$RUN"
