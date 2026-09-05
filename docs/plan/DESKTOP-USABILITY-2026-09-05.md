# Desktop usability fix report

## Reported problems

The desktop initially exposed only one useful provider, showed incomplete or
invented model choices, gave little preparation or tool feedback, rendered raw
usage payloads, lacked image and file prompts, and could leave Stop active after
a terminal response. Provider and model controls differed visually. The narrow
chat layout, sidebar interaction, and canvas navigation also needed repair.

## Implemented result

- Protocol v2 carries ACP prompt capabilities, structured plan/tool/usage
  blocks, and bounded attachments. A prompt accepts up to 10 files, no more
  than 4 MiB each or 5 MiB total. History retains attachment metadata without
  retaining payload bytes.
- Image paste uses the AppKit responder chain, file selection and previews are
  capability-gated, and failed sends retain the draft and attachments.
- Preparing, streaming, stopping, tool lifecycle, compact usage, Markdown,
  code, tables, and diffs have native renderers. Turn-end and late-ack tests
  cover the transition back to idle.

Renderer acceptance covers semantic nested list depth and explicit ordered
starts, delimiter-length-aware backtick and tilde fences, and real AppKit
horizontal scroll ranges for long code and table content. The parser supports
the documented agent-chat subset rather than all CommonMark extensions.
- Provider availability accounts for GUI executable lookup and distinguishes
  a missing ACP adapter from a provider account. Provider and model controls
  use one native selector. Live choices come from ACP configuration updates;
  unopened providers use only declared configuration. Neta does not invent
  model names or arbitrary custom adapter commands.
- The quick sidebar, workspace switching, free two-axis canvas panning, Fit,
  Now, and pointer-safe card interaction are implemented.

## Verification

- Backend: 523 tests passed.
- macOS app: 475 tests passed after the final workspace-selection assertion was updated.
- AgentChatKit: 4 tests passed.
- The release app built and passed signing verification.
- Opening the new bundled app against an authentic v1 service automatically
  stopped it, launched the fingerprinted v2 runtime, restored the same durable
  leader session, and sent `FULL_SEQUENCE` to a persisted terminal turn. No
  Terminal command or recovery button was used.
- The AppKit paste selector consumed a PNG in the real composer, showed one
  attachment, sent it through ACP, and persisted only its name, MIME type,
  size, kind, and generated id. Physical-keyboard Cmd-V and idle-button visuals
  were not visually verified in the headless session; responder and turn-state
  regressions cover them.
- No paid or live provider request was made.
- Default adapters were refreshed to Claude ACP 0.74.0 and Codex ACP 1.10.0,
  with ACP SDK 1.4.0. Scratch-home initialization verified Claude Code 2.1.257
  and Codex CLI 0.153.3 without creating a session or sending a prompt.
- Provider resume failure currently creates and announces a new leader conversation;
  history continuity across a service restart depends on durable resume support from
  the provider.

The release artifact is `/Users/runner/NetaDesktop-adapter-fix.zip`, built from
`/private/tmp/neta-adapter-refresh-build/NetaDesktop.app`.

## Upgrade and review

Opening a newer app automatically replaces a legacy-protocol service and a
same-protocol service whose bundled-runtime fingerprint differs. It requests
authenticated graceful shutdown first. If the service does not exit, it only
signals the unchanged recorded PID after validating its private descriptor,
  socket directory, process access, and `neta` executable identity. The File menu
  can optionally install the bundled CLI at `/usr/local/bin/neta`; routine app
  startup and upgrades do not require it.

The forced fallback was exercised against an isolated compiled `neta` process
that ignored `SIGTERM` and exposed an unreachable legacy descriptor. The app
removed that exact PID, started the signed bundled runtime, wrote protocol v2
with the expected build fingerprint, and reached a ready empty-workspace state.

Package gallery captures verified the text, code, and plan layouts. Native
Liquid Glass and AppKit controls appeared as dark placeholders under the
headless compositor. Their final appearance, along with sidebar and canvas
pointer feel, still requires review on the primary Mac's physical display.
