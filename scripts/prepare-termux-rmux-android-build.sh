#!/usr/bin/env bash
# Stage the Rust sources so Android builds resolve rmux through the PTY overlay.
set -euo pipefail

if [ "$#" -ne 1 ]; then
	printf 'usage: %s DESTINATION\n' "$0" >&2
	exit 2
fi

repo="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
destination="$1"
overlay_script="$repo/scripts/prepare-termux-rmux-overlay.sh"

if [ -e "$destination" ]; then
	printf 'prepare-termux-rmux-android-build: destination already exists: %s\n' "$destination" >&2
	exit 2
fi

parent="$(dirname -- "$destination")"
mkdir -p "$parent"
stage="$(mktemp -d "$parent/.neta-rmux-android-build.XXXXXX")"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

cp "$repo/Cargo.toml" "$repo/Cargo.lock" "$stage/"
mkdir -p "$stage/apps" "$stage/crates"
cp -R "$repo/apps/rmux" "$stage/apps/rmux"
for crate in neta-client neta-protocol neta-terminal; do
	cp -R "$repo/crates/$crate" "$stage/crates/$crate"
done
"$overlay_script" "$stage/vendor/rmux"

cargo metadata --offline --no-deps --format-version 1 --manifest-path "$stage/Cargo.toml" >/dev/null
mv "$stage" "$destination"
trap - EXIT

printf '%s\n' "Prepared Android build tree at $destination"
printf '%s\n' "Build Neta: cargo build --manifest-path $destination/Cargo.toml --target aarch64-linux-android -p neta-rmux"
printf '%s\n' "Build daemon: cargo build --manifest-path $destination/vendor/rmux/Cargo.toml --target aarch64-linux-android --bin rmux"
