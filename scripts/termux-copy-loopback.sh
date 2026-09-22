#!/usr/bin/env bash
# Prepare an isolated local Node/SSH endpoint for a manual Termux /neta-copy check.
set -euo pipefail
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
output=""
serial=""
port=2222
while (($#)); do
  case "$1" in
    --output) (($# >= 2)) || { echo "termux-copy-loopback: --output needs a directory" >&2; exit 2; }; output=$2; shift 2 ;;
    --emulator) (($# >= 2)) || { echo "termux-copy-loopback: --emulator needs a serial" >&2; exit 2; }; serial=$2; shift 2 ;;
    --port) (($# >= 2)) || { echo "termux-copy-loopback: --port needs a number" >&2; exit 2; }; port=$2; shift 2 ;;
    -h|--help) echo "Usage: $0 [--output DIR] --emulator SERIAL [--port PORT]"; exit 0 ;;
    *) echo "termux-copy-loopback: unknown option: $1" >&2; exit 2 ;;
  esac
done
command -v bun >/dev/null 2>&1 || { echo "termux-copy-loopback: bun is required" >&2; exit 2; }
for tool in ssh-keygen ssh-keyscan sshd adb; do command -v "$tool" >/dev/null 2>&1 || { echo "termux-copy-loopback: $tool is required" >&2; exit 2; }; done
[[ -n "$serial" ]] || { echo "termux-copy-loopback: --emulator SERIAL is required; choose one from adb devices" >&2; exit 2; }
if [[ "${NETA_COPY_SKIP_ADB:-0}" != 1 ]]; then adb -s "$serial" get-state >/dev/null 2>&1 || { echo "termux-copy-loopback: emulator is unavailable: $serial" >&2; exit 2; }; fi
[[ "$port" =~ ^[0-9]+$ ]] && ((port > 0 && port < 65536)) || { echo "termux-copy-loopback: invalid --port: $port" >&2; exit 2; }
if [[ -z "$output" ]]; then output=$(mktemp -d /private/tmp/neta-copy-loopback.XXXXXX); else mkdir -m 700 -- "$output"; fi
chmod 700 "$output"
node_dir=$output/node; workspace_dir=$output/workspace; ssh_dir=$output/ssh
mkdir -m 700 "$node_dir" "$workspace_dir" "$ssh_dir"
private_key=$ssh_dir/id_ed25519; host_key=$ssh_dir/ssh_host_ed25519_key
node_pid=""; sshd_pid=""; reversed=0
finish() {
  code=$?
  trap - EXIT INT TERM
  [[ "$node_pid" =~ ^[0-9]+$ ]] && kill "$node_pid" 2>/dev/null || true
  [[ "$sshd_pid" =~ ^[0-9]+$ ]] && kill "$sshd_pid" 2>/dev/null || true
  [[ "$node_pid" =~ ^[0-9]+$ ]] && wait "$node_pid" 2>/dev/null || true
  [[ "$sshd_pid" =~ ^[0-9]+$ ]] && wait "$sshd_pid" 2>/dev/null || true
  if ((reversed)); then adb -s "$serial" reverse --remove "tcp:$port" >/dev/null 2>&1 || true; fi
  rm -f -- "$private_key" "$private_key.pub" "$host_key" "$host_key.pub" "$ssh_dir/authorized_keys"
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ssh-keygen -q -t ed25519 -N '' -f "$private_key"
ssh-keygen -q -t ed25519 -N '' -f "$host_key"
cp "$private_key.pub" "$ssh_dir/authorized_keys"; chmod 600 "$ssh_dir/authorized_keys"
cat > "$ssh_dir/sshd_config" <<EOF
Port $port
ListenAddress 127.0.0.1
HostKey $host_key
AuthorizedKeysFile $ssh_dir/authorized_keys
PidFile $ssh_dir/sshd.pid
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers $(id -un)
StrictModes no
AllowStreamLocalForwarding yes
LogLevel ERROR
EOF
FAKE_BUN="$(command -v bun)" FAKE_FIXTURE="$repo/test/fixtures/fake-acp-agent.mjs" SETTINGS_PATH="$node_dir/settings.json" bun -e 'const fs = require("node:fs"); const settings = { providers: { fake: { command: process.env.FAKE_BUN, args: [process.env.FAKE_FIXTURE], resume: true, defaultModel: "test-model" } }, leader: { provider: "fake", model: "test-model" }, forbiddenModels: [] }; fs.writeFileSync(process.env.SETTINGS_PATH, JSON.stringify(settings) + "\n");'
NETA_DIR="$node_dir" bun "$repo/src/cli/main.ts" node start >"$output/node-start.log" 2>&1 &
node_pid=$!
for _ in $(seq 1 100); do [[ -f "$node_dir/node.json" ]] && break; sleep 0.1; done
[[ -f "$node_dir/node.json" ]] || { echo "termux-copy-loopback: Node did not start; see $output/node-start.log" >&2; exit 2; }
"${NETA_COPY_SSHD_BIN:-$(command -v sshd)}" -D -f "$ssh_dir/sshd_config" -E "$output/sshd.log" &
sshd_pid=$!
expected_fp=$(ssh-keygen -lf "$host_key.pub" | awk '{print $2}')
for _ in $(seq 1 100); do
  actual_fp=$(ssh-keyscan -p "$port" 127.0.0.1 2>/dev/null | ssh-keygen -lf - 2>/dev/null | awk '{print $2}' || true)
  if [[ -n "$actual_fp" && "$actual_fp" == "$expected_fp" ]]; then ssh-keyscan -p "$port" 127.0.0.1 >"$ssh_dir/known_hosts" 2>/dev/null; break; fi
  sleep 0.1
done
[[ -s "$ssh_dir/known_hosts" ]] || { echo "termux-copy-loopback: SSH daemon did not start; see $output/sshd.log" >&2; exit 2; }
chmod 600 "$ssh_dir/known_hosts"
if [[ "${NETA_COPY_SKIP_ADB:-0}" != 1 ]] && ! adb -s "$serial" reverse "tcp:$port" "tcp:$port" >/dev/null; then echo "termux-copy-loopback: adb reverse failed; see $output" >&2; exit 2; fi
reversed=1
cat > "$output/termux-command.txt" <<EOF
NETA_REMOTE_SSH_DESTINATION=neta-copy-loopback NETA_REMOTE_SSH_CONFIG=/data/data/com.termux/files/home/.ssh/neta-copy-loopback-config NETA_REMOTE_NETA_DIR=$node_dir NETA_REMOTE_WORKSPACE_ROOT=$workspace_dir /data/data/com.termux/files/usr/bin/neta-rmux
EOF
cat > "$output/termux-setup.txt" <<EOF
adb -s $serial shell run-as com.termux sh -c 'cat > /data/data/com.termux/files/home/.ssh/neta-copy-loopback' < $private_key
adb -s $serial shell run-as com.termux sh -c 'cat > /data/data/com.termux/files/home/.ssh/neta-copy-loopback-known-hosts' < $ssh_dir/known_hosts
In Termux, create ~/.ssh/neta-copy-loopback-config with HostName 127.0.0.1, Port $port, User $(id -un), IdentityFile ~/.ssh/neta-copy-loopback, UserKnownHostsFile ~/.ssh/neta-copy-loopback-known-hosts, and StrictHostKeyChecking yes.
EOF
printf 'prepared %s\n' "$output"
printf 'command: %s/termux-command.txt\n' "$output"
printf 'setup: %s/termux-setup.txt\n' "$output"
printf 'transcript: %s/node/conversations/*.ndjson\n' "$output"
printf 'Press Enter after the manual GUI /neta-copy check to clean owned processes and transient keys.\n'
read -r
