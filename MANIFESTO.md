# Neta

Neta connects the user to persistent agent teams across workspaces. The user
talks to the workspace leader in one native OpenCode conversation per workspace copy on a
machine. Neta Node is the machine service. The workspace leader sends work to that copy's
coordinator, who retains execution ownership. The user can also open the
OpenCode conversation of any mission lead or agent beneath the leader.

This manifesto defines the target product. The current implementation is still
described in [docs/how-it-works.md](docs/how-it-works.md) while the migration is
in progress. When the two documents disagree, this manifesto is the product
direction and `docs/how-it-works.md` is the description of what ships today.

## Vocabulary

- **Neta** — the product and machine service.
- **Workspace leader** — the assistant the user talks to in a native OpenCode
  conversation for one workspace copy. It sends work to the coordinator.
- **Neta Node** — the machine service that stores work, routes messages, and
  keeps OpenCode sessions running. It is not another assistant.
- **Workspace** — a Git repository or an ordinary folder in which work happens.
- **Machine** — a physical host, virtual machine, or isolated runtime that owns
one copy of a workspace and runs its complete agent tree.
- **Coordinator** — the persistent assistant for one workspace on one machine, with a fixed role name. It has
  its own OpenCode conversation and decides whether to work directly or create a
  mission.
- **Filter** — an internal, workspace-scoped OpenCode session that decides which
  captured results, failures, and questions need the workspace leader's attention. It cannot
  execute work, grant permission, or speak in the user's chat.
- **Update notice** — a durable message from the filter to the workspace leader. Delivery means
  it reached the workspace leader's native OpenCode session; presentation means the workspace leader used it in
  a completed reply to the user. Neither means the work itself is complete.
- **Mission** — one bounded objective. A Git mission receives its own Worktrunk
  worktree by default. Every mission has a permanent number assigned at
  creation that never changes.
- **Mission lead** — the agent responsible for one mission. It may work directly
  or create ordinary agents.
- **Agent** — a bounded helper beneath a mission lead. Ordinary agents cannot
  create children.
- **Spine** — the canvas's time axis. Every mission anchors to it at its start
  time and stays there permanently.
- **Now** — the live end of the spine, where the coordinator sits.
- **Checkpoint** — a marker on the spine for an event that changed the state of
  work.
- **Mission bar** — the compact bar reserved along the bottom of the window. It
  holds the coordinator, the Now control, and every open mission that is
  running or waiting on a person.

Each workspace copy has this fixed ownership tree:

```text
Workspace copy on one machine
├── Workspace leader (the user's chat)
├── Filter (native chat)
└── Coordinator
    └── Mission
        └── Mission lead
            └── Agents
```

The workspace leader sends work down to the coordinator. Results travel back through the
filter to the workspace leader. Neta Node stores the evidence, routes messages, and records
delivery and presentation. The machine level is hidden in the UI when a
workspace exists on only one machine.

## Principles

1. **Leaders exercise judgment.** A leader may investigate, build, delegate,
   validate, or ask for help. Delegation is a capability, not a ritual.
2. **One objective, one mission.** Missions are bounded units of work with clear
   ownership, history, and closeout.
3. **Execution is machine-local.** A leader, its mission leads, their agents,
   OpenCode sessions, shells, and worktrees all run on the machine that owns the
   workspace copy. Neta never distributes one agent tree across machines.
4. **Isolation before ceremony.** Git missions use Worktrunk worktrees. Neta
   does not require a scout, writer, reviewer, or full test suite for every
   change.
5. **Access follows assignments.** Mission leads inherit mission access; workers
   retain assigned read-only or read-write access. Node owns writer admission.
6. **Every conversation is a real OpenCode session.** Native and future clients
   open the same exact OpenCode sessions. There are no dummy chat surfaces and no
   keystroke injection.
7. **Work survives the UI.** Closing a client does not stop the machine service.
   State, conversations, missions, modes, skills, and model choices are durable.
8. **Nothing important disappears.** Active missions, blocked questions,
   unfinished closeouts, failures, and archives remain discoverable.
   Neta attention records stay tied to their workspace copy and do not depend
   on the chat scroll position.
9. **Authority is explicit.** A charter defines what leaders may decide and
   which destructive, production, financial, credential, or outward-facing
   actions require the user.
