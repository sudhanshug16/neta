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
build_id=$(node - <<'NODE'
const {createHash}=require('crypto'),{readFileSync,readdirSync}=require('fs'),{join}=require('path');
const files=[]; function walk(p){for(const n of readdirSync(p,{withFileTypes:true})){const q=join(p,n.name);n.isDirectory()?walk(q):files.push(q)}}
walk('src'); walk('patches'); walk('third_party'); files.push('package.json','bun.lock','apps/macos/scripts/build-app.sh');
const h=createHash('sha256'); for(const f of files.sort()){h.update(f);h.update('\0');h.update(readFileSync(f));h.update('\0')} process.stdout.write(h.digest('hex').slice(0,24));
NODE
)

echo "building neta CLI..." >&2
# Bake the version in: the exe ships with no package.json beside it.
bun build --compile --define "NETA_VERSION=\"$v\"" --define "NETA_BUILD_ID=\"$build_id\"" src/cli/main.ts --outfile "$APP_DIR/.build/neta" >&2
bun build --compile node_modules/@agentclientprotocol/codex-acp/dist/index.js --outfile "$APP_DIR/.build/codex-acp-neta" >&2
codex_platform=$(node -p "require('path').dirname(require.resolve('@openai/codex-'+process.platform+'-'+process.arch+'/package.json'))")
codex_vendor=$(find "$codex_platform/vendor" -mindepth 1 -maxdepth 1 -type d | head -1)
test -n "$codex_vendor"

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
cp "$APP_DIR/.build/codex-acp-neta" "$APP/Contents/Resources/codex-acp-neta"
cp -R "$codex_vendor" "$APP/Contents/Resources/codex-runtime"
mkdir -p "$APP/Contents/Resources/ThirdParty/codex-acp"
cp third_party/codex-acp/NOTICE.md "$APP/Contents/Resources/ThirdParty/codex-acp/NOTICE.md"
cp node_modules/@agentclientprotocol/codex-acp/LICENSE "$APP/Contents/Resources/ThirdParty/codex-acp/LICENSE"
chmod 755 "$APP/Contents/Resources/neta"
chmod 755 "$APP/Contents/Resources/codex-acp-neta" "$APP/Contents/Resources/codex-runtime/bin/codex"

/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $v" "$APP/Contents/Info.plist" >&2
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $v" "$APP/Contents/Info.plist" >&2
/usr/libexec/PlistBuddy -c "Add :NetaRuntimeBuild string $build_id" "$APP/Contents/Info.plist" >&2

echo "ad-hoc signing..." >&2
for helper in "$APP/Contents/Resources/codex-runtime/codex-path/rg" "$APP/Contents/Resources/codex-runtime/bin/codex-code-mode-host" "$APP/Contents/Resources/codex-runtime/bin/codex" "$APP/Contents/Resources/codex-acp-neta"; do
  if [ -f "$helper" ]; then codesign --force --sign - "$helper" >&2; fi
done
codesign --force --sign - "$APP/Contents/Resources/neta" >&2
codesign --force --options runtime --sign - "$APP" >&2
codesign --verify --deep --strict "$APP" >&2

echo "$APP"
