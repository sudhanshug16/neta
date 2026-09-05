# Codex Desktop handoff — Neta MVP continuation

Use this for a new Codex Desktop session; it supersedes historical agent/workflow
rules. Fresh edits, deployment, commits, or releases require new user scope.

## Start here

- Repository: `/Users/runner/workspace/neta`
- Branch: `main`
- Recorded HEAD: `f9cf2e2199fb2d01ba61e68fb5d7722e85478f5b`
- The extensively dirty tree contains essential work absent from Git HEAD.
- Do not reset, stash, clean, checkout over, or otherwise discard dirty files.
- Do not commit or bump the version unless the user explicitly asks.
- A fresh clone is insufficient. On another Mac, transfer the actual working
  tree separately from the application ZIP.

Read `AGENTS.md`, `MANIFESTO.md`, and `docs/how-it-works.md` first. Then read:

- `docs/plan/PROJECT-MODELS-FIX-2026-09-05.md` — latest corrective delivery
- `docs/plan/MVP-RESULT-2026-09-05.md` — MVP delivery result and evidence
- `docs/plan/MVP-ACCEPTANCE-2026-09-05.md` — acceptance matrix and limits
- `docs/plan/09-desktop-shell.md` — desktop shell
- `docs/plan/10-desktop-spine.md` — canvas and mission spine
- `docs/plan/11-desktop-chat.md` — chat behavior
- `design/canvas-directions/PAPER-SPINE.md` — selected visual direction

## Current deliverable

- Archive: `/Users/runner/NetaDesktop-project-models-fix.zip`
- SHA-256: `ebbd7b53005d9e22d44cbb765cd6d123f2de0c7993500953492e26ae47cb32c7`
- Signed bundle: `/private/tmp/neta-project-models-20260905/NetaDesktop.app`
- Runtime build fingerprint: `9e871b6f585da83e2f0c56d7`
- Archive extraction and deep/strict signature verification passed.
- Backend: 538 tests, 0 failures — `/private/tmp/neta-project-models-bun.log`
- Desktop: 488 tests, 0 failures — `/private/tmp/neta-project-models-swift.log`
- AgentChatKit: 10 tests, 0 failures; unchanged from the preceding MVP gate.
- Formatting, TypeScript typecheck, and diff checks passed.
- Signed fake-provider smoke passed rich terminal output, cancellation,
  disconnect termination, recovery termination, and monotonic sequence checks.
- Smoke evidence: `/private/tmp/neta-project-models-smoke-20260905`.

## Latest user reports and fixes

Open Project previously saved a Workspace, then failed while starting its first
provider. The rejected RPC prevented the live Swift store from refreshing and
selecting it. Restarting appeared to fix it because the Workspace was already on
disk. The Node now returns that Workspace with a truthful failed Leader, and the
same app snapshots and selects it. A visible `Opening project…` state covers slow
startup. Successful retry changes the failed Leader back to idle.

A fresh failed Leader has no ACP session. Its provider menu could list choices,
but switching returned `NOT_FOUND`. The normal switch path still runs first. A
narrow fallback handles only a failed Lead with no active mission, validates the
target before changing runtime state, creates an authorized session with Neta
tools, and persists and broadcasts its new session/provider/model state.

The Claude adapter already returned Fable 5.1 as
`claude-fable-5-1[1m]`, with display name `Fable` and description `Fable 5.1`.
The picker had discarded provider descriptions. It now preserves that metadata,
so version details remain visible. The inspected live catalog is
`/private/tmp/neta-claude-catalog-20260905.json` and contains Default, Opus,
Fable 5.1, Sonnet, and Haiku for that session. This is not a claim about every
account's complete model catalog. No arbitrary `Other` entry was added.

No paid model prompts were made. The live catalog check used ACP initialize and
session creation only, with no conversation prompt and no credential capture.

## Architecture

The TypeScript/Bun Node is authoritative for durable state, provider sessions,
missions, tools, conversation history, and Glance storage. Important paths:

