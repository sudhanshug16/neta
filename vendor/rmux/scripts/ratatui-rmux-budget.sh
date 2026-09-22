#!/usr/bin/env sh
# Enforce the `ratatui-rmux` production source/dependency budget. The script
# intentionally avoids cargo so it can run in stripped CI shells; the matching
# cargo test lives in `crates/ratatui-rmux/tests/budget.rs`.
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
crate_root="$repo_root/crates/ratatui-rmux"
src_root="$crate_root/src"
manifest="$crate_root/Cargo.toml"

# Keep these values in sync with crates/ratatui-rmux/tests/budget.rs.
expected_files="lib.rs driver.rs state.rs widget.rs theme.rs"
max_files=5
max_source_lines=1500
max_direct_deps=2
forbidden_deps="rmux-client rmux-core rmux-server rmux-pty"
required_deps="rmux-sdk"

fail() {
  printf 'ratatui-rmux-budget: %s\n' "$1" >&2
  exit 1
}

# 1) The src tree contains exactly the recorded production files.
actual_files="$(cd "$src_root" && find . -maxdepth 1 -type f -name '*.rs' \
  | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' ')"
expected_sorted="$(printf '%s\n' $expected_files | LC_ALL=C sort | tr '\n' ' ')"

if [ "$actual_files" != "$expected_sorted" ]; then
  fail "production source set mismatch (expected: $expected_sorted; got: $actual_files)"
fi

# Reject any nested module subdirectory under src/.
extra_dirs="$(cd "$src_root" && find . -mindepth 1 -type d | head -1)"
if [ -n "$extra_dirs" ]; then
  fail "ratatui-rmux/src must remain flat (found subdirectory: $extra_dirs)"
fi

# 2) File count is within budget.
file_count="$(printf '%s\n' $expected_files | wc -l | tr -d ' ')"
if [ "$file_count" -gt "$max_files" ]; then
  fail "production file count $file_count exceeds budget $max_files"
fi

# 3) Aggregate non-blank source-line count.
total_lines=0
for file in $expected_files; do
  path="$src_root/$file"
  [ -f "$path" ] || fail "missing recorded production source $file"
  lines="$(grep -cv '^[[:space:]]*$' "$path" || true)"
  total_lines=$((total_lines + lines))
done
if [ "$total_lines" -gt "$max_source_lines" ]; then
  fail "production source lines $total_lines exceed budget $max_source_lines"
fi

# 4) Manifest direct-dependency check. Parse only `[dependencies]`.
deps_block="$(awk '
  /^\[dependencies\][[:space:]]*$/ { in_block = 1; next }
  /^\[/ { in_block = 0 }
  in_block { print }
' "$manifest")"

# Direct dependency names: lines of the form `name = ...`.
direct_deps="$(printf '%s\n' "$deps_block" \
  | sed -n 's/^\([A-Za-z0-9_-][A-Za-z0-9_-]*\)[[:space:]]*=.*/\1/p' \
  | LC_ALL=C sort -u)"

direct_count="$(printf '%s\n' "$direct_deps" | sed '/^$/d' | wc -l | tr -d ' ')"
if [ "$direct_count" -gt "$max_direct_deps" ]; then
  fail "direct dependency count $direct_count exceeds budget $max_direct_deps"
fi

for required in $required_deps; do
  if ! printf '%s\n' "$direct_deps" | grep -qx "$required"; then
    fail "missing required direct dependency $required"
  fi
done

for forbidden in $forbidden_deps; do
  if printf '%s\n' "$direct_deps" | grep -qx "$forbidden"; then
    fail "forbidden direct dependency $forbidden"
  fi
done

# Exactly one ratatui-family surface dependency.
ratatui_count="$(printf '%s\n' "$direct_deps" | grep -c '^ratatui' || true)"
if [ "$ratatui_count" -ne 1 ]; then
  fail "expected exactly one ratatui* direct dependency, found $ratatui_count"
fi

# 5) Reject any `[target.'cfg(...)'.dependencies]` block — the budget covers
# total direct deps and platform-deferred deps would silently grow it.
if grep -qE '^\[target\.[^]]+\.dependencies\]' "$manifest"; then
  fail "ratatui-rmux must not declare [target.'cfg(...)'.dependencies]"
fi

# 6) Sanity: the crate keeps forbid(unsafe_code).
if ! grep -q '#!\[forbid(unsafe_code)\]' "$src_root/lib.rs"; then
  fail "lib.rs must keep #![forbid(unsafe_code)]"
fi

# 7) Structural async/I/O containment. The widget/state/theme modules are
#    the documented sync surface; if async or I/O primitives leak in, the
#    render-purity contract no longer holds.
sync_modules="widget.rs state.rs theme.rs"
banned_tokens='async fn|\.await|tokio::|use tokio|Instant::now|SystemTime::now|std::time|std::thread|std::net|UnixStream|TcpStream|spawn\(|subscribe\('

for module in $sync_modules; do
  path="$src_root/$module"
  # Strip line-comment-only lines first so doc-comments don't trigger.
  if grep -Ev '^[[:space:]]*//' "$path" \
    | grep -E "$banned_tokens" >/dev/null 2>&1; then
    fail "$module contains an async/I/O primitive that breaks render purity"
  fi
done

# Driver remains the sole async entry point.
if ! grep -q 'pub async fn refresh' "$src_root/driver.rs"; then
  fail "driver.rs must expose `pub async fn refresh` as the sole async entry point"
fi

printf 'ratatui-rmux-budget: OK (files=%s lines=%s direct_deps=%s)\n' \
  "$file_count" "$total_lines" "$direct_count"
