#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/smoke-linux-glibc-baseline.sh <rmux> <rmux-full> <rmux-daemon>

Run the three Linux GNU release binaries in an immutable Ubuntu 20.04 image.
The image carries glibc 2.31 and is pinned by its multi-architecture digest.
USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 3 ] || {
  usage >&2
  exit 2
}
[ "${RMUX_LINUX_GLIBC_FLOOR:-2.31}" = "2.31" ] ||
  die "Ubuntu 20.04 smoke only proves the contracted glibc 2.31 floor"
command -v docker >/dev/null 2>&1 || die "docker is required for the glibc baseline smoke"

image="ubuntu:20.04@sha256:8feb4d8ca5354def3d8fce243717141ce31e2c428701f6682bd2fafe15388214"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/rmux-glibc-smoke.XXXXXX")"
chmod 0755 "$work_dir"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

for source_and_name in "$1:rmux" "$2:rmux-full" "$3:rmux-daemon"; do
  source="${source_and_name%:*}"
  name="${source_and_name##*:}"
  [ -f "$source" ] || die "release binary not found: $source"
  [ -x "$source" ] || die "release binary is not executable: $source"
  cp -- "$source" "$work_dir/$name"
  chmod 0555 "$work_dir/$name"
done

docker run --rm \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --volume "$work_dir:/rmux:ro" \
  "$image" \
  /bin/sh -eu -c '
    test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.31"
    for binary in /rmux/rmux /rmux/rmux-full /rmux/rmux-daemon; do
      if ldd "$binary" | grep -q "not found"; then
        echo "unresolved dependency: $binary" >&2
        exit 1
      fi
    done
    for binary in /rmux/rmux /rmux/rmux-full; do
      "$binary" -V
    done
    if daemon_output=$(/rmux/rmux-daemon 2>&1); then
      echo "internal daemon unexpectedly accepted a public invocation" >&2
      exit 1
    fi
    test "$daemon_output" = "rmux-daemon is internal; launch it through \`rmux\`, not directly"
  '

printf 'image=%s\n' "$image"
printf 'glibc=2.31\n'
