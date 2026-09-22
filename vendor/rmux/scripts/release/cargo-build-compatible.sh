#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release/cargo-build-compatible.sh --target <triple> -- <cargo arguments...>

Run Cargo normally, except for Linux GNU release builds that set
RMUX_LINUX_GLIBC_FLOOR. Those builds use the pinned cargo-zigbuild toolchain
and append the requested glibc version to the Zig target.
USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

target=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      [ "$#" -ge 2 ] || die "--target requires a value"
      target="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$target" ] || die "--target is required"
[ "$#" -gt 0 ] || die "cargo arguments are required"
[ "$1" = "build" ] || die "only cargo build is supported"
shift

glibc_floor="${RMUX_LINUX_GLIBC_FLOOR:-}"
case "$target" in
  *-unknown-linux-gnu)
    if [ -n "$glibc_floor" ]; then
      case "$glibc_floor" in
        *[!0-9.]*|.*|*.|*..*) die "invalid RMUX_LINUX_GLIBC_FLOOR: $glibc_floor" ;;
      esac
      for rustflags in "${RUSTFLAGS:-}" "${CARGO_ENCODED_RUSTFLAGS:-}"; do
        case "$rustflags" in
          *"-C linker"*|*"-Clinker"*|*"+crt-static"*)
            die "Rust flags override cargo-zigbuild's dynamic glibc linker contract"
            ;;
        esac
      done
      command -v cargo-zigbuild >/dev/null 2>&1 ||
        die "RMUX_LINUX_GLIBC_FLOOR requires cargo-zigbuild"
      exec cargo zigbuild --target "$target.$glibc_floor" "$@"
    fi
    ;;
esac

exec cargo build --target "$target" "$@"
