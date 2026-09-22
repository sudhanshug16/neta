#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
build_dir="${CARGO_TARGET_DIR:-$repo/target/rmux-upstream}"
cargo build --manifest-path "$repo/vendor/rmux/Cargo.toml" --locked --release --bin rmux --target-dir "$build_dir"
runtime="$repo/.cache/rmux"
stage="$runtime.stage.$$"
backup="$runtime.previous.$$"
cleanup() {
  rm -rf "$stage"
  if [[ ! -e "$runtime" && -e "$backup" ]]; then mv "$backup" "$runtime"; fi
}
trap cleanup EXIT
mkdir -p "$stage/bin" "$stage/libexec/rmux"
cp "$build_dir/release/rmux" "$stage/bin/rmux"
cp "$build_dir/release/rmux" "$stage/libexec/rmux/rmux"
"$stage/bin/rmux" -V
if [[ -e "$runtime" ]]; then mv "$runtime" "$backup"; fi
mv "$stage" "$runtime"
if [[ -e "$backup" ]]; then rm -rf "$backup"; fi
trap - EXIT
"$runtime/bin/rmux" -V
