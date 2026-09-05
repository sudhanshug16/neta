# Project opening and Claude model fix — 2026-09-05

The updated delivery is `/Users/runner/NetaDesktop-project-models-fix.zip`,
built from `/private/tmp/neta-project-models-20260905/NetaDesktop.app`. The final
archive SHA-256 is
`ebbd7b53005d9e22d44cbb765cd6d123f2de0c7993500953492e26ae47cb32c7`; its
extracted bundle passed deep/strict signature verification. The bundled runtime
build is `9e871b6f585da83e2f0c56d7`.

## What was wrong and what changed

Opening a new project saved its Workspace before starting its provider. If the
adapter was unavailable, leader creation rejected the whole `workspace.open`
request, so the live app never refreshed or selected the saved Workspace. A
restart then made it appear from disk. The Node now returns the saved Workspace
with a failed Leader, allowing the desktop to snapshot and select it immediately.
The UI shows `Opening project…` while startup is pending. Reopening retries the
failed leader and successful recovery changes it to idle.

A failed fresh leader previously had no live ACP session, so its provider menu
could list providers but switching returned `NOT_FOUND`. The normal switch path
still runs first. A narrow fallback handles only that exact error for a failed
Lead with no active mission. It validates the selected provider before touching
runtime state, creates a new authorized session with Neta tools, and persists
and broadcasts the new session, provider, model, and idle state. Invalid targets
leave the failed leader unchanged.

Claude's ACP catalog already advertised Fable 5.1 as ID
`claude-fable-5-1[1m]`, but the adapter's short name was only `Fable`. The model
picker now preserves the adapter's description, so it displays the supplied
version detail instead of reducing every entry to a generic name. The captured
catalog is `/private/tmp/neta-claude-catalog-20260905.json`; it contains Default,
Opus, Fable 5.1, Sonnet, and Haiku for that session. No arbitrary `Other` model
entry was added because Fable was already present. This evidence describes the
catalog returned to this account and adapter session, not every possible account.
The inspection performed ACP initialization and session creation without sending
a conversation prompt.

## Verification

- Backend: 538 tests, 0 failures — `/private/tmp/neta-project-models-bun.log`
- Desktop: 488 tests, 0 failures — `/private/tmp/neta-project-models-swift.log`
- Formatting, TypeScript typecheck, and diff check: pass
- Failed adapter recovery: unavailable initial adapter, preserved Workspace and
  failed Leader, rejected invalid target without mutation, switched to the
  alternate fixture provider, then listed models, reported image/context
  capabilities, and completed a prompt —
  `/private/tmp/neta-failed-placeholder-switch.log`
- Final signed smoke: `PASS rich-terminal cancel disconnect-terminal
  recovery-terminal monotonic-seq` —
  `/private/tmp/neta-project-models-smoke-20260905`

The locked host cannot choose and confirm a URL inside the system file picker.
Node integration and Swift state tests verify refresh and selection after the
selected path is passed to the app. Physical Liquid Glass appearance also still
needs review on an unlocked Mac.
