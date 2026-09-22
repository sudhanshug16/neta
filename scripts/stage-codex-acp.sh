#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
adapter="$repo/node_modules/@agentclientprotocol/codex-acp/dist/index.js"
manifest="$repo/node_modules/@agentclientprotocol/codex-acp/package.json"
if [[ ! -f "$adapter" ]] || ! grep -q '"version": "1.10.0"' "$manifest" || ! grep -q 'idleBehavior === "promptRequired"' "$adapter"; then
  echo "neta build: patched codex-acp 1.10.0 build input is missing" >&2; exit 1
fi
mkdir -p "$repo/dist"
cp "$adapter" "$repo/dist/codex-acp.mjs"
cp "$repo/node_modules/@agentclientprotocol/codex-acp/LICENSE" "$repo/dist/CODEX-ACP-LICENSE"
printf '%s\nsha256: %s\n' '@agentclientprotocol/codex-acp 1.10.0 staged from Neta patched build input (idleBehavior=promptRequired).' "$(shasum -a 256 "$adapter" | awk '{print $1}')" > "$repo/dist/CODEX-ACP-PROVENANCE.txt"
