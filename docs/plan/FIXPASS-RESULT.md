# Fix-pass result — runtime board verification

Verification fixture: `/private/tmp/nfc/drive/seed-noscrubs.ts`, launched by
`seed-noscrubs-live.sh`. It uses the repository stores and lifecycle adapters
against a temporary `NETA_DIR` and a fake ACP provider. The normal Node restart
rule remains intact. The harness masks seeded live agents only while the
startup recovery sweep runs, then exposes the real adapted store. It restores
visual state; it does **not** resume ACP processes, prove permissions, or
prove recovery of those seeded agents.

Final gate: `bun run check` and `bun test` passed 517 tests with 0 skips;
Swift build and `swift test` passed 475 tests with 0 skips. The persistent
launchable bundle is `apps/macos/.build/NetaDesktop.app`.

Validated at HEAD `f9cf2e2` plus the uncommitted completion changes. Earlier handoff commits: `1aa6c7f`, `1893f85`, `82dd8a5`, `51b7b72`, `e892f8b`, `c6fcdf1`, `2aefaac`, `0f5a173`, `f9cf2e2`. No commit was created during this verification pass.

The seed contains 17 mission records: historic closed `#291`, `#294`, `#296`
and the NoScrubs dataset `#298`–`#311`; 117 agents; Halden; the durable leader
transcript; and six dated checkpoint records. All six canonical PNGs were refreshed from clean fixtures at a native 1600 × 1000 through the driver content-view path, with no fabricated or padded pixels. Material blur is unavailable in this capture route.

## Spine dense

| Rule | Match | Note | Shot |
| --- | --- | --- | --- |
| Real NoScrubs mission, agent, leader and checkpoint records | Yes | Registry has 17 missions/117 agents; snapshot exposes all 17 missions and 105 agents after its eight-completed-per-mission bound. | [spine-dense](shots/spine-dense.png) |
| Halden is Lead++ for 14 min on `#308` | Yes | Leader record and persistent strip resolve to `#308`. | [spine-dense](shots/spine-dense.png) |
| Blocked/failed/ready/running bar states | Yes | Fixture carries the real mission states and attention text. | [spine-dense](shots/spine-dense.png) |
| Completed collapse chips | Yes | Missions with more than eight completed agents expose snapshot completed counts. | [spine-dense](shots/spine-dense.png) |
| Seven to ten readable lead cards, remaining columns allowed offscreen | Yes | Captured at the real 41% time lens; nodes retain native size. |
| Mission lead appears only on the lead card | Yes | Lead agents are filtered from the stack. |

## Typical day

| Rule | Match | Note | Shot |
| --- | --- | --- | --- |
| Only `#305`, `#309`, `#310`, `#311` open | Yes | Verified from the running fixture snapshot. | [typical-day](shots/typical-day.png) |
| Historical merged/abandoned nodes remain closed | Yes | The fixture converts the other board missions to closed and archives their rows. | [typical-day](shots/typical-day.png) |
| Halden is idle Lead without a Lead++ strip | Yes | Typical fixture leader record is `lead`, idle, with no active mission. | [typical-day](shots/typical-day.png) |
| Three specified leader turns and typed `#305` draft | Yes | The persisted leader transcript has the specified three turns; the composer says `Close #305 once the checks pass.` | [typical-day](shots/typical-day.png) |
| Four open missions; selected leader at the newest edge | Yes | `#305` continues past the left edge while the leader remains at Now; this is the Fit fallback in PAPER-SPINE Revision 4, lines 248–259, when the columns cannot all fit at the minimum width. Its mission-bar chip remains visible and selectable. | [typical-day](shots/typical-day.png) |

## Navigator open

| Rule | Match | Note | Shot |
| --- | --- | --- | --- |
| Navigator overlays canvas and lists the current workspace | Yes | Driver opens the overlay without changing canvas geometry. | [navigator-open](shots/navigator-open.png) |
| Workspace hierarchy and visible project actions | Yes | NoScrubs nests its known online `mac-studio`; Open Project and New Project are visible. | [navigator-open](shots/navigator-open.png) |
| No offline, leader, subagent, or mission rows | Yes | `build-box` is excluded by the fixture and sidebar rule; the sidebar is workspace/machine navigation only. | [navigator-open](shots/navigator-open.png) |

## Chat header · agent selected

| Rule | Match | Note | Shot |
| --- | --- | --- | --- |
| Agent path and selected-provider controls | Yes | The refreshed `Halden → #304 → Thane` header/composer evidence shows the configured fake provider and model selector. Ordinary-agent chat intentionally has no Lead / Lead++ control. | [chat-header-agent](shots/chat-header-agent.png) |
| Header crop available | Yes | A native 410 × 132 crop accompanies the full board shot. | [header crop](shots/chat-header-agent-crop.png) |
| System transcript event is a centred event line | Yes | Visible in the leader transcript of the refreshed dense Spine board; the agent-header capture is a separate path check. |

## Now back

