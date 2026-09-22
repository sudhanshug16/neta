#!/usr/bin/env bash
set -euo pipefail

version=0.10.0
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) archive="rmux-${version}-macos-aarch64.tar.gz" ;;
  Darwin-x86_64) archive="rmux-${version}-macos-x86_64.tar.gz" ;;
  Linux-x86_64) archive="rmux-${version}-linux-x86_64.tar.gz" ;;
  Linux-aarch64) archive="rmux-${version}-linux-aarch64.tar.gz" ;;
  *) echo "unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
root="$(cd "$(dirname "$0")/.." && pwd)"
destination="$root/.cache/rmux"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
curl --fail --location --silent --show-error "https://github.com/Helvesec/rmux/releases/download/v${version}/${archive}" --output "$temporary/$archive"
tar -xzf "$temporary/$archive" -C "$temporary"
package="$(find "$temporary" -mindepth 1 -maxdepth 1 -type d -name 'rmux-*' -print -quit)"
rm -rf "$destination"
mkdir -p "$destination"
cp -R "$package/bin" "$package/libexec" "$destination/"
"$destination/bin/rmux" -V
