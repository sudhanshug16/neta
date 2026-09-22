#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
for platform in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
	dir="$root/dist/tui/$platform"
	for file in neta-rmux rmux pi-acp-extension.mjs LICENSE LICENSE-APACHE LICENSE-MIT RMUX-PROVENANCE.txt; do
		if [[ ! -f "$dir/$file" ]]; then
			echo "neta release: missing packaged TUI runtime $platform/$file" >&2
			exit 1
		fi
	done
	if [[ ! -x "$dir/neta-rmux" || ! -x "$dir/rmux" ]]; then
		echo "neta release: packaged TUI binaries are not executable for $platform" >&2
		exit 1
	fi
done
