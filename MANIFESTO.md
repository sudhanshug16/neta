# Neta

Neta is the interface, engine, and machine service for running persistent agent
teams across workspaces. It is not itself the top-level agent. A user talks to
the leader belonging to a specific workspace on a specific machine, and can
open the ACP conversation of any mission lead or agent beneath it.

This manifesto defines the target product. The current implementation is still
described in [docs/how-it-works.md](docs/how-it-works.md) while the migration is
in progress. When the two documents disagree, this manifesto is the product
direction and `docs/how-it-works.md` is the description of what ships today.

## Vocabulary

- **Neta** — the client, engine, and opt-in service running on a machine. Neta
  connects users to leaders and agents; it is not a global conversational
  agent.
- **Workspace** — a Git repository or an ordinary folder in which work happens.
- **Machine** — a physical host, virtual machine, or isolated runtime that owns
  one copy of a workspace and runs its complete agent tree.
- **Leader** — the persistent assistant for one workspace on one machine. It has
  its own ACP conversation and decides whether to work directly or create a
  mission.
- **Mission** — one bounded objective. A Git mission receives its own Worktrunk
  worktree by default. Every mission has a permanent number assigned at
  creation that never changes.
- **Mission lead** — the agent responsible for one mission. It may work directly
  or create ordinary agents.
- **Agent** — a bounded helper beneath a mission lead. Ordinary agents cannot
  create children.
- **Spine** — the canvas's time axis. Every mission anchors to it at its start
  time and stays there permanently.
- **Now** — the live end of the spine, where the workspace leader sits.
- **Checkpoint** — a marker on the spine for an event that changed the state of
  work.
- **Mission bar** — the compact bar reserved along the bottom of the window. It
  holds the workspace leader, the Now control, and every open mission that is
  running or waiting on a person.

The hierarchy is fixed:

```text
Neta
└── Workspace
    └── Machine
        └── Leader
            └── Mission
                └── Mission lead
                    └── Agents
```

The machine level is hidden in the UI when a workspace exists on only one
machine.

## Principles

1. **Leaders exercise judgment.** A leader may investigate, build, delegate,
   validate, or ask for help. Delegation is a capability, not a ritual.
2. **One objective, one mission.** Missions are bounded units of work with clear
   ownership, history, and closeout.
3. **Execution is machine-local.** A leader, its mission leads, their agents,
   ACP sessions, shells, and worktrees all run on the machine that owns the
   workspace copy. Neta never distributes one agent tree across machines.
4. **Isolation before ceremony.** Git missions use Worktrunk worktrees. Neta
   does not require a scout, writer, reviewer, or full test suite for every
   change.
5. **Access is visible and reversible.** Leaders move between Lead and Lead++;
   agents receive read-only or read-write access. The current state is always
   visible and durably recorded.
6. **Every conversation is real ACP.** Desktop, native CLI, and future clients
   open the same exact ACP sessions. There are no dummy chat surfaces and no
   keystroke injection.
7. **Work survives the UI.** Closing a client does not stop the machine service.
   State, conversations, missions, modes, skills, and model choices are durable.
8. **Nothing important disappears.** Active missions, blocked questions,
   unfinished closeouts, failures, and archives remain discoverable.
9. **Authority is explicit.** A charter defines what leaders may decide and
   which destructive, production, financial, credential, or outward-facing
   actions require the user.
10. **Idle means idle.** The service is event-driven and bounded. It avoids
    polling, unbounded transcript hydration, and rendering work outside the
    visible canvas.

## Neta on each machine

An opted-in machine runs a long-lived **Neta Node**. The desktop app is one
client of that Node; a phone or another desktop may connect later. Closing a
client leaves the Node and its work running. Explicitly stopping a Node stops
only the processes owned by that Node.

Each Node is authoritative for its local workspaces, leaders, missions, agents,
ACP conversations, process identities, and worktrees. A machine that goes
offline is shown as offline. Another machine does not steal its sessions or
silently resume its work.

On reconnect, the Node sends one complete current canvas/state snapshot with
bounded summaries, then continues with live events on the same connection. The
client atomically replaces its cached canvas state with that snapshot. Full
conversation histories are fetched separately. There is no rolling change
window or "changes since revision" protocol.

## Workspaces and machines

