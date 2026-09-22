#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/neta-remote-ssh.XXXXXX")
bundle_dir="$tmp/repo/runtime"
remote="/tmp/neta-remote-ssh-$$"
container="neta-remote-sshd-$$"
ssh_host='root@dabba'
remote_prepared=0
cleanup() {
  if [ "$remote_prepared" -eq 1 ]; then
    ssh -o BatchMode=yes -o ConnectTimeout=10 "$ssh_host" "docker rm -f '$container' >/dev/null 2>&1 || true; rm -rf '$remote'" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM
mkdir -p "$bundle_dir"
bun build "$repo/src/cli/main.ts" --target=node --format=esm --outfile "$bundle_dir/main.js"
bun build "$repo/test/fixtures/fake-acp-agent.mjs" --target=node --format=esm --outfile "$bundle_dir/fake-acp-agent.mjs"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$ssh_host" "umask 077; mkdir -p '$remote/image' '$remote/repo' '$remote/keys' '$remote/neta'"
remote_prepared=1
tar -C "$repo/test/fixtures/remote-sshd" -cf - Dockerfile entrypoint.sh | ssh -o BatchMode=yes -o ConnectTimeout=10 "$ssh_host" "tar -xf - -C '$remote/image'"
tar -C "$tmp/repo" -cf - runtime | ssh -o BatchMode=yes -o ConnectTimeout=10 "$ssh_host" "tar -xf - -C '$remote/repo'"
ssh-keygen -q -t ed25519 -N '' -f "$tmp/id_ed25519"
cat "$tmp/id_ed25519.pub" | ssh -o BatchMode=yes -o ConnectTimeout=10 "$ssh_host" "cat > '$remote/keys/authorized_keys'; chmod 600 '$remote/keys/authorized_keys'"
cat <<'SETTINGS' | ssh -o BatchMode=yes -o ConnectTimeout=10 "$ssh_host" "cat > '$remote/neta/settings.json'"
{"providers":{"fake":{"command":"/usr/local/bin/node","args":["/repo/runtime/fake-acp-agent.mjs"],"resume":true,"defaultModel":"test-model"}},"leader":{"provider":"fake","model":"test-model"},"forbiddenModels":[]}
SETTINGS
ssh -o BatchMode=yes -o ConnectTimeout=10 "$ssh_host" "docker build -q -t neta-remote-sshd-test '$remote/image' >/dev/null; docker run -d --rm --name '$container' -p 127.0.0.1::22 -v '$remote/repo:/repo:ro' -v '$remote/keys:/keys:ro' -v '$remote/neta:/neta' neta-remote-sshd-test >/dev/null"
port=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$ssh_host" "docker port '$container' 22/tcp" | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p')
host_key=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$ssh_host" "docker exec '$container' cat /etc/ssh/ssh_host_ed25519_key.pub")
printf 'neta-remote-test %s\n' "$host_key" > "$tmp/known_hosts"
cat > "$tmp/config" <<CONFIG
Host neta-remote-test
  HostName neta-remote-test
  User root
  IdentityFile $tmp/id_ed25519
  IdentitiesOnly yes
  UserKnownHostsFile $tmp/known_hosts
  StrictHostKeyChecking yes
  ForwardAgent no
  ProxyCommand ssh -o BatchMode=yes -o ConnectTimeout=10 root@dabba -W 127.0.0.1:$port
CONFIG
NETA_REMOTE_INTEGRATION=1 NETA_REMOTE_SSH_DESTINATION=neta-remote-test \
NETA_REMOTE_SSH_CONFIG="$tmp/config" NETA_REMOTE_NETA_DIR=/neta \
NETA_REMOTE_NODE_EXECUTABLE=/usr/local/bin/node NETA_REMOTE_NODE_ARGS_JSON='["/repo/runtime/main.js"]' \
NETA_REMOTE_WORKSPACE_ROOT=/repo PATH="/Users/runner/homebrew/bin:/Users/runner/.bun/bin:$PATH" \
CARGO_HOME=/private/tmp/neta-rmux-cargo cargo test -p neta-client remote_ssh_bundle -- --ignored --nocapture
