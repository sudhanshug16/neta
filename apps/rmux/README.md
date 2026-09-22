# Neta rmux prototype

`bun src/cli/main.ts rmux` opens the native terminal shell. The TypeScript
command only supplies exact bundled runtime paths and starts the Rust process.
Rust reads the Node descriptor, performs the authenticated Unix JSON-RPC
handshake, opens the current project, and refreshes snapshots. There is no
fd3/fd4 data bridge. The right pane is the real Pi interactive TUI running in
an isolated rmux 0.10.0 daemon.

`cargo run -p neta-rmux` also works from a source checkout. It resolves Bun,
the TypeScript service entry point, Pi, and the installed rmux daemon to exact
paths and fails with a concrete missing-path message. The shell starts a Node
on demand and leaves the service running when the shell exits. Fully native
service ownership and reconnect-after-disconnect remain migration work.

Install the pinned runtime once with `scripts/install-rmux-runtime.sh`, then
build with `cargo build --workspace`. The public Rust
dependencies are pinned in `Cargo.toml`; `ratatui-rmux` and `rmux-sdk` are
0.10.0 and Ratatui is 0.29.0.

The public widget renders text, attributes, and the cursor. A separate bounded
live-output parser forwards only complete OSC 52 clipboard writes from the
active pane; it rejects clipboard reads and other terminal control messages.
Image protocol output is not exposed by `PaneState` and remains unsupported.
Pane mouse reports and bracketed paste are forwarded explicitly. Remote ACP
execution is a separate integration.
