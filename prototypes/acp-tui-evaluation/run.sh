#!/bin/sh
set -eu
artifact_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
eval_dir=/private/tmp/neta-acp-eval
mkdir -p "$eval_dir/harness/src"
if [ ! -d "$eval_dir/bitrouter/.git" ]; then
 git clone --no-checkout https://github.com/bitrouter/bitrouter.git "$eval_dir/bitrouter"
fi
test "$(git -C "$eval_dir/bitrouter" rev-parse HEAD)" = 23cc164452fe844b04919aeb93e05a83286d775c || git -C "$eval_dir/bitrouter" checkout --detach 23cc164452fe844b04919aeb93e05a83286d775c
cp "$artifact_dir/main.rs" "$eval_dir/harness/src/main.rs"
cp "$artifact_dir/Cargo.toml" "$artifact_dir/Cargo.lock" "$eval_dir/harness/"
python3 "$artifact_dir/capture.py"
: "${RUSTC:=/private/tmp/neta-herdr-tools/install/rust/bin/rustc}"
: "${CARGO_HOME:=/private/tmp/neta-rmux-cargo}"
export RUSTC CARGO_HOME
export CARGO_TARGET_DIR="$eval_dir/target"
cargo test --manifest-path "$eval_dir/bitrouter/Cargo.toml" -p bitrouter-tui --lib --locked
cargo run --manifest-path "$eval_dir/harness/Cargo.toml" --locked
