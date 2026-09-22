#!/usr/bin/env bash
# Prepare an Android-specific copy of the vendored rmux workspace.
set -euo pipefail

if [ "$#" -ne 1 ]; then
	printf 'usage: %s DESTINATION\n' "$0" >&2
	exit 2
fi

repo="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
source="$repo/vendor/rmux"
patch_file="$repo/packages/termux/neta-rmux/patches/rmux-android-pty.patch"
destination="$1"
mod_file="crates/rmux-pty/src/backend/mod.rs"
linux_file="crates/rmux-pty/src/backend/linux.rs"
process_file="crates/rmux-os/src/process.rs"
resize_file="crates/rmux-client/src/attach/resize.rs"
locale_file="src/process_locale.rs"
socket_access_file="crates/rmux-server/src/unix_socket_access.rs"
expected_mod_hash="0fcc4d25f5028f0c0812b87220de91e28bfa46374f3618ee9c4d3e6b2967802d"
expected_linux_hash="ac8bf29f3f91e758f7a2f50ea8cf4a0d32ba7fc8ae8a15a8edc021bb685545f0"
expected_process_hash="7db08e1544225b43741c78fb255563505cbc4f2cec99011d8b19da30e0eaa3de"
expected_resize_hash="8248621ef04a57530328bd7fd842f18297d46fd26e70b54cc61e1aca6977db3d"
expected_locale_hash="e4c36c619ae1ca87781182bab3e7d575217d644bbe86031a1bab7b970fa4be46"
expected_socket_access_hash="06b96c474a199c191d5e35c26fc5152b97a922a92cfdd2ded0e7e889c7685807"

if [ ! -d "$source" ] || [ ! -f "$patch_file" ]; then
	printf 'prepare-termux-rmux-overlay: vendored rmux source or Android patch is missing\n' >&2
	exit 2
fi
if [ -e "$destination" ]; then
	printf 'prepare-termux-rmux-overlay: destination already exists: %s\n' "$destination" >&2
	exit 2
fi

hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }
if [ "$(hash_file "$source/$mod_file")" != "$expected_mod_hash" ] || \
	[ "$(hash_file "$source/$linux_file")" != "$expected_linux_hash" ] || \
	[ "$(hash_file "$source/$process_file")" != "$expected_process_hash" ] || \
	[ "$(hash_file "$source/$resize_file")" != "$expected_resize_hash" ] || \
	[ "$(hash_file "$source/$locale_file")" != "$expected_locale_hash" ] || \
	[ "$(hash_file "$source/$socket_access_file")" != "$expected_socket_access_hash" ]; then
	printf 'prepare-termux-rmux-overlay: vendored rmux differs from the reviewed upstream revision\n' >&2
	exit 2
fi

parent="$(dirname -- "$destination")"
mkdir -p "$parent"
stage="$(mktemp -d "$parent/.rmux-android-overlay.XXXXXX")"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

cp -R "$source" "$stage/rmux"
patch --batch --forward -p1 -d "$stage/rmux" < "$patch_file"

if ! grep -Fq 'target_os = "android"' "$stage/rmux/$mod_file" || \
	! grep -Fq 'open_slave_by_name(master)' "$stage/rmux/$linux_file" || \
	! grep -Fq 'mod android_impl' "$stage/rmux/$process_file" || \
	! grep -Fq 'target_os = "android"' "$stage/rmux/$resize_file" || \
	! grep -Fq 'not(target_os = "android")' "$stage/rmux/$locale_file" || \
	! grep -Fq 'OFlags::PATH | OFlags::DIRECTORY' "$stage/rmux/$socket_access_file"; then
	printf 'prepare-termux-rmux-overlay: Android PTY patch verification failed\n' >&2
	exit 1
fi
if [ "$(hash_file "$source/$mod_file")" != "$expected_mod_hash" ] || \
	[ "$(hash_file "$source/$linux_file")" != "$expected_linux_hash" ] || \
	[ "$(hash_file "$source/$process_file")" != "$expected_process_hash" ] || \
	[ "$(hash_file "$source/$resize_file")" != "$expected_resize_hash" ] || \
	[ "$(hash_file "$source/$locale_file")" != "$expected_locale_hash" ] || \
	[ "$(hash_file "$source/$socket_access_file")" != "$expected_socket_access_hash" ]; then
	printf 'prepare-termux-rmux-overlay: source vendor tree changed while preparing overlay\n' >&2
	exit 1
fi

mv "$stage/rmux" "$destination"
trap - EXIT
rm -rf "$stage"