Neta groups copies of the same Git repository into one workspace by
canonicalizing their Git remote identity. Equivalent SSH and HTTPS remote forms
must not create duplicate workspaces. Each copy still appears beneath its own
machine and retains a separate leader, conversation history, mission registry,
and runtime state.

Non-Git folders are not grouped across machines. Each folder is a standalone
workspace on its machine.

The user chooses a workspace and, when necessary, a machine. The corresponding
leader is the default chat. There is no global Neta chat above workspace
leaders.

## Leaders and missions

A leader stays available for conversation and routes sustained work into
missions. It may handle a small bounded task itself. Any task that writes is
still represented by a mission so its isolation, access, and closeout remain
visible; the workspace leader may act as that mission's lead instead of
spawning another agent.

The workspace leader's conversation is one continuous ACP conversation per
workspace and machine. It is never reset. It compacts as it grows, and the
mission record — numbers, names, objectives, dispositions, and checkpoints —
is the leader's durable memory. How that compaction works, and how the mission
record serves as memory, is not yet designed.

A mission contains:

- one immutable original objective and an append-only record of accepted
  changes;
- one owning workspace and machine;
- one Worktrunk worktree for a Git workspace;
- one mission lead, which may be the workspace leader for direct work;
- its agents and exact ACP conversation identifiers;
- assigned models, skills, access state, progress, blockers, and terminal
  outcomes;
- its integration and closeout state.

A mission lead may create read-only or read-write agents. Ordinary agents
cannot create children, so the hierarchy cannot grow without bound.

## Lead and Lead++

Only workspace leaders and mission leads use leadership modes:

- **Lead** — read-only coordination. The leader may reason, inspect, talk to the
  user, create missions, and create agents, but it cannot mutate the workspace.
- **Lead++** — everything in Lead plus build and write access. A Lead++ leader
  may still create and direct agents.

Leaders begin in Lead. The user may change the selected leader's mode from chat
or the UI. A leader may also request Lead++ automatically by submitting a
concise justification:

- objective;
- why Lead is insufficient;
- target mission and worktree;
- expected kind of mutation;
- estimated number of files affected;
- planned validation;
- estimated Lead++ duration;
- destructive or external effects.

This is a decision record, not private chain-of-thought. Neta may provide hints
for completing it. Automatic approval applies only within the authority already
granted to that leader and charter. Writer exclusion and other mechanical
boundaries still apply.

Lead++ is durable across client and Node restarts. Its duration counts active
connected time, not offline time. After ten active minutes:

- the canvas shows a persistent warning and elapsed time;
- every subsequent Neta tool response reminds the leader why Lead++ is active;
- a reminder becomes eligible every two active minutes and is delivered at a
  safe tool or turn boundary;
- repeated reminders coalesce rather than repeatedly cancelling active work.

Lead++ does not expire automatically. The leader should return to Lead when
mutation work ends. Completing or abandoning a mission returns its mission lead
to Lead.

A manual mode change affects only the selected leader. If it occurs during an
ACP turn, Neta uses its existing steering boundary: cancel the active turn and
re-prompt the same exact session with the mode-change event. The UI must show
mode with text and an icon as well as color. The compact labels are **Lead** and
**Lead++**; Lead++ is described as "build access" for accessibility.

## Agents, skills, providers, and models

Scout, worker, reviewer, debater, apprentice, journeyman, expert, and architect
are not product-level agent types or tiers.

An ordinary agent receives:

- a bounded task;
- read-only or read-write access chosen by its mission lead;
- an ACP provider;
- a concrete model;
- optional reusable skills or guidance;
- the mission worktree and relevant context.

Skills are composable instruction and tool bundles, not identities. A leader
may attach the guidance needed for the task without forcing a predefined
workflow.

Each ACP provider has a configured default model. A leader may override it for
an individual agent. Provider, model, skills, access, and exact conversation ID
persist with the session and survive resume.

## Writers and worktrees

Every Git mission receives a Worktrunk worktree by default, including
investigation missions. Missions do not use the base checkout for ordinary
work. Separate mission worktrees may proceed concurrently, but each worktree
has at most one active writer. Additional writers for that worktree queue FIFO.

Worktrunk owns creation, naming, integration, and removal of Git worktrees.
Neta invokes and verifies Worktrunk; it does not reimplement Git worktree
lifecycle logic.

The base checkout is an integration surface. Workspace-leader integrations and
closeouts serialize so two missions cannot merge into it concurrently.

