#!/bin/bash
# Signed-app acceptance for busy Send and Reset Chat. All product actions use
# the real native composer, Details button and confirmation dialog.
set -euo pipefail

APP=${1:?usage: run-chat-actions-e2e.sh /path/to/NetaDesktop.app [evidence-dir]}
if [ "$#" -ge 2 ]; then
	RUN=$2
	if [ -e "$RUN" ]; then echo "evidence path already exists: $RUN" >&2; exit 2; fi
	mkdir -p "$RUN"
else
	RUN=$(mktemp -d /private/tmp/neta-chat-actions.XXXXXX)
fi
mkdir -p "$RUN/data" "$RUN/driver" "$RUN/workspace"
DATA="$RUN/data"; DRIVER="$RUN/driver"; WORKSPACE="$RUN/workspace"
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
FIXTURE="$ROOT/test/fixtures/fake-acp-agent.mjs"
cat > "$DATA/settings.json" <<EOF
{"providers":{"fake":{"command":"/usr/local/bin/node","args":["$FIXTURE","--session-store","$DATA/fake-sessions.json","--config-options"],"resume":true,"defaultModel":"fixture-default"},"claude":{"disabled":true},"codex":{"disabled":true},"opencode":{"disabled":true}},"leader":{"provider":"fake","model":"fixture-default","name":"Halden"},"forbiddenModels":[]}
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
[ -f "$DRIVER/log" ] || { echo "driver did not start" >&2; exit 1; }

run_command() {
	local before
	before=$(wc -l < "$DRIVER/log")
	printf '%s\n' "$1" > "$DRIVER/cmd"
	for _ in $(seq 1 300); do [ ! -e "$DRIVER/cmd" ] && [ "$(wc -l < "$DRIVER/log")" -gt "$before" ] && return; sleep .05; done
	echo "driver command timeout: $1" >&2; exit 1
}
run_command "await-ready 10000"
run_command "draft RESET_OLD_UNIQUE"
run_command "ax-press composer-send"
run_command "await-state 10000 idle"
run_command "state"
OLD_SESSION=$(sed -n 's/.* session=\([^ ]*\).*/\1/p' "$DRIVER/log" | tail -1)
[ -n "$OLD_SESSION" ] || { echo "missing old session" >&2; exit 1; }

# A custom provider is intentionally not trusted for native ACP steering. The
# second real Send queues, Stop closes the first turn, and FIFO drain delivers it.
run_command "draft HOLD_FOREVER"
run_command "ax-press composer-send"
run_command "await-state 10000 open"
run_command "draft BUSY_SEND_UNIQUE"
run_command "ax-press composer-send"
run_command "await-state 10000 inbox queued 1"
run_command "ax-press composer-stop"
run_command "await-state 10000 inbox delivered 3"
run_command "await-state 10000 idle"

# Reset while another response is live, through the visible Details action and
# destructive native confirmation.
run_command "draft RESET_ACTIVE HOLD_FOREVER"
run_command "ax-press composer-send"
run_command "await-state 10000 open"
run_command "ax-press Show details"
run_command "ax-press details-reset-chat"
run_command "ax-press details-reset-chat-confirm"
run_command "await-state 10000 session-not $OLD_SESSION"
run_command "await-state 10000 idle"
run_command "draft RESET_NEW_UNIQUE HISTORY"
run_command "ax-press composer-send"
run_command "await-state 10000 idle"
run_command "state"

if grep -q '^error ' "$DRIVER/log"; then cat "$DRIVER/log" >&2; exit 1; fi
find "$DATA/conversations" -maxdepth 1 -type f -exec cp {} "$RUN/" \;
python3 - "$RUN" "$DATA" "$OLD_SESSION" <<'PY'
import glob, json, os, sys
run, data, old = sys.argv[1:]
leader_path = glob.glob(os.path.join(data, "leaders", "*.json"))
assert len(leader_path) == 1, f"expected one leader record, found {leader_path}"
leader = json.load(open(leader_path[0], encoding="utf-8"))
new = leader["sessionId"]
assert new != old, "Reset did not durably rebind the leader"
def records(session):
    path = os.path.join(data, "conversations", session + ".ndjson")
    return [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]
old_records, new_records = records(old), records(new)
old_text = "\n".join(x.get("block", {}).get("text", "") for x in old_records)
new_text = "\n".join(x.get("block", {}).get("text", "") for x in new_records)
assert "RESET_OLD_UNIQUE" in old_text and "BUSY_SEND_UNIQUE" in old_text
assert any(x.get("turn", {}).get("cancelled") for x in old_records), "Reset did not terminalize the active old turn"
busy_blocks = [x["block"] for x in old_records if x.get("block", {}).get("text") == "BUSY_SEND_UNIQUE"]
assert len(busy_blocks) == 1, "busy Send was not persisted exactly once"
busy_turn = busy_blocks[0]["turnId"]
busy_terminal = [x["turn"] for x in old_records if x.get("turn", {}).get("id") == busy_turn and x["turn"].get("endedAt")]
assert busy_terminal and not busy_terminal[-1].get("cancelled", False), "queued busy Send did not finish"
assert any(x.get("block", {}).get("turnId") == busy_turn and x["block"].get("role") == "agent"
           and "echo:BUSY_SEND_UNIQUE" in x["block"].get("text", "") for x in old_records), "missing busy Send assistant reply"
assert "RESET_NEW_UNIQUE HISTORY" in new_text
assert "RESET_OLD_UNIQUE" not in new_text and "BUSY_SEND_UNIQUE" not in new_text
fake = json.load(open(os.path.join(data, "fake-sessions.json"), encoding="utf-8"))
new_histories = [session["history"] for session in fake["sessions"].values()
                 if any("RESET_NEW_UNIQUE HISTORY" in text for text in session["history"])]
assert len(new_histories) == 1, "new provider conversation was not uniquely recorded"
assert all("RESET_OLD_UNIQUE" not in text and "BUSY_SEND_UNIQUE" not in text for text in new_histories[0])
open(os.path.join(run, "assertions.txt"), "w").write("PASS busy-send-fifo reset-active durable-rebind no-old-context\n")
PY
printf '%s\n' "$RUN"
