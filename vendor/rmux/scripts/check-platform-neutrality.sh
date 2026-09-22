#!/usr/bin/env sh
set -eu

fail=0

report() {
  printf '%s\n' "$1" >&2
  fail=1
}

scan_neutral_sources() {
  roots="$1"
  if [ -z "$roots" ]; then
    return
  fi

  matches="$(
    for root in $roots; do
      [ -d "$root" ] || continue
      find "$root" -type f -name '*.rs' 2>/dev/null
    done \
      | grep -v '/target/' \
      | grep -v '/tests/' \
      | grep -v '/test/' \
      | xargs grep -In -E '#!?[[:space:]]*\[[^]]*cfg[^]]*(unix|windows|target_os|target_family)|std::os::(unix|windows)|tokio::net::(Unix|windows::named_pipe)|windows_sys|libc::|rustix::' 2>/dev/null \
      || true
  )"

  if [ -n "$matches" ]; then
    printf '%s\n' "$matches" >&2
    report "Platform-specific source references found in platform-neutral crates."
  fi
}

scan_manifest_absence() {
  manifest="$1"
  crate="$2"
  forbidden="$3"

  [ -f "$manifest" ] || return

  for name in $forbidden; do
    if grep -Eq "^[[:space:]]*${name}[[:space:]]*=" "$manifest"; then
      report "$crate must not depend directly on $name."
    fi
  done
}

scan_neutral_sources "crates/rmux-types/src crates/rmux-proto/src crates/ratatui-rmux/src"
scan_manifest_absence crates/rmux-sdk/Cargo.toml rmux-sdk "rmux-client rmux-core rmux-server rmux-pty"
scan_manifest_absence crates/ratatui-rmux/Cargo.toml ratatui-rmux "rmux-client rmux-core rmux-server rmux-pty rmux-proto rmux-ipc rmux-os"

if [ -f scripts/cfg-check.sh ]; then
  sh scripts/cfg-check.sh
else
  report "scripts/cfg-check.sh is missing."
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "Platform-neutral crate boundary check passed."
