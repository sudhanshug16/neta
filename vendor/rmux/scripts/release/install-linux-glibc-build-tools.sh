#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release/install-linux-glibc-build-tools.sh <prefix> [receipt]

Install the pinned cargo-zigbuild and Zig wheels into a fresh virtual
environment. The optional receipt records the exact linker identities and the
hash of the fully hashed requirements file.
USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "no SHA256 tool found"
  fi
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || {
  usage >&2
  exit 2
}

prefix="$1"
receipt="${2:-}"
case "$prefix" in
  ""|/|.) die "tool prefix must be a dedicated non-root path" ;;
esac
[ ! -e "$prefix" ] || die "tool prefix already exists: $prefix"
command -v python3 >/dev/null 2>&1 || die "python3 is required"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
requirements="$repo_root/scripts/release/linux-glibc-build-requirements.txt"
[ -f "$requirements" ] || die "missing hashed requirements: $requirements"

python3 -m venv "$prefix"
"$prefix/bin/python" -m pip install \
  --disable-pip-version-check \
  --no-deps \
  --only-binary=:all: \
  --require-hashes \
  --requirement "$requirements"

cargo_zigbuild_version="$("$prefix/bin/cargo-zigbuild" --version)"
zig_version="$("$prefix/bin/python" -m ziglang version)"
[ "$cargo_zigbuild_version" = "cargo-zigbuild 0.23.0" ] ||
  die "unexpected cargo-zigbuild identity: $cargo_zigbuild_version"
[ "$zig_version" = "0.15.2" ] || die "unexpected Zig identity: $zig_version"

printf '%s\n' "$cargo_zigbuild_version" "zig $zig_version"

if [ -n "$receipt" ]; then
  receipt_parent="$(dirname "$receipt")"
  [ -d "$receipt_parent" ] || die "receipt parent does not exist: $receipt_parent"
  requirements_sha256="$(sha256_file "$requirements")"
  {
    printf 'cargo_zigbuild=0.23.0\n'
    printf 'zig=0.15.2\n'
    printf 'requirements_sha256=%s\n' "$requirements_sha256"
    printf 'glibc_target=%s\n' "${RMUX_LINUX_GLIBC_FLOOR:-2.31}"
  } > "$receipt"
fi
