# Termux rmux client

This package is a native Termux terminal client. It renders the Neta shell and
runs Pi on the Android device, while the Neta Node remains on a remote machine.
It does not bundle a Neta backend on Android.

The staged layout is relocatable:

```text
PREFIX/
  bin/neta-rmux
  lib/neta-rmux/neta-rmux
  lib/neta-rmux/rmux
  lib/neta-rmux/pi-runtime/neta-acp-extension.mjs
  lib/neta-rmux/pi-runtime/node_modules/
```

Build the Android `aarch64-linux-android` client and matching rmux daemon in
an isolated Rust installation. The daemon must be an Android binary, never the
generic Linux aarch64 release consumed by `scripts/install-rmux-runtime.sh`.

The following uses Rust 1.89.0 and NDK r27b without changing the host Rust
installation. `prepare-termux-rmux-android-build.sh` copies the Rust workspace
to its destination and applies the reviewed Android overlay there.

```sh
export RUSTUP_HOME=/private/tmp/neta-android-rustup
export CARGO_HOME=/private/tmp/neta-rmux-cargo
export PATH=/private/tmp/neta-android-cargo/bin:$PATH
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=/Users/runner/android_sdk/ndk/27.1.12297006/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android24-clang

scripts/prepare-termux-rmux-android-build.sh /private/tmp/neta-rmux-android-build
cargo +1.89.0 build --offline --manifest-path /private/tmp/neta-rmux-android-build/Cargo.toml --target aarch64-linux-android -p neta-rmux --target-dir /private/tmp/neta-rmux-android-build/target
cargo +1.89.0 build --offline --manifest-path /private/tmp/neta-rmux-android-build/vendor/rmux/Cargo.toml --target aarch64-linux-android --bin rmux --target-dir /private/tmp/neta-rmux-android-build/target-rmux
```

The overlay uses Rustix's Android-supported `ptsname` path for PTYs, keeps
Linux's `TIOCGPTPEER` optimization Linux-only, and uses portable signal-hook
resize handling. It also avoids Bionic's unavailable `nl_langinfo` API. This
validates cross-compilation only; it does not validate execution on an Android
device.

The staged Pi runtime contains a separate manifest with exact Pi versions. On
Termux, install its production closure locally; it must never be the repository
`node_modules` tree. The launcher needs no Bun or Cargo at runtime. The
transitive Android closure is not yet reproducible until Android packaging owns
one; device setup intentionally avoids adding an npm lockfile to this repo.

Then stage the package:

```sh
NETA_RMUX_ANDROID_BINARY=/path/to/neta-rmux \
RMUX_ANDROID_DAEMON=/path/to/rmux \
scripts/prepare-termux-rmux.sh /path/to/stage
```

Copy the staged `bin` and `lib` tree into the Termux prefix. On device install
the runtime prerequisites with `pkg install nodejs openssh`, then run
`(cd "$PREFIX/lib/neta-rmux/pi-runtime" && npm install --omit=dev --package-lock=false)`. Pi requires
Node 22.19 or newer. The launcher requires these remote connection values:

```sh
export NETA_REMOTE_SSH_DESTINATION=user@server
export NETA_REMOTE_NETA_DIR=/home/user/.neta
export NETA_REMOTE_WORKSPACE_ROOT=/home/user/project
neta-rmux
```

It sets `TMPDIR` and `RMUX_TMPDIR` to the Termux prefix temporary directory,
sets exact local Pi and rmux paths, and creates the existing SSH Unix-socket
forward to the remote Node. With its required remote variables present, the
Rust client selects its remote connection path and does not launch a local
Node service.

This is packaging preparation, not Android validation. A real Termux device
must still verify the Android rmux daemon, PTY resize, OpenSSH Unix-socket
forwarding, Pi startup, and behavior after Android suspends the terminal.

## Copying a remote response

In rmux, press `Ctrl+Space` to focus navigation, then `c` to enter the full
Pi copy view. Type `/neta-copy` in Pi and press Enter. The command selects the
latest current remote agent response from the ACP conversation, preserving its
Unicode and source newlines, and reports whether the copy operation was
accepted. Press `Ctrl+Space` to leave the copy view and return to navigation.

The copy helper first uses Termux's optional `termux-clipboard-set` command.
When that is unavailable or fails, it emits an OSC 52 clipboard sequence
through the terminal connection. Android's native text selection is a separate
fallback and may flatten newlines. Emitting OSC 52 or receiving a success from
the helper does not verify that Android's clipboard application accepted or
retained the text.
