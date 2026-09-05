# Worktrunk service discovery fix — 2026-09-05

The delivery is `/Users/runner/NetaDesktop-worktrunk-fix.zip`, built from
`/private/tmp/neta-worktrunk-20260905/NetaDesktop.app`. Its SHA-256 is
`86def3f933de12772e5e6eee1d504f7667ad82ac318e85ca9892dda5069a07ea`; the
bundled runtime build is `778f26be3c8f02568ab3f997`. The extracted app at
`/private/tmp/neta-worktrunk-extracted-20260905/NetaDesktop.app` passed
deep/strict signature verification.

## What changed

The macOS app starts Neta's Node service from Finder's minimal environment.
The Worktrunk runner previously launched bare `wt` using only that inherited
`PATH`, so a valid Homebrew installation at `/opt/homebrew/bin/wt` was invisible
and `neta_mission` failed before creating its Git worktree.

Every Worktrunk invocation now searches the inherited path plus
`~/.local/bin`, `~/.cargo/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, and the
system binary directories. An explicit `NETA_WT_BIN` remains authoritative.
This applies equally after a fresh service start or provider/session resume
because the path is derived at each process launch. If Worktrunk is absent,
mission creation reports a direct installation error instead of an opaque
spawn failure.

The workspace-leader brief now tells leaders to create and delegate sustained
missions before broad exploration or repeated reads. Existing sessions receive
the same instruction through the refreshed `neta_mission` tool catalog when
their provider reconnects after the service update. This improves orchestration
guidance; it cannot guarantee that a language model always follows it.

The native chat header now derives `Responding` from the selected transcript's
open turn. A durable Leader record that remains `Idle` no longer makes the
header claim the leader is idle during a response.

## Verification

- Backend: 543 passed, 0 failed, 2,721 expectations. Log:
  `/private/tmp/neta-worktrunk-bun.log`.
- Desktop: 489 passed, 0 failed. Log:
  `/private/tmp/neta-worktrunk-swift.log`.
- `bun run check`, `bun run typecheck`, and `git diff --check`: passed.
- Signed-app fake-provider smoke passed rich terminal turns, cancellation,
  disconnect and recovery terminal turns, and monotonic sequence checks.
  Evidence: `/private/tmp/neta-worktrunk-smoke-20260905`.
- With `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, the real Worktrunk v0.72.0 at a
  standard per-user location created, verified, and removed an isolated
  temporary Git worktree through `WorktrunkDriver`, the driver used by
  `neta_mission`. A deterministic regression also covers the reproduced
  `/opt/homebrew/bin` location.

The real Worktrunk check exercises the worktree driver rather than a complete
signed-app Git mission. No user repository or paid provider was used.

This delivery includes and preserves the earlier unrestricted-leader,
project-opening, provider-recovery, and model-catalog fixes documented in the
adjacent delivery reports.
