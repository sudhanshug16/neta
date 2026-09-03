# Appendix — the retired v2 desktop app

Reference only. Paths refer to tag `v2-final` under `apps/macos/Sources/
NetaDesktop/` and `src/desktop/`.

## Transport
- The app spawned `neta-bridge desktop-bridge` as a child process and spoke
  newline-delimited JSON request/response over stdio (`NetaBridgeClient.swift:
  94-170`, `src/desktop/bridge.ts:419`). No server push. The app polled every
  5 s (`AppModel.swift:45`). The bridge died with the app, which violated
  "work survives the UI". v3 connects to the long-lived Node over a Unix socket
  with notifications.
- Commands: `list, archives, open, resume, tail, prompt, stop, close,
  shutdown`. Leader turns arrived as one message at turn end; tool calls became
  system lines; thoughts, usage, config and mode updates were dropped.
- Message ids were positional (`leader-<n>`); there was no turn concept.

## Swift structure worth borrowing
- `AppModel` (`@MainActor ObservableObject`) held projects, selection, draft,
  loading and error state; selection auto-picked the leader.
- `AgentSessionClient` protocol with a `PreviewSessionClient` stub made the
  model testable without the bridge; tests covered selection, send, stop and
  archive resume. v3 keeps the pattern: a `NodeClient` protocol with a
  fixture-backed implementation used by tests and previews.
- `ContentView`: `GeometryReader` → `ZStack` of canvas and floating panels;
  the chat width was `min(410, width * 0.36)`; the canvas received
  `interactionInsets` so trackpad panning was captured only where the canvas
  was uncovered.
- `AgentCanvas`: dot grid and edges drawn in a SwiftUI `Canvas`; nodes were
  real SwiftUI views positioned with `.position`, so hit testing was free;
  pan via `DragGesture`, zoom via `MagnifyGesture` clamped 0.55–1.8; the
  projection function was duplicated in two places. No virtualisation.
- `TrackpadPanCapture`: an `NSViewRepresentable` installing a local
  `NSEvent` scroll-wheel monitor, filtering by window and bounds, scaling
  non-precise deltas by 18, coalescing per run-loop turn, swallowing the
  event. v3 reuses this idea for two-finger panning.
- `AgentChatPanel`: `ScrollViewReader` + `LazyVStack` with `.id(message.id)`
  and auto-scroll on count change; plain `Text` bubbles, no Markdown.
- Theme tokens (exact) are recorded in `design/canvas-directions/BRIEF.md`.

## Gaps that v3 designs in from the start
- Missions, permanent numbers, time-axis layout, events and checkpoints,
  Lead/Lead++, mission bar, navigator overlay, model picker, virtualisation,
  archived missions on the canvas, keyboard shortcuts, streaming turns with
  stable ids, scroll-to-turn.
- Deployment target was macOS 15; v3 targets 26 for Liquid Glass.
- CI never built the app.