- `src/node/lifecycle.ts` — Node startup, ACP runtime, recovery, fingerprinting
- `src/node/workspace-open.ts` — workspace detection and leader open/revive
- `src/node/handlers-conversation.ts` — chat, catalogs, provider/model switching
- `src/node/handlers-tools.ts` — Neta tool lifecycle and writer coordination
- `src/acp/settings.ts`, `session.ts`, `blocks.ts` — adapters and ACP mapping
- `src/store/` — durable workspace, conversation, event, and Glance stores
- `test/fixtures/fake-acp-agent.mjs` — deterministic, no-cost ACP fixture

The app bundles the compiled `neta` CLI in `Contents/Resources`. Swift invokes
that absolute executable to manage the local service. Startup compares protocol
and build fingerprint and migrates the owned service. Installing `neta` on PATH
is optional through the File menu; the desktop does not require a Terminal step.

The macOS UI is native SwiftUI/AppKit under `apps/macos/Sources/NetaDesktop`.
`Model/Store.swift` holds the Node picture; `Shell/` holds window interaction;
`Chat/` adapts conversations and the composer. `packages/AgentChatKit` renders
native text, lists, tables, code, diffs, plans, tools, usage, and Glance cards.

Glance persists ordinary reader-directed agent responses as chronological cards.
It is driven from conversation output, not from a provider tool call. Source and
review cursors are durable. Apple Intelligence was unavailable on the build host;
the labeled excerpt fallback, pagination, source opening, review, and reopen were
tested. Do not claim generated-summary quality was tested.

## Design reference

The Paper file is
`https://app.paper.design/file/01M1K20ESBBP7B72D2G9FGVBB6/1-0`.
Use its Glance board identified as `202-1` together with
`design/canvas-directions/PAPER-SPINE.md`. Design tools and handles may differ in
a new Desktop session; the work must not depend on prior agent handles or temp
processes.

## Next acceptance work on an unlocked Mac

The goal remains blocked only on physical-host acceptance, not declared complete.
Run the shipped app and verify these through actual clicks and native panels:

1. Open Project and New Project: choose a folder, confirm immediate selection,
   visible workspace/navigation, usable provider recovery, and no restart.
2. Paste an image and choose a file attachment: preview, send, ACP receipt,
   metadata-only persistence, and retained draft on validation failure.
3. Inspect the complete live provider/model menus for the signed-in account,
   including visible Fable 5.1 metadata; do not assume the captured list is global.
4. Exercise provider handoff, model change, Lead/Lead++, Stop, reconnect, and a
   second prompt after recovery.
5. Review Liquid Glass, menu placement, scrolling, focus, hit areas, and pointer
   behavior on a real display. Headless captures cannot validate material blur.
6. Exercise Glance cards, source sheet, caught-up persistence, fallback labeling,
   and Apple Intelligence summaries if that Mac supports Foundation Models.

Treat the newest build as awaiting laptop confirmation: project opening needs
step 1, and attachment acceptance needs step 2. Preserve screenshots, driver
logs, the isolated `NETA_DIR`, and signed bundle fingerprint with every run.

## Working method

The user authorized ordinary Codex access for this continuation. Prefer GPT-5.6
Sol or Terra subagents; do not use Astra. The user explicitly overrides the
Neta-worker-only restriction for ordinary Codex subagents. Still follow the
AGENTS rule that the leader delegates and that writes serialize: one source
writer at a time, with independent read-only review and verification.

Do not inherit the historical Opus-only, Claude Workflow, automatic commit, or
one-commit-per-fix instructions from the old handoff. No commit or version bump
is requested now. Never use real provider APIs, keys, or paid tokens in tests.

## Commands

From `/Users/runner/workspace/neta`:

```sh
bun install
bun test
bun run check
bun run typecheck
swift test --package-path apps/macos
swift test --package-path packages/AgentChatKit
apps/macos/scripts/build-app.sh /private/tmp/neta-next-build
codesign --verify --deep --strict /private/tmp/neta-next-build/NetaDesktop.app
apps/macos/scripts/run-mvp-e2e.sh /private/tmp/neta-next-build/NetaDesktop.app /private/tmp/neta-next-acceptance
```

Use a fresh isolated `NETA_DIR` and the fake ACP fixture for signed-app smoke.
Never point a harness at `~/.neta`, mutate personal provider settings, print
environment credentials, or make a paid provider call. Temp evidence paths are
local conveniences and may not transfer; the source documents and working tree
are the durable handoff.
