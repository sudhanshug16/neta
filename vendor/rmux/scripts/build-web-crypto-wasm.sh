#!/usr/bin/env bash
# Reproducible build of the rmux-web-crypto WASM blob shipped by rmux-web-share.
#
# The committed blob is the E2EE primitive the browser trusts, so it must be
# re-derivable from this Rust source. Determinism comes from:
#   - the pinned wasm-bindgen version in Cargo.lock (kept in lockstep with the
#     wasm-bindgen-cli wasm-pack downloads),
#   - wasm-pack's PINNED prebuilt wasm-bindgen binary, which emits the final
#     .wasm/.js — NOTE: a source-built `cargo install wasm-bindgen-cli` of the same
#     version produces a different .wasm, so run this with no conflicting
#     wasm-bindgen on PATH (let wasm-pack use its own prebuilt),
#   - wasm-opt disabled (set in crates/rmux-web-crypto/Cargo.toml metadata), and
#   - the pinned Rust toolchain (rust-toolchain.toml / RUSTUP_TOOLCHAIN).
#
# Usage:
#   scripts/build-web-crypto-wasm.sh [wasm|wasm-test]   # default: wasm
#
#   wasm       -> production blob (ClientSession only), consumed by
#                 rmux-web-share/src/scripts/share/wasm/
#   wasm-test  -> Playwright-only blob (exposes ServerSession), consumed by
#                 rmux-web-share/src/scripts/share/wasm-test/
#
# After building, copy pkg/{rmux_web_crypto_wasm_bg.wasm,rmux_web_crypto_wasm.js}
# into the matching rmux-web-share dir and update that dir's PROVENANCE.json:
# set artifacts.* to the printed hashes and source.source_commit to the printed
# rmux commit. rmux-web-share's scripts/verify-wasm-provenance.mjs then enforces
# the match on every build (fail-closed).
set -euo pipefail

FEATURES="${1:-wasm}"
case "${FEATURES}" in
  wasm | wasm-test) ;;
  *)
    echo "error: feature set must be 'wasm' or 'wasm-test', got '${FEATURES}'" >&2
    exit 2
    ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "error: wasm-pack not found. Install the version matching wasm-bindgen in Cargo.lock:" >&2
  wb_version="$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/[" ]/,"",$3); print $3; exit}' Cargo.lock)"
  echo "  cargo install wasm-pack --locked" >&2
  echo "  (wasm-pack pulls wasm-bindgen-cli ${wb_version} to match Cargo.lock)" >&2
  exit 1
fi

RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.94.1}" \
wasm-pack build crates/rmux-web-crypto \
  --release \
  --target web \
  --out-name rmux_web_crypto_wasm \
  -- \
  --locked \
  --no-default-features \
  --features "${FEATURES}"

pkg="crates/rmux-web-crypto/pkg"
echo
echo "built ${FEATURES} blob from rmux commit $(git rev-parse HEAD)"
echo "wasm-bindgen: $(awk '/^name = "wasm-bindgen"$/{getline; gsub(/[" ]/,"",$3); print $3; exit}' Cargo.lock)"
for f in rmux_web_crypto_wasm_bg.wasm rmux_web_crypto_wasm.js; do
  printf 'sha256:%s  %s\n' "$(sha256sum "${pkg}/${f}" | cut -d' ' -f1)" "${f}"
done
