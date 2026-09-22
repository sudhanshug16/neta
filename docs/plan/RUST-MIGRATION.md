# Rust migration

Neta is moving to Rust inside the existing monorepo. This document records the
migration boundary; it does not claim that the Node backend or ACP execution
has been ported.

## Current boundary

The root Cargo workspace contains:

- `crates/neta-protocol`: serde domain records and the NDJSON bridge envelope
  consumed by the terminal. Its camelCase representation remains compatible
  with the current TypeScript Node snapshot.
- `crates/neta-client`: the authenticated, bounded Unix JSON-RPC client for
  the existing TypeScript Node. It owns descriptor discovery, exact launcher
  invocation, the protocol handshake, request correlation, and notification
  delivery.
- `crates/neta-terminal`: the rmux adapter boundary for key and mouse encoding,
  bounded OSC52 forwarding, and construction of the local Pi process contract.
- `apps/rmux`: the runnable Ratatui shell. It owns navigation, Node connection,
  snapshot refresh, project opening, and panes. The TypeScript command is now
  only a process launcher that supplies exact repository runtime paths.

The Rust shell may start the TypeScript Node when no service is reachable, but
does not stop it on exit. A Node that was already running remains untouched.
Moving service ownership into the native application is a later lifecycle
milestone; it is not implied by this client migration. Notification overflow
or disconnect currently stops the shell with a visible error; reconnection
must begin with a fresh snapshot when it is added.

The root workspace resolves `rmux-sdk` and `ratatui-rmux` from the pristine
`vendor/rmux` v0.10.0 tree. The installed `.cache/rmux` daemon is a separate
runtime artifact. Run `scripts/build-rmux-runtime.sh` when vendored engine
changes must become the runtime; ordinary Neta crate builds do not rebuild it.
Release CI builds those native artifacts on macOS arm64/x64 and Linux x64/arm64,
then joins them into the Node package before publishing. This boundary packages
the local terminal client and its rmux daemon only; remote Node execution is
already implemented through the existing connection contract. Android remains
outside this release matrix and requires its separate Termux packaging flow.

Compatibility is checked by root `cargo test --workspace` plus
`scripts/run-rmux-e2e.sh`. The PTY test launches `bun src/cli/main.ts rmux`,
checks resize, Backspace bytes, filtered OSC52 forwarding, and clean quit.

## Migration milestones

1. Replace the TypeScript fd3/fd4 bridge with a Rust Node client while keeping
   the existing JSON-RPC protocol and durable TypeScript service. Complete.
2. Port Node protocol handling and stores behind the same JSON representation,
   validating fixtures across Rust and TypeScript during each store migration.
3. Port ACP session supervision and the per-session tool proxy without changing
   durable session identifiers or flattening structured conversation blocks.
4. Switch the launcher and service entry points after restart, recovery, and
   multi-client compatibility tests pass; then remove superseded TypeScript.

Swift desktop code and the current TypeScript state remain in place during
these milestones. Remote ACP panes are also still pending.
