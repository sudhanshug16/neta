#!/bin/bash
# Build a runnable NetaDesktop.app bundle.
#
# Usage: build-app.sh [output-dir]
#
# Assembles $OUTPUT_DIR/NetaDesktop.app (default
# apps/macos/.build/NetaDesktop.app) containing the Swift app plus the
# compiled `neta` CLI at Contents/Resources/neta, stamps the version from
# package.json, and ad-hoc signs the result. Prints the bundle's absolute
# path as its last line and nothing else on stdout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/../.." && pwd)"
cd "$ROOT_DIR"

OUT_DIR="${1:-$APP_DIR/.build}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
APP="$OUT_DIR/NetaDesktop.app"

# One read of package.json for both the baked-in NETA_VERSION and the plist.
v=$(node -p "require('./package.json').version")

echo "building neta CLI..." >&2
# Bake the version in: the exe ships with no package.json beside it.
bun build --compile --define "NETA_VERSION=\"$v\"" src/cli/main.ts --outfile "$APP_DIR/.build/neta" >&2

echo "building NetaDesktop (release)..." >&2
swift build -c release --package-path "$APP_DIR" >&2

echo "assembling $APP..." >&2
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$APP_DIR/.build/release/NetaDesktop" "$APP/Contents/MacOS/NetaDesktop"
cp "$APP_DIR/Resources/Info.plist" "$APP/Contents/Info.plist"
for f in "$APP_DIR"/Resources/*; do
  if [ "$(basename "$f")" != "Info.plist" ]; then
    cp -R "$f" "$APP/Contents/Resources/"
  fi
done
cp "$APP_DIR/.build/neta" "$APP/Contents/Resources/neta"
chmod 755 "$APP/Contents/Resources/neta"

/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $v" "$APP/Contents/Info.plist" >&2
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $v" "$APP/Contents/Info.plist" >&2

echo "ad-hoc signing..." >&2
codesign --force --sign - "$APP/Contents/Resources/neta" >&2
codesign --force --options runtime --sign - "$APP" >&2
codesign --verify --deep --strict "$APP" >&2

echo "$APP"
