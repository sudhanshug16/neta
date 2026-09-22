#!/usr/bin/env bash
# Assemble a relocatable Termux rmux client from prebuilt Android binaries.
set -euo pipefail

if [ "$#" -ne 1 ]; then
	printf 'usage: %s DESTINATION\n' "$0" >&2
	exit 2
fi

repo="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
destination="$1"
client="${NETA_RMUX_ANDROID_BINARY:-}"
daemon="${RMUX_ANDROID_DAEMON:-}"

need_file() {
	if [ -z "$2" ] || [ ! -f "$2" ] || [ ! -x "$2" ]; then
		printf 'prepare-termux-rmux: %s must name an executable file\n' "$1" >&2
		exit 2
	fi
}

need_file NETA_RMUX_ANDROID_BINARY "$client"
need_file RMUX_ANDROID_DAEMON "$daemon"
if ! command -v bun >/dev/null 2>&1; then
	printf 'prepare-termux-rmux: Bun is required only to bundle the release extension\n' >&2
	exit 127
fi

parent="$(dirname -- "$destination")"
mkdir -p "$parent"
stage="$(mktemp -d "$parent/.neta-rmux-termux.XXXXXX")"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

mkdir -p "$stage/bin" "$stage/lib/neta-rmux/pi-runtime"
cp "$repo/packages/termux/neta-rmux/neta-rmux" "$stage/bin/neta-rmux"
chmod 755 "$stage/bin/neta-rmux"
cp "$client" "$stage/lib/neta-rmux/neta-rmux"
cp "$daemon" "$stage/lib/neta-rmux/rmux"
cp "$repo/packages/termux/neta-rmux/pi-runtime/package.json" "$stage/lib/neta-rmux/pi-runtime/package.json"
bun build "$repo/src/rmux/pi-acp-extension.ts" --target=node --format=esm \
	--external '@earendil-works/*' --outfile "$stage/lib/neta-rmux/pi-runtime/neta-acp-extension.mjs"

if [ -e "$destination" ]; then
	printf 'prepare-termux-rmux: destination already exists: %s\n' "$destination" >&2
	exit 2
fi
mv "$stage" "$destination"
trap - EXIT