10. **Idle means idle.** The service is event-driven and bounded. It avoids
    polling, unbounded transcript hydration, and rendering work outside the
    visible canvas.

## Neta on each machine

An opted-in machine runs a long-lived **Neta Node**. The OpenCode/OpenTUI terminal
is its supported interactive client. Closing a
client leaves the Node and its work running. Explicitly stopping a Node stops
only the processes owned by that Node.

Each Node is authoritative for its local workspaces, leaders, missions, agents,
OpenCode conversations, process identities, and worktrees. A machine that goes
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

The user chooses a workspace and, when necessary, a machine. The workspace leader's conversation
for that exact workspace copy is the default chat. Its leader, missions, and
agents remain on that machine. There is no global workspace leader chat above workspace
copies.

The workspace leader may answer from verified current state or route the user's exact request
to that coordinator. The workspace leader does not create missions, hire agents, take writer
authority, or approve access. The leader owns mission creation; mission leads
own their workers. Work results and failures enter the durable filter.
Only a completed workspace leader chat turn tied by Node to a delivered notice counts as
presented to the user. The notice keeps its source references inside Node; the workspace leader
does not have to repeat them. A delivery receipt alone does not count as work
progress or presentation.

The filter has one tool to send a message to the workspace leader. After a
workspace leader turn, Node sends its conversation update to the filter for
context only. After a coordinator turn, Node sends the completed reply and the
filter either calls the tool once or sends nothing. Node owns delivery,
internal transcript references and deduplication. Models supply no evidence
IDs or acknowledgments. Filter errors are visible processing failures with
bounded retry. The workspace leader's own reply never starts another
notification cycle.

## Leaders and missions

A leader stays available for conversation and routes sustained work into
missions. It may handle a small bounded task itself. Any task that writes is
still represented by a mission so its isolation, access, and closeout remain
visible; it requires a separate mission lead. The coordinator can review and integrate that mission's work.

The coordinator's conversation is continuous by default per workspace and
machine. A person may explicitly reset the selected chat to a fresh provider
conversation when its direction is no longer useful. Reset preserves the old
transcript as history and retains the owner, project, mission, provider, model,
access, and role instructions; it carries no prior conversational context. It
compacts as it grows, and the
mission record — numbers, names, objectives, dispositions, and checkpoints —
is the leader's durable memory. How that compaction works, and how the mission
record serves as memory, is not yet designed.

A mission contains:

- one original objective, with scope changes recorded in conversation;
- one owning workspace and machine;
- one Worktrunk worktree for a Git workspace;
- one mission lead with an actor and conversation distinct from the coordinator;
- its agents and exact OpenCode conversation identifiers;
- assigned models, skills, access and factual runtime activity;
- its integration and closeout state.

A mission lead may create read-only or read-write agents. Ordinary agents
cannot create children, so the hierarchy cannot grow without bound.

## Assigned access and activity

Coordinators have read-write access for review and integration. Mission leads
inherit their mission's assigned access; workers retain their assigned access.
Node acquires the write slot before every writing turn, including parent wakeups
and follow-ups, and releases it only after execution stops. Resuming reacquires it.
A writing lead finishes its turn to let queued workers run.

Activity means Running or Not running. Questions, failures and integration details
remain conversation or runtime facts, not tool-authored activity states.

## Agents, skills, providers, and models

Scout, worker, reviewer, debater, apprentice, journeyman, expert, and architect
are not product-level agent types or tiers.

An ordinary agent receives:

- a bounded task;
- read-only or read-write access chosen by its mission lead;
- the OpenCode runtime;
- a concrete model;
- optional reusable skills or guidance;
- the mission worktree and relevant context.

Skills are composable instruction and tool bundles, not identities. A leader
may attach the guidance needed for the task without forcing a predefined
workflow.

For OpenCode delegation, the leader supplies task difficulty as `effort` from
1 to 5, separately from the model's reasoning setting. Neta selects only from
connected models using the user's fixed effort-to-model configuration or the
Jev classifier. Explicit model choices bypass routing. An omitted model never
silently inherits the parent's model; routing failures do not change policies.
Model, routing decision, skills, access, and exact conversation ID persist
with the session and survive resume.

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
non-closed mission remains in the coordinator's mission inbox until the
leader records its disposition.

