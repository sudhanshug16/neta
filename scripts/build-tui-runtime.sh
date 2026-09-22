#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64 ;;
  Darwin-x86_64) platform=darwin-x64 ;;
  Linux-x86_64) platform=linux-x64 ;;
  Linux-aarch64) platform=linux-arm64 ;;
  *) echo "neta build:tui: unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

daemon="$repo/.cache/rmux/libexec/rmux/rmux"
if [[ ! -x "$daemon" ]] || ! "$daemon" -V | grep -qx 'rmux 0.10.0'; then
  echo "neta build:tui: rmux 0.10.0 runtime is missing; run scripts/install-rmux-runtime.sh" >&2
  exit 1
fi

adapter="$repo/node_modules/@agentclientprotocol/codex-acp/dist/index.js"
adapter_manifest="$repo/node_modules/@agentclientprotocol/codex-acp/package.json"
if [[ ! -f "$adapter" ]] || ! grep -q '"version": "1.10.0"' "$adapter_manifest" || ! grep -q 'idleBehavior === "promptRequired"' "$adapter"; then
  echo "neta build:tui: patched codex-acp 1.10.0 build input is missing" >&2
  exit 1
fi

bun run build
target_dir="${CARGO_TARGET_DIR:-$repo/target}"
CARGO_INCREMENTAL=0 cargo build --locked --manifest-path "$repo/Cargo.toml" --release -p neta-rmux --target-dir "$target_dir"
client="$target_dir/release/neta-rmux"
if [[ ! -x "$client" ]]; then
  echo "neta build:tui: release neta-rmux client was not produced: $client" >&2
  exit 1
fi

stage="$repo/dist/tui/.${platform}.stage.$$"
destination="$repo/dist/tui/$platform"
trap 'rm -rf "$stage"' EXIT
rm -rf "$stage"
mkdir -p "$stage"
cp "$client" "$stage/neta-rmux"
cp "$daemon" "$stage/rmux"
cp "$adapter" "$repo/dist/codex-acp.mjs"
cp "$repo/node_modules/@agentclientprotocol/codex-acp/LICENSE" "$repo/dist/CODEX-ACP-LICENSE"
adapter_sha256="$(shasum -a 256 "$adapter" | awk '{print $1}')"
cat > "$repo/dist/CODEX-ACP-PROVENANCE.txt" <<'EOF'
@agentclientprotocol/codex-acp 1.10.0, staged from Neta's patched build input.
The staged adapter contains Neta's steering idleBehavior=promptRequired patch.
EOF
printf 'sha256: %s\n' "$adapter_sha256" >> "$repo/dist/CODEX-ACP-PROVENANCE.txt"
cp "$repo/vendor/rmux/LICENSE" "$repo/vendor/rmux/LICENSE-APACHE" "$repo/vendor/rmux/LICENSE-MIT" "$stage/"
cat > "$stage/RMUX-PROVENANCE.txt" <<'EOF'
rmux 0.10.0 runtime, copied unchanged from .cache/rmux after version verification.
The runtime is distributed under the accompanying LICENSE, LICENSE-APACHE, and LICENSE-MIT.
EOF
bun build "$repo/src/rmux/pi-acp-extension.ts" --target=node --format=esm \
  --external '@earendil-works/*' --outfile "$stage/pi-acp-extension.mjs"
rm -rf "$destination"
mv "$stage" "$destination"
trap - EXIT
