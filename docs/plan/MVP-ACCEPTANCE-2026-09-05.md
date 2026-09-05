# MVP desktop acceptance

This matrix is the release gate for the installed, signed app. Every run uses
an isolated `NETA_DIR`, fixture session store, workspace, and debug-driver
directory. Unit tests support a result but cannot mark a desktop row passed.
The driver may observe state and inject a controlled service failure; product
actions must travel through an actual native control, menu, responder, or
panel. Each passed row names its immutable log, screenshot, and durable-store
evidence beneath `/private/tmp/neta-mvp-acceptance/`.

| Flow | Required evidence | Current result |
| --- | --- | --- |
| Fresh launch and durable resume | AX inventory, ready state, same session after app reopen | Pass: `/private/tmp/neta-final3-reopen-open-1788569158` and `/private/tmp/neta-final3-terminal-reopen-1788569305`; same session accepted another terminal prompt after reopen. Fresh empty-state controls: `/private/tmp/neta-onboarding-signed-1788570205` |
| Provider switch and handoff | AX presses provider menu item and sheet confirmation; transcript/store shows new provider and editable handoff | Pass with two fixture providers: `/private/tmp/neta-final3-reopen-open-1788569158`; no paid provider call |
| Model switch | AX presses model menu item; state and resumed session retain selected model | Pass with fixture catalog: `/private/tmp/neta-final3-reopen-open-1788569158` |
| Lead / Lead++ | AX presses segmented control; durable mode event and visible label; rejected change shows an error | Pass: `/private/tmp/neta-mode-final10-1788572002`; a real `neta_mission` seeded the prerequisite, then native mode controls changed Lead → Lead++ → Lead with visible labels, activity/composer state, and durable events 2/3. |
| Rich send and terminal idle | Native text responder and Send/Return; plan, tool, diff, usage, final, ended turn, idle composer | Pass: `run-1/driver/log`, conversation seq 1–6 |
| Stop/cancel | `HOLD_FOREVER`, native Stop press, cancelled terminal turn, idle composer | Pass: native Session > Cancel Turn key equivalent; `run-1` seq 7 and cancelled turn |
| Provider disconnect/reconnect | `EXIT_MID_TURN`, visible interruption/error, provider resume and subsequent successful prompt | Pass: `/private/tmp/neta-mvp-ax-acceptance-2`; partial terminal turn, reconnect, next prompt |
| Image and file attachments | Native Paste/file panel, preview, ACP receipt, metadata-only history, failed send retention | Image pass: `/private/tmp/neta-image-final4-1788570377`; actual `NSTextView.paste`, preview, fake ACP receipt and metadata-only store. Native file panel opens; selection is unverified on the locked host |
| Open workspace | File > Open Workspace and native panel confirmation; selected workspace and leader ready | Partial: actual native panel opens. System panel selection is unverified on the locked host |
| Create folder workspace | Navigator New Project and native save panel; folder, workspace, leader, usable chat | Partial: first-run `New Project` is visible and its native panel opens. System panel selection is unverified on the locked host |
| Switch workspace | Native workspace menu/row; readiness gates controls; correct durable leader/session and missions | Pass: `/private/tmp/neta-workspace-final10-1788571402`; actual Cmd-K, stable AX workspace row press, ready gate, workspace/session postcondition. Toolbar is one uniquely identified native menu; its modal item selection cannot be driven while the locked-host in-process pump is paused |
| Mission lifecycle | Prompt invokes real Neta MCP: create, agent states, blocked/failed, ready, close; canvas/bar/navigator follow | Pass: `/private/tmp/neta-mission-signed-1788570149`; initial task called Neta MCP, agent blocked then ran/completed, mission ready then closed. Final blocked presentation and Details actions: `/private/tmp/neta-details-final10-1788571341` |
| Pin and archive | Actual Details actions, event/state persistence, running confirmation | Pass for pin/unpin and completed-agent archive: `/private/tmp/neta-details-final10-1788571341`; running-agent destructive confirmation is covered by native tests, not a locked-host signed interaction |
| Glance catch-up | Three ordinary reader-directed responses create separate chronological cards; source opens; explicit caught-up action persists; unavailable on-device model shows labeled excerpts | Pass: `/private/tmp/neta-glance-final.ESG3nX` proves actual Open, Done and review; `/private/tmp/neta-final3-terminal-reopen-1788569305` proves the reviewed state remains clear after reopen |

## Harness commands

`ax-dump` records the accessibility roles and labels exposed by the running
app. `ax-press <label>` performs the standard AX press action on the matching
native element. Existing `key`, `click`, `drag`, `draft`, `state`, `menu`, and
capture commands remain available. `restart-service` and fixture process exits
are diagnostic fault injection, never substitutes for a product action.

The reproducible launch shape is:

```sh
env NETA_DIR=/private/tmp/neta-mvp-acceptance/data \
  NETA_DEBUG_DRIVER=/private/tmp/neta-mvp-acceptance/driver \
  /private/tmp/neta-mvp-acceptance/NetaDesktop.app/Contents/MacOS/NetaDesktop
```

Before a release, copy the exact signed bundle into that path, record its
`codesign --verify --deep --strict` result and runtime build fingerprint, and
retain `driver/log`, screenshots, `node.json`, conversation NDJSON, event log,
leader records, and fixture session stores. Never point this harness at
`~/.neta` or a person's provider configuration.

## First signed run

`/private/tmp/neta-mvp-acceptance/run-1` contains the first signed-app result.
The native composer sent a complete structured response and returned idle; the
real Session menu key equivalent cancelled `HOLD_FOREVER`; and
`EXIT_MID_TURN` persisted the partial response and connection-close status
before ending the turn. The run used a CLI call only to seed its isolated
workspace, so workspace opening is not credited as a desktop pass.

The signed run at `/private/tmp/neta-mvp-ax-acceptance-2` enabled AppKit's
enhanced accessibility interface in the isolated debug harness and exercised
the real SwiftUI Send and Stop actions. It also verified recovery after the
provider process closed. These action paths are verified on the locked host;
native glass composition remains unverified because the locked compositor
returns blank captures.

The current UI closure bundle is
`/private/tmp/neta-mvp-ui-final10-1788571330/NetaDesktop.app`. Its signed AX
runs prove the Quick Switcher workspace handoff, the live blocked-lead cue,
pin/unpin updates, and completed-agent archive. Physical Liquid Glass appearance
and choosing a URL inside the system file panels still require an unlocked Mac.

## Final delivery

The final archive is `/Users/runner/NetaDesktop-mvp.zip` (SHA-256
`bdb7f5da0d0271183ae14003cbe147ce7e4e9e0b9bfaa7266033c0bda5a15d2e`).
Its extracted bundle passed codesign verification; the signed source bundle is
`/private/tmp/neta-mvp-ui-final10-1788571330/NetaDesktop.app`, runtime build
`15b57218354d96e840bd55d1`. The final smoke assertions are at
`/private/tmp/neta-delivery-acceptance-20260905/assertions.txt`.
