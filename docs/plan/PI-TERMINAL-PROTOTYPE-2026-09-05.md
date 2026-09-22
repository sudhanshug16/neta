# Pi terminal prototype — 2026-09-05

## Result

`NetaPiPrototype.app` is a side-by-side prototype. It uses bundle identifier
`dev.neta.desktop.pi`, displays as **Neta Pi Prototype**, and stores service
state in `~/.neta-pi-prototype`. It does not replace the native Neta app or its
conversation data.

The app embeds Node 24.20.0, Pi 0.85.0, `pi-claude-bridge` 0.7.0, the Neta Pi
extension, `node-pty`, and the native arm64 helpers they need. Neta's existing
compiled service remains the authority for projects, missions, actors, leases,
and tool authorization. Pi runs in a persistent PTY for each selected Pi actor.
ACP workers remain visible through Neta's native canvas and chat UI.

Claude bridge configuration preserves an explicit user-selected Claude
executable. Otherwise Neta discovers executable files in the user's local bin,
Homebrew locations, then Finder's PATH. The packaged fallback is Claude Agent
SDK 0.3.257 (Claude Code 2.1.257); the acceptance host selected its installed
Claude Code 2.1.261. No paid prompt was sent.

## Verification

- Signed app: `/private/tmp/neta-pi-release-visible/NetaPiPrototype.app`
- Archive: `/Users/runner/NetaPiPrototype.zip` (191 MiB)
- SHA-256: `166e6ce4bb7d4858ae49fba2bed745778d20430f74e64803176971c316483e09`
- Runtime build: `5a843eccd7eb8df4fd82e6c3`
- Size on disk: 578 MiB
- Signed UI/tool evidence: `/private/tmp/neta-pi-visible-proof.Tcuvti`
- Full backend tests: 562 passed, 0 failed
- Full desktop tests: 498 passed, 0 failed
- Typecheck, diff check, and strict deep code-sign verification passed.

The signed-app test used a deterministic local Pi provider and no provider API.
A real terminal paste and Return caused Pi to call the real `neta_mission`
extension tool. Neta persisted mission #1, returned a successful tool result,
and launched its mission lead in a second Pi process. The driver observed the
workspace leader at PID 54764, the mission lead at PID 54826, then the same
workspace leader PID 54764 after switching back. Its viewport text includes
the real tool result and deterministic fixture completions. The workspace and
mission Pi JSONL files retain the same evidence durably.

## Prototype limits

- This is an arm64 macOS prototype, about 578 MiB unpacked.
- Pi downloaded `fd` 10.5.0 into its isolated configuration on first launch;
  `fd` is not yet part of the app bundle, so that first launch needs network.
- Pi mission mode changes are explicitly unavailable in this prototype.
- The terminal viewport and actions were verified through the signed app's
  native view. Screenshots from the locked host are invalid as visual-fidelity
  evidence; inspect glass, colors, and pointer behavior on an unlocked Mac.
- Claude authentication and live model behavior still need confirmation on the
  user's unlocked Mac. No credentials were inspected and no paid call was made.

## Terminal resize and editing follow-up

The follow-up signed build is
`/private/tmp/neta-pi-edit-final/NetaPiPrototype.app`. Evidence in
`/private/tmp/neta-pi-edit-proof.1CZszR` verifies that the actual Pi viewport
resized to 43 columns by 37 rows, accepted Unicode text and Backspace editing,
and sent one PNG clipboard path. The final viewport contained no repeated
trailing copies of earlier content. These checks prove the corrected native
terminal behavior; they do not provide visual-fidelity evidence because the
host remained locked.

The distributable follow-up is
`/Users/runner/NetaPiPrototype-resize-fix.zip` (191 MiB), SHA-256
`dc332ca93981fc54c09326b62737a576d8acb456223129df140c4c96ac20abd0`.
The extracted app at
`/private/tmp/neta-pi-resize-extracted-20260905/NetaPiPrototype.app` passed
strict deep code-sign verification. The final desktop suite log is
`/private/tmp/neta-pi-resize-swift-final.log`.

## Exporting a session for diagnosis

Choose **File → Export Session…**. The save panel explains that the ZIP
contains all locally known Neta workspaces, machines, missions, agents,
conversation text, tool output, Pi session records, file paths, and bounded
terminal lifecycle telemetry. It excludes service descriptors, provider
settings and environment, authentication stores, sockets, locks, and external
attachment targets. Review the archive before sharing it.

The export records app/runtime/OS and current window geometry, plus Pi attach,
generation, sequence, byte-count, and resize metadata. It never adds raw PTY
bytes to telemetry; the complete Pi conversation remains in its ordinary
session record. Machines known only through locally stored workspace roots are
listed as unavailable rather than reported as live.

The current action needs a connected Neta service. The app normally reconnects
or starts that service automatically, but it cannot export when service startup
itself fails. Cancelling the save panel creates no staging data. Successful and
failed archive attempts ask the service to remove their private temporary
directory.
