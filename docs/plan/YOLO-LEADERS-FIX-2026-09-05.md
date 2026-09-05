# Unrestricted leaders fix — 2026-09-05

The delivery is `/Users/runner/NetaDesktop-yolo-leaders.zip`. Its SHA-256 is
`aedae8f6904b0582db91c950b5c1f17c7bc34a8215c27daadda0042499c5bbf9`; the
bundled runtime build is `9e0b23f38dbd06e24e02f49c`. The extracted app
passed deep/strict signature verification.

## Problem and fix

Neta previously treated Lead as provider read-only mode and Lead++ as provider
workspace-write mode. That sandbox prevented workspace and mission leaders from
using network and MCP capabilities needed to coordinate their work.

Workspace leaders and mission leads now select the unrestricted mode advertised
through ACP in both Lead and Lead++: `agent-full-access` for Codex,
`bypassPermissions` for Claude, and `build` for OpenCode. Neta uses
`session/set_config_option`; it adds no unsupported adapter arguments and keeps
configured provider environment values unchanged. The policy survives fresh
creation, resume, process relaunch, provider switching, mode changes, failed
provider recovery, and self-led missions. Lead and Lead++ continue to govern
Neta mutation authority and writer leases. Ordinary agents retain the sandbox
implied by their assigned read-only or read-write access.

The installed adapter sources were inspected before implementation. Codex ACP
maps `agent-full-access` to `danger-full-access`; Claude ACP advertises
`bypassPermissions`.

## Verification

- Backend suite, twice: 540 passed, 0 failed. Logs:
  `/private/tmp/neta-yolo-bun-fixed-1.log` and
  `/private/tmp/neta-yolo-bun-fixed-2.log`.
- `bun run check` and `bun run typecheck`: passed.
- Focused fake-ACP coverage verifies both built-in mode identifiers, permission
  approval while a leader is in Lead, preservation through Lead/Lead++ relaunch,
  and ordinary-agent mode remaining sandboxed.
- Signed-app smoke passed rich terminal turns, cancellation, disconnect and
  recovery terminal turns, and monotonic sequence checks. Evidence:
  `/private/tmp/neta-yolo-smoke-20260905`.

No paid provider prompt was made. The signed smoke used isolated fake-provider
state. The final backend correction changed only an obsolete test expectation;
the packaged production bundle did not require rebuilding.