The lifecycle is **open → closed**, with completed, merged or abandoned disposition.
A final reply can be a result, question or explanation of remaining work.

The coordinator owns closeout. It reviews the handoff, integrates or
records completed non-code work, or abandons the work, and calls the mission-close tool. Closeout requires:

- disposition: **completed**, **merged**, or **abandoned**;
- a concise reason;
- integration evidence when merged;
- a successful Worktrunk cleanup result for a Git mission.

**Completed** records successful checks, research, and other work with nothing
to merge. It requires a clean worktree with no unmerged changes; it never
forces removal. Normal agent turn completion means **Idle**, not Interrupted
or proof that the mission is complete. Its parent receives the final reply
and decides whether to continue or close. No completion-registration tool is required.

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

The coordinator must not forget active work or unanswered questions. The
mission bar is the inbox. It holds the coordinator, the Now control, and
every open mission that is running or waiting on a person. Its activity mark
says only Running or Not running. Questions, failures, and closeout needs appear
in native chat and mission details, separate from runtime activity.

The bar is a strip of names and marks. It is never counts, cards, or status
tiles. Clicking a mission in the bar pans the spine to that mission and opens
its lead's conversation.

- every open mission remains visible in the UI;
- questions stay in conversation; failures and integration details remain visible
  without changing the activity label;
- Neta tool responses carry a compact open-mission reminder and spell out
  items requiring action;
- a new leader turn begins with the current mission state;
- reminders stop only after formal closeout.

Completed and archived history may be collapsed or grouped. Open work may be
organized spatially, filtered, or virtualized for performance, but it may not
disappear.

## Agent archive

Within a mission, executing agents remain visible. Delivery failures remain
inspectable through `/delivery` instead of appearing in the spine.
Up to eight recently stopped agents are shown directly; older stopped agents
remain accessible in history.

Every agent has an Archive action:

- archiving a running agent requires confirmation, stops it, then archives it;
- blocked, failed, and completed agents archive immediately;
- archive hides the node from the primary graph but preserves its conversation history
  and outcome.

## OpenCode sessions, steering, and recovery

The Node controls private OpenCode V2 servers through their native APIs. Clicking
any agent node opens that exact saved OpenCode session. Neta owns mission
identity, writer authority, message admission, and tool authentication.

Neta delivers internal reports as separate native synthetic messages at the next
safe model step without cancelling the running execution. Human steering keeps
its native behavior; an explicit queue choice waits for later. Before a completed
reply travels to a parent, Node checks for unread reports. If any remain, the
agent resumes with them and its later final reply travels upward.

Durable state and process liveness are separate. Restart restores the exact
recorded conversations and marks interrupted work honestly. It does not replay
an interrupted turn, restart an old agent blindly, or invent a replacement
session. The leader receives an interruption event and decides how to continue.

## Clients, cache, and offline state

Each client keeps a bounded read cache so an offline machine remains
understandable:

- canvas structure and status summaries;
- up to 1 MB of recently viewed display messages per conversation;
- message caches for at most the 100 most recently updated agents;
- approximately 100 MB maximum message content before metadata and indexes;
- no large tool blobs, attachments, full diffs, or authoritative process state.

The owning Node retains authoritative history. Cached conversations are
read-only while offline. Opening an uncached conversation while online fetches
it and evicts the least recently updated cached conversation. When the machine
returns, its complete snapshot replaces the cached canvas before the UI reports
the machine as live.

## Retired desktop design

The native Swift/macOS app has been removed. The canvas and desktop design
sections below are historical exploration, not current implementation or release
requirements. The supported client is OpenCode/OpenTUI with Neta's workspace
and machine navigation, mission spine, agent tabs, and native chat. Current
terminal behavior is documented in [OpenCode integration](docs/opencode.md).
Do not reintroduce the Swift app or its build/test/release jobs.

### Historical canvas

The desktop client is a SwiftUI canvas over the Node state. The canvas is the
spine. The coordinator is the stable focal node at Now, the right end of
the spine. Missions anchor to the spine at their start time and branch above
and below it. Agents stack away from the spine beneath their mission lead. A
mission's position never changes after it is placed; finishing a mission
changes its state, not its place.

