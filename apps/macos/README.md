# Neta Desktop

The first macOS SwiftUI shell for Neta. Each project is a pannable, zoomable
canvas. The project sidebar and selected-agent chat float above that single
surface.

Build and open the preview app bundle:

```sh
cd apps/macos
./scripts/build-app.sh
open .build/debug/NetaDesktop.app
```

Run its tests:

```sh
cd apps/macos
swift test
```

## Session connection

The production app uses `NetaBridgeClient`. Opening a folder starts its leader
through ACP and gives that session the existing Neta MCP control plane. Workers
spawned by the leader appear on the canvas; selecting one reads its live log,
and chat and stop actions go through the authenticated local session channel.

Sessions started in a vendor's native CLI are also shown. Their workers remain
fully controllable, but their leader chat stays read-only in the desktop app:
two concurrent clients must not prompt the same vendor conversation. Start a
project from Neta Desktop when its leader should live in the floating chat.

The sidebar separates live projects under Active from closed durable sessions
under Archive. Archived canvases and worker logs are read-only until Resume is
pressed. Resume reopens the exact captured ACP conversation. If its Git
worktree was removed, Neta asks Worktrunk to recreate the recorded branch at
the exact recorded path; it refuses missing or mismatched bindings.

The canvas has no animation loop. A single five-second task refreshes live actor
state and only the selected transcript; rendering otherwise happens for window,
pan, zoom, selection, or session-state changes.