| Rule | Match | Note | Shot |
| --- | --- | --- | --- |
| Now jump uses the live shell action | Yes | Driver invokes the same `ShellState.nowRequested` route as the bar control. | [now-back](shots/now-back.png) |

## Zoomed out

| Rule | Match | Note | Shot |
| --- | --- | --- | --- |
| Zoom out changes the time lens without scaling nodes | Yes | Three driver zoom-out actions were captured. | [zoomed-out](shots/zoomed-out.png) |

## MUST audit

| MUST rule | Match | Evidence |
| --- | --- | --- |
| Stable focal workspace leader | Yes | Halden has the dedicated leader card and chat identity. |
| Every open mission stays on canvas; readable working density | Yes | Spine shows the live sequence at 41%. Typical retains `#305` beyond the left edge under the specified Fit fallback, with its selectable chip. |
| Mission number, name, state and age; temporal sequence | Yes | Persistent `#N` labels and ordered spine cards are visible. |
| Running/blocked/failed visible; completed collapse chip | Yes | Dense fixture preserves active rows and completed counts. |
| Full tasks and activity; anchored subordinate connectors | Yes | Dense shot shows task/activity lines and solid connectors. |
| Text/icon plus colour for status/access | Yes | State/access labels accompany semantic colours. |
| Compact local Lead / Lead++ and 14-minute strip | Yes | Spine leader header/strip reflects `leadPlus` for 14 minutes. |
| Attention for blocked and closeable work | Yes | Attention text appears with the affected mission states. |

## NEVER audit

| NEVER rule | Match | Evidence |
| --- | --- | --- |
| Global New mission control | Yes | Shell has none. |
| Permanent mode chooser, Chat/Details tabs, or decorative progress | Yes | Mode is header-local; Details is an action; no progress decoration. |
| Miniature agent lists in mission cards, blob clusters, org-chart/radial/single-line layout | Yes | Cards remain distinct from agent rows in the sequence spine. |
| Roles/job titles or emoji as identity | Yes | Rows use name, task, model/access and activity; no emoji. |
| Navigator status-card dashboard | Yes | Navigator is a workspace and machine list. |

## Functional checks

| Check | Result | Evidence / limit |
| --- | --- | --- |
| Node autostarts from app bundle | Pass | After a fresh stop, launching `apps/macos/.build/NetaDesktop.app` started `/Users/runner/workspace/neta/apps/macos/.build/NetaDesktop.app/Contents/Resources/neta node start` (pid 92267 in the final rebuilt-bundle verification run). |
| `workspace.open` | Pass | Temporary Git workspace opens through the real Node. |
| Prompt streams to leader chat | Pass | Ordinary fake-ACP closeout smoke sent the leader prompt before creating and closing a mission. Static board sessions remain visual fixture state. |
| `neta_mission` emits a state into spine and mission bar | Pass | Ordinary fake-ACP closeout smoke created the mission before ready and confirmed closeout. |
| Blocked agent and mission attention | Pass | Board seed includes blocked state and `attention`; active rows are exposed by the fixture lifecycle wrapper. |
| Closed-node fade rendering | Pass by seeded closed states | Closed records carry `closedAt` and disposition. |
| Prompt → mission → ready → confirmed closeout | Pass | Current rebuilt Node: fresh snapshot persisted `closed/abandoned`. |
| Provider handoff | Pass | Scratch fake/fake2 (`test-model`/`fixture-fast`) switched provider and queued Markdown handoff into the next prompt. |
| Now, navigator, keyboard routes | Pass / partial | Driver covered Now and navigator. Prior gate covered menu-key routes. Pointer click-outside is not verifiable headlessly. |
| Glass blur and dark tint | Unverifiable | `cacheDisplay` captures layout and colours but cannot composite Liquid Glass blur without a display. |

## Accepted deviations, limitations, and fixture scope

- System traffic lights remain system supplied.
- Chat bottom is `missionBar.minY - 12`.
- The toolbar machine entry is a label, not a menu.
- Closed nodes are 200 pt wide and two lines.
- Lead-card, agent-row and leader-card heights were raised to prevent overlap.
- Typical-day retains `#305` beyond the left edge while the leader stays at
  Now. This is the PAPER-SPINE Revision 4 Fit fallback (lines 248–259), not a
  missing mission or a padded capture; its mission-bar chip stays visible.
- The fixture persists selected NoScrubs and local `mac-studio`. A synthetic offline `build-box` root verifies sidebar exclusion; it is not displayed and does not represent live remote execution.

## Paper design revision — 2026-09-05

Paper artboards now show a workspace-first Navigator: only online machines nested under their workspace, with Open Project and New Project actions and no mission/agent list. Spine, Typical, and Navigator composers show Codex, Default model, and the retained Lead / Lead++ control. The Typical board includes a focused handoff-review sheet with mission context, recent messages, full-history assurance, and a Markdown review action before a provider change. [Paper file](https://app.paper.design/file/01M1K20ESBBP7B72D2G9FGVBB6/1-0).