Non-Git workspaces have no worktree isolation:

- any number of read-only missions may run concurrently;
- exactly one writing mission may run at a time;
- additional writing missions are accepted and queue FIFO;
- the next writing mission starts when the current one releases the workspace
  writer lease.

## Mission lifecycle and closeout

Finishing implementation or merging a branch does not close a mission. Every
non-closed mission remains in the workspace leader's mission inbox until the
leader records its disposition.

The lifecycle is:

```text
active or blocked
        ↓
ready to close
        ↓
merged or abandoned
        ↓
closed and archived
```

The workspace leader owns closeout. It reviews the handoff, integrates or
abandons the work, and calls the mission-close tool. Closeout requires:

- disposition: **merged** or **abandoned**;
- a concise reason;
- integration evidence when merged;
- a successful Worktrunk cleanup result for a Git mission.

There is no "retained but closed" disposition. If the worktree must remain, the
mission remains open and visible. Removal of a dirty or unmerged worktree is
refused unless abandonment is explicit and recorded.

A closed mission stays on the spine at its start position, marked Archived.
Once its agents are archived it shrinks to its lead node. It opens read-only.
Archive is a state, not a place. Continuing old work still creates a follow-up
mission with a fresh worktree rather than reviving a removed one. The follow-up
records which mission it continues, and the link between them is drawn only
while one of the two is selected.

## The mission inbox

The workspace leader must not forget active work or unanswered questions. The
mission bar is the inbox. It holds the workspace leader, the Now control, and
every open mission that is running or waiting on a person — Blocked, Failed,
Ready to close, and merged but not closed — each with its name and identity
mark, and an attention mark on the ones that are waiting.

The bar is a strip of names and marks. It is never counts, cards, or status
tiles. Clicking a mission in the bar pans the spine to that mission and opens
its lead's conversation.

- every open mission remains visible in the UI;
- blocked questions, failures, ready-to-close missions, and merged-but-unclosed
  missions receive explicit attention states;
- Neta tool responses carry a compact open-mission reminder and spell out
  items requiring action;
- a new leader turn begins with the current mission state;
- reminders stop only after formal closeout.

Completed and archived history may be collapsed or grouped. Open work may be
organized spatially, filtered, or virtualized for performance, but it may not
disappear.

## Agent archive

Within a mission, all running, blocked, and failed agents remain
visible. Up to eight recent completed, non-archived agents are shown directly;
additional completed agents are grouped behind an expandable count.

Every agent has an Archive action:

- archiving a running agent requires confirmation, stops it, then archives it;
- blocked, failed, and completed agents archive immediately;
- archive hides the node from the primary graph but preserves its ACP history
  and outcome.

## ACP, steering, and recovery

ACP is the single transport for leaders, mission leads, and agents across
supported providers. Clicking any agent node opens that exact ACP conversation.
All controls operate through the same Node-owned session rather than a desktop-
specific orchestration path.

ACP cannot inject text into the middle of a prompt turn. Immediate steering and
manual mode changes cancel the active turn, wait for that cancellation boundary,
and send the replacement prompt to the same exact session. Passive reminders
wait for a safe tool or turn boundary and coalesce.

Durable state and process liveness are separate. Restart restores the exact
recorded conversations and marks interrupted work honestly. It does not replay
an interrupted turn, restart an old agent blindly, or invent a replacement
session. The leader receives an interruption event and decides how to continue.

## Clients, cache, and offline state

Each client keeps a bounded read cache so an offline machine remains
understandable:

- canvas structure and status summaries;
- up to 1 MB of recently viewed display messages per ACP conversation;
- message caches for at most the 100 most recently updated agents;
- approximately 100 MB maximum message content before metadata and indexes;
- no large tool blobs, attachments, full diffs, or authoritative process state.

The owning Node retains authoritative history. Cached conversations are
read-only while offline. Opening an uncached conversation while online fetches
it and evicts the least recently updated cached conversation. When the machine
returns, its complete snapshot replaces the cached canvas before the UI reports
the machine as live.

## Canvas

The desktop client is a SwiftUI canvas over the Node state. The canvas is the
spine. The workspace leader is the stable focal node at Now, the right end of
the spine. Missions anchor to the spine at their start time and branch above
and below it. Agents stack away from the spine beneath their mission lead. A
mission's position never changes after it is placed; finishing a mission
changes its state, not its place.