Missions and checkpoints form one sequence in time order along the spine. Each
mission's anchor sits directly beneath or above its card, joined by a straight
vertical connector; nothing bends and nothing stacks. The gap between
neighbours is elapsed time clamped between a minimum column and a maximum gap,
so a quiet weekend reads as a wider gap and a burst of missions packs tightly.
Tick labels sit where day and hour boundaries fall between items; they
annotate, and the sequence carries the chronology.

Zoom changes only how much elapsed time shows: at minimum zoom the spine is a
uniform sequence, at maximum a long gap stretches to its cap. Nodes never
scale. Fit brings every open mission into view when the minimum column allows,
otherwise it shows the newest. Vertical movement is pan only. The spine must
remain usable at 100,000 missions; only the visible range is materialised, and
rendering is virtualised.

The Now control has two states: lit when the view is at the live edge, and
showing how far back the view is when it is not. When the coordinator is
off-screen, a small marker inside the canvas, left of the chat surface, jumps
to it.

Missions that are closed or not running may fade. Unanswered questions and
failures remain visible in native chat regardless of age. Faded text keeps a
legible contrast floor.

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

### Historical desktop information architecture

The desktop window has one primary surface: the canvas.

The chat surface floats on the right and holds the selected agent's OpenCode
conversation. A person may hide it. It never auto-hides.

The navigator is an overlay that auto-hides. It appears on hovering the left
edge of the window or with a keyboard shortcut (Cmd-L), overlays the canvas
without pushing it, and closes when dismissed. It lists workspaces, the
conditional machine level, and the missions, including archived ones, as a jump
list. It has no leader row. It must not become a dashboard of counts and status
cards. If a workspace exists on only one machine, the machine selector is
omitted.

The mission bar is reserved along the bottom of the window.

The chat header shows the path from the coordinator to the selected agent,
so one click returns to the leader.

The coordinator is selected by default. Selecting a mission lead or agent
opens that exact OpenCode conversation in the same chat surface. Chat is primary;
secondary session information is opened with a **Details** action that either
changes the right-hand view or adds a secondary inspector. It is not a
permanent Chat/Details tab bar.

Mission creation happens through the coordinator's judgment. There is no
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
- **Workspace leader** for the user-facing assistant.
- **Coordinator**, **mission**, **mission lead**, and **agent** for the
  execution hierarchy.
- **Read-only** and **Read-write** for assigned access.
- **Running** and **Not running** for current execution activity. Keep
  questions, failures, closeout, offline state, and archives as separate facts.
- **Archived** as a state and **Archive agent** as the action.

Do not expose scout, worker, reviewer, apprentice, journeyman, expert,
architect, model tier, trust tier, or debate role as the identity of an agent.
An ordinary agent may be described by its task, model, access, and skills. Avoid
calling the product Neta an agent: Neta is the client, engine, and machine
service. The user-facing assistant is the workspace leader.

UI copy should be direct and operational. Prefer `Payments regression · Not running`
with its pending question in native chat over a status that guesses why
execution stopped.
Agent character may come from name, activity, and restrained visual identity;
it must not require a role taxonomy.

## Historical desktop interaction and visual grammar

The canvas is a time surface, not an organization chart and not a vertical list
disguised as a graph. The spine runs in one direction because that direction is
time. The rejection of one-direction org charts still stands for hierarchy: a
mission and its agents branch off the spine rather than descending in a single
column.

- The coordinator is a stable, immediately recognizable focal node at Now.
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

## Historical desktop visual direction

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
2. enough size, labeling, and separation to click around and enter any OpenCode
   conversation without hunting.

The current design exploration has not resolved that balance. A clean but
sparse graph with small circles and large empty regions is not sufficient; it
reads as an architecture diagram and loses agent character. A dense collection
of cards and bubbles is also not sufficient; it becomes gimmicky and obscures
the graph.

## Historical rejected desktop patterns

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

## Historical desktop design questions

These remain deliberately unresolved:

- The minimum column, maximum gap and pixels-per-hour defaults, tuned on
  realistic data.
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
authority and reserved user decisions; provider and model
configuration belongs in settings.

## Non-goals

- A global conversational agent above workspace-machine leaders.
- Cross-machine workers, mission leads, shells, or OpenCode sessions.
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
