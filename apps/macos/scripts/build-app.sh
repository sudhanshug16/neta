#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_root=$(dirname -- "$script_dir")
repo_root=$(CDPATH= cd -- "$app_root/../.." && pwd)
configuration=${1:-debug}

(cd "$repo_root" && bun run build)
(cd "$repo_root" && bun build --compile src/desktop-cli.ts --outfile "$app_root/.build/neta-desktop-bridge")
swift build --package-path "$app_root" --configuration "$configuration"
bin_path=$(swift build --package-path "$app_root" --configuration "$configuration" --show-bin-path)
bundle_path="$bin_path/NetaDesktop.app"

if [ -d "$bundle_path" ]; then
	rm -r -- "$bundle_path"
fi

install -d "$bundle_path/Contents/MacOS"
install -d "$bundle_path/Contents/Resources"
install -m 755 "$bin_path/NetaDesktop" "$bundle_path/Contents/MacOS/NetaDesktop"
install -m 755 "$app_root/.build/neta-desktop-bridge" "$bundle_path/Contents/Resources/neta-bridge"
install -m 644 "$app_root/Resources/Info.plist" "$bundle_path/Contents/Info.plist"

printf '%s\n' "$bundle_path"