Zoom stretches time horizontally. Nodes never scale, so text stays readable at
every zoom level. Fit fits a time window. Vertical movement is pan only.

The time scale is a lens around the visible window: linear room in view,
compression on both sides. It must remain usable when the spine holds 100,000
missions. Only the visible window is hydrated, and rendering is virtualized.

The Now control has two states: lit when the view is at the live edge, and
showing how far back the view is when it is not. When the workspace leader is
off-screen, a small marker inside the canvas, left of the chat surface, jumps
to it.

Missions that are closed or idle fade. Blocked and Failed keep full emphasis
regardless of age. Faded text keeps a legible contrast floor.

Checkpoints sit on the spine itself. They record events that changed the state
of work, not things that were said:

- Lead and Lead++ changes, with their decision record;
- mission closeouts and merges into the base checkout;
- blocked questions asked and answered;
- failures;
- interruptions after a Node restart;
- charter changes;
- accepted scope changes on a mission.

Conversation turns are not checkpoints. A person may pin a conversation message
as a checkpoint. Each checkpoint type has its own icon. Opening a checkpoint
scrolls the chat to the exact turn or opens the decision record; there is no
separate popover surface. Older checkpoints coalesce into counts.

The desktop client, native CLI, and future mobile clients are alternate views
over the same Node-owned sessions and durable state.

## Desktop information architecture

The desktop window has one primary surface: the canvas.

The chat surface floats on the right and holds the selected agent's ACP
conversation. A person may hide it. It never auto-hides.

The navigator is an overlay that auto-hides. It appears on hovering the left
edge of the window or with a keyboard shortcut (Cmd-L), overlays the canvas
without pushing it, and closes when dismissed. It lists workspaces, the
conditional machine level, and the missions, including archived ones, as a jump
list. It has no leader row. It must not become a dashboard of counts and status
cards. If a workspace exists on only one machine, the machine selector is
omitted.

The mission bar is reserved along the bottom of the window.

The chat header shows the path from the workspace leader to the selected agent,
so one click returns to the leader.

The workspace leader is selected by default. Selecting a mission lead or agent
opens that exact ACP conversation in the same chat surface. Chat is primary;
secondary session information is opened with a **Details** action that either
changes the right-hand view or adds a secondary inspector. It is not a
permanent Chat/Details tab bar.

Mission creation happens through the workspace leader's judgment. There is no
global **New mission** button in the canvas toolbar or navigator. The toolbar is
limited to workspace, machine when needed, Fit, and zoom.

Lead and Lead++ are session states, not competing destinations. Their control
is compact and local to the selected leader. Do not reserve a large permanent
footer, toggle card, or mode panel for them. The mission bar never hosts the
mode control.

## Product language

Use the vocabulary in this manifesto literally in product copy:

- **Workspace**, not project or folder, for the Git repository or ordinary
  directory represented in Neta.
- **Machine** for the host that owns the workspace copy and its entire agent
  tree.
- **Workspace leader**, **mission**, **mission lead**, and **agent** for the
  three execution levels.
- **Lead** and **Lead++** for leader access; describe Lead++ as **build access**
  where a plain-language explanation is needed.
- **Running**, **Blocked**, **Ready to close**, **Failed**, **Offline**, and
  **Archived** for visible lifecycle states.
- **Archived** as a state and **Archive agent** as the action.

Do not expose scout, worker, reviewer, apprentice, journeyman, expert,
architect, model tier, trust tier, or debate role as the identity of an agent.
An ordinary agent may be described by its task, model, access, and skills. Avoid
calling Neta itself a leader or an agent: Neta is the client, engine, and machine
service.

UI copy should be direct and operational. Prefer `Payments regression ·
Blocked` over invented job titles, character classes, or playful status prose.
Agent character may come from name, activity, and restrained visual identity;
it must not require a role taxonomy.

## Canvas interaction and visual grammar

The canvas is a time surface, not an organization chart and not a vertical list
disguised as a graph. The spine runs in one direction because that direction is
time. The rejection of one-direction org charts still stands for hierarchy: a
mission and its agents branch off the spine rather than descending in a single
column.

- The workspace leader is a stable, immediately recognizable focal node at Now.
- Missions anchor to the spine at their start time. They branch above and below
  it; they do not sit on one line.
