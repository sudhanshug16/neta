#!/bin/bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd); APP_DIR=$(cd "$SCRIPT_DIR/.." && pwd); ROOT_DIR=$(cd "$APP_DIR/../.." && pwd)
OUT_DIR=${1:-$APP_DIR/.build/pi-app}; NODE_VERSION=24.20.0; NODE_SHA=b7bf7707070b950ba1ec5f1af3bb6de0f2b1962c5033973d94068ab021ef3014
mkdir -p "$OUT_DIR" "$APP_DIR/.build"; OUT_DIR=$(cd "$OUT_DIR" && pwd); APP="$OUT_DIR/NetaPiPrototype.app"; STAGE="$APP_DIR/.build/pi-runtime-stage"; cd "$ROOT_DIR"
rm -rf "$STAGE"; mkdir -p "$STAGE/patches"; cp package.json bun.lock "$STAGE/"; cp patches/@agentclientprotocol%2Fcodex-acp@1.10.0.patch "$STAGE/patches/"
(cd "$STAGE" && bun install --production --ignore-scripts >&2)
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.xz" -o "$STAGE/node.tar.xz"
echo "$NODE_SHA  $STAGE/node.tar.xz" | shasum -a 256 -c - >&2; mkdir -p "$STAGE/node"; tar -xJf "$STAGE/node.tar.xz" -C "$STAGE/node" --strip-components=1
v=$(node -p "require('./package.json').version")
build_id=$(node - <<'NODE'
const {createHash}=require('crypto'),{readFileSync,readdirSync}=require('fs'),{join}=require('path'); const files=[]; function walk(p){for(const n of readdirSync(p,{withFileTypes:true})){const q=join(p,n.name);n.isDirectory()?walk(q):files.push(q)}} walk('src');walk('patches');walk('third_party');files.push('package.json','bun.lock','apps/macos/scripts/build-pi-app.sh');const h=createHash('sha256');for(const f of files.sort()){h.update(f);h.update('\0');h.update(readFileSync(f));h.update('\0')}process.stdout.write(h.digest('hex').slice(0,24));
NODE
)
bun build --compile --define "NETA_VERSION=\"$v\"" --define "NETA_BUILD_ID=\"$build_id\"" src/cli/main.ts --outfile "$APP_DIR/.build/neta-pi" >&2
swift build -c release --package-path "$APP_DIR" >&2
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/pi-runtime/bin" "$APP/Contents/Resources/pi-runtime/node_modules" "$APP/Contents/Resources/pi-runtime/neta"
cp "$APP_DIR/.build/release/NetaDesktop" "$APP/Contents/MacOS/NetaPiPrototype"; cp "$APP_DIR/Resources/Info.plist" "$APP/Contents/Info.plist"
for f in "$APP_DIR"/Resources/*; do [ "$(basename "$f")" = Info.plist ] || cp -R "$f" "$APP/Contents/Resources/"; done
cp "$APP_DIR/.build/neta-pi" "$APP/Contents/Resources/neta"; cp src/pi/pty-host.mjs src/pi/neta-extension.ts "$APP/Contents/Resources/pi-runtime/neta/"
cp "$STAGE/node/bin/node" "$APP/Contents/Resources/pi-runtime/bin/node"; cp "$STAGE/node/LICENSE" "$APP/Contents/Resources/pi-runtime/LICENSE.node"
rsync -a --exclude='node-pty/prebuilds/win32-arm64' --exclude='node-pty/prebuilds/win32-x64' --exclude='node-pty/prebuilds/darwin-x64' --exclude='*/native/win32/prebuilds' --exclude='*/native/darwin/prebuilds/darwin-x64' --exclude='@mariozechner/clipboard-darwin-universal' "$STAGE/node_modules/" "$APP/Contents/Resources/pi-runtime/node_modules/"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier dev.neta.desktop.pi' "$APP/Contents/Info.plist"; /usr/libexec/PlistBuddy -c 'Set :CFBundleName NetaPiPrototype' "$APP/Contents/Info.plist"; /usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName Neta Pi Prototype' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $v" "$APP/Contents/Info.plist"; /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $v" "$APP/Contents/Info.plist"; /usr/libexec/PlistBuddy -c 'Set :NetaRuntime pi' "$APP/Contents/Info.plist"; /usr/libexec/PlistBuddy -c 'Add :NetaDataDirectoryName string .neta-pi-prototype' "$APP/Contents/Info.plist"; /usr/libexec/PlistBuddy -c "Add :NetaRuntimeBuild string $build_id" "$APP/Contents/Info.plist"
chmod 755 "$APP/Contents/MacOS/NetaPiPrototype" "$APP/Contents/Resources/neta" "$APP/Contents/Resources/pi-runtime/bin/node" "$APP/Contents/Resources/pi-runtime/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
while IFS= read -r binary; do codesign --force --sign - "$binary" >&2; done < <(find "$APP/Contents/Resources/pi-runtime" -type f -print0 | xargs -0 file | awk -F: '/Mach-O/{print $1}')
codesign --force --sign - "$APP/Contents/Resources/neta" >&2; codesign --force --options runtime --sign - "$APP" >&2; codesign --verify --deep --strict "$APP" >&2; echo "$APP"