- A mission lead and its agents are connected with simple edges. Do not wrap
  every mission in a card, amorphous cluster boundary, bubble, or nested panel.
- Nodes must be large enough to select comfortably and must expose their full
  task names. Do not trade clickability for a decorative overview.
- All open missions remain on the canvas. Panning, filtering, virtualization,
  and Fit may manage scale; hiding active missions may not.
- Running, blocked, and failed agents remain visible. Only surplus completed
  agents may collapse behind an explicit expandable count.
- Two-finger trackpad movement pans the canvas. Pinch or explicit controls
  zoom the time axis; Fit restores a useful time window.
- Connections terminate at node anchors and remain visually subordinate to
  labels and status.

Chronology is a first-class property of the canvas. Every mission shows its
permanent number, its start time or relative age, and its current state.
Position on the spine carries the sequence, so no legend is needed.

Status and access never rely on color alone. Use a short label and, where
helpful, an icon in addition to a restrained semantic color. Avoid progress-like
decoration unless it measures real progress.

## Visual direction

Neta should feel like a native, calm, long-running macOS workspace with enough
personality that agents feel present. It must not feel like a generic admin
dashboard, a network architecture diagram, or a novelty visualization.

Use the existing dark canvas, floating panel, violet leader, mint active state,
and semantic status colors as starting tokens, not as a mandate to color every
object. Prefer hierarchy, spacing, type, and alignment before borders, shadows,
cards, or decorative containers. Keep chrome compact so the work remains the
visual subject.

The graph must balance two needs that are both product requirements:

1. enough density to understand several missions and their agents at once;
2. enough size, labeling, and separation to click around and enter any ACP
   conversation without hunting.

The current design exploration has not resolved that balance. A clean but
sparse graph with small circles and large empty regions is not sufficient; it
reads as an architecture diagram and loses agent character. A dense collection
of cards and bubbles is also not sufficient; it becomes gimmicky and obscures
the graph.

## Rejected desktop patterns

The following patterns were tried and explicitly rejected. Do not restore them
without new operator direction:

- a global **New mission** button;
- a large permanent Lead/Lead++ mode chooser;
- Chat and Details presented as permanent tabs with a purple underline;
- decorative purple progress bars that do not represent measured progress;
- large mission cards containing miniature worker lists;
- amorphous bubbles around mission clusters;
- collapsed worker bubbles used where the agents could be shown and clicked;
- a one-direction tree or a single line of agents;
- a perfectly symmetric radial graph used mainly for visual effect;
- chronology represented only by a tiny legend or timestamps that are easy to
  miss;
- playful job-title language that recreates scout/worker/reviewer roles;
- a persistent navigator panel that narrows the canvas;
- a leader row in the navigator;
- mission ordinals that renumber when a mission closes.

The Figma file `Neta Desktop — Workspace Mission Graph` and the Claude Design
canvas `Neta Desktop Canvas` — four directions, Spine, Depth, Bands, and Type,
drawn on the same NoScrubs-scale data — record that exploration. The Spine
direction was selected on 2026-09-03. The decisions in this document supersede
both.

## Open desktop design questions

These remain deliberately unresolved:

- How the lens time scale behaves across months and at 100,000 missions.
- Whether leader activity should show as a subtle texture on the spine, or not
  at all.
- How the leader conversation compacts, and how the mission record serves as
  its memory.
- The exact placement and density of agent stacks when a mission has many live
  agents.

Resolve these through visual prototypes and realistic NoScrubs-scale data, not
through prose alone.

## CHARTER.md

A user-authored `CHARTER.md` defines decision authority: what a leader may do
alone, what requires the user, and when to interrupt. Workspace and user
charters are presented to leaders as session context. The charter governs
authority, including automatic Lead++ approval; provider and model
configuration belongs in settings.

## Non-goals

- A global conversational agent above workspace-machine leaders.
- Cross-machine workers, mission leads, shells, or ACP sessions.
- Unbounded agent nesting.
- Permanent roles or trust tiers as product taxonomy.
- Mandatory scout-writer-reviewer pipelines or full-suite validation for every
  change.
- Silent work replay, session guessing, or ownership transfer when a machine is
  offline.
- Neta's own Git worktree implementation; Worktrunk remains the worktree
  authority.
- A terminal multiplexer or keystroke-injection system.
- A separate archive surface apart from the spine.
