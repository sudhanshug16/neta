# Neta

Neta (Hindi: leader) is a leader agent. The user talks to the leader. The
leader delegates substantive work to worker agents — Claude Code, Codex,
OpenCode — and drives them to completion. Given a problem, it finishes the
problem and stops. It does not interrupt the user for decisions the user has
already delegated to it.

Vocabulary: **leader** and **workers**. Not "orchestrator" — orchestration
implies mechanical fan-out; the leader exercises judgment, like a tech lead
running a team of engineers.

## Principles

1. **The leader does not write code.** It reads, decides, delegates, verifies.
2. **Delegate by trust, not by "intelligence."** Capability is not one axis;
   a numeric intelligence scale is fake precision.
3. **Finish, then report.** The charter defines what the leader may decide on
   the user's behalf; everything inside that boundary is done without asking.
4. **No UI of our own.** The user stays in the agent CLI they already use and
   pay for. Neta injects instructions, tools and restrictions, and otherwise
   gets out of the way. It owns no terminal, no transcript, no multiplexer.
5. **One repo, one writer.** Reads parallelize; writes serialize.
6. **Workers are quiet.** Progress is pulled by the leader; only terminal
   events and blocking questions push.
7. **Enforcement over instruction.** Every restriction that matters is a
   mechanism — a permission rule, a hook, a kernel sandbox, a protocol
   rejection — because a rule that lives only in a prompt is a suggestion.
8. **Report honestly or stop.** A leader that cannot delegate says so. It never
   does the work itself and never passes its backend's own subagents off as
   Neta workers.

## The leader

- One of the installed agent CLIs, running its own native UI, launched by
  `neta` with the leader instructions appended and Neta's worker tools
  registered as an MCP server.
- Read-only, enforced by that vendor: permission rules and a bash hook on
  Claude Code, `permission.edit: deny` and denied bash patterns on OpenCode, a
  kernel sandbox on Codex. Editing through a shell is blocked, not just
  discouraged; trivial fixes go to a junior worker.
- Worker results reach it by returning from a blocking `neta_wait`, so a worker
  finishing wakes an idle leader without ever interrupting a conversation in
  progress.

## CHARTER.md

A user-authored file defining the leader's decision authority: which decisions
it may take alone (pick a library, merge a PR, close an issue), which need the
user, and when to interrupt. Example: "open and merge PRs on my behalf; ask
before anything touching billing."

- Read from the project, then from `~/.neta`, and embedded in the leader's
  instructions at launch. Embedded rather than referenced: the leader runs
  inside someone else's CLI, and a path we merely point at may never be read.
- The charter is about authority, not plumbing. Model mappings and backend
  config live in settings.

## Workers

Every backend is driven over ACP (Agent Client Protocol) through one internal
transport, so there is one code path rather than one conditional per vendor:

| Backend | ACP entry point | Auth |
| --- | --- | --- |
| Claude Code | `claude-code-acp` (Zed-maintained, Agent SDK) | Claude subscription |
| Codex | `codex-acp` | ChatGPT subscription |
| OpenCode | `opencode acp` (native) | its own config |

A spawn is **role + tier + task**, plus optional writer flag and room.

### Tiers: junior, senior, staff

Tiers describe what you would trust the worker with, not how smart it is.
The descriptions go in the leader's prompt verbatim:

- **junior** — mechanical work with a precise spec: renames, applying a
  reviewed diff, running tests and reporting output. Fails silently on
  ambiguity, so it only gets exact instructions.
- **senior** — well-scoped features, bug fixes with tests, code review.
- **staff** — ambiguity: unknown-cause debugging, design work, debates.

The tier-to-backend mapping lives in settings and may be left unconfigured.
Unconfigured tiers are assigned deterministically: spread round-robin across
installed backends, with reviewer/debater roles preferring a different backend
than the most recent writer when multiple backends are installed (diversity
rule). Explicit overrides pass through `backend` on spawn; `neta_remember`
persists them to `.neta/settings.json`. `neta_plan` computes assignments
without spawning, so the leader can present a staffing plan before proceeding.

### Roles

A role is a prompt: scout, worker, reviewer, debater. Shipped as markdown role
definitions; users add their own. Role and tier are orthogonal — a junior
reviewer and a staff reviewer run the same prompt on different models.

## Communication

Hub-and-spoke. Workers talk to the leader; workers never talk to each other —
with one exception the leader controls:

- **Rooms.** The leader may spawn a group with intercommunication enabled.
  Members post to a shared transcript; the leader reads it when it chooses and
  is never used as a message relay. This is how debates run.

Everything crosses agent boundaries as a **blocking tool call**, never as
keystrokes typed into someone else's terminal:

- `neta notify <msg>` — appends to the worker's log. The leader pulls this on
  demand; it does not push. Workers can narrate freely without hammering the
  leader.
- `neta ask <question>` — blocks the worker until the leader answers.
  Tier-gated: juniors do not get `ask` — a blocked junior fails fast with a
  report and the leader respawns it with a better spec.
- `neta_plan` — computes backend assignments for proposed workers without
  spawning them, so the leader can present a staffing plan.
- `neta_remember` — persists a tier-to-backend override to the project's
  `.neta/settings.json` (JSON rewrite; comments not preserved).
- `neta_wait` — blocks the leader until named workers reach a terminal state,
  and returns what they said.
- `neta_note` — open-notes ledger for recording parked work, pending decisions,
  and promised follow-ups. Workers can be linked to notes; when a worker
  finishes, its state lands on the note. Close when verified done.

Two doors reach the same orchestrator: MCP tools, which the leader uses because
they run outside its sandbox, and a Unix socket with the `neta` CLI, which
workers and humans use from any shell.

## Workspace

All workers run in the directory they were spawned in.

- **Read-only by default.** Enforced at the ACP permission layer: the client
  (Neta) approves reads and reporting, denies edits and writes. Not prompt
  discipline — protocol enforcement, identical across backends. A worker's
  *shell* is only sandboxed where its backend supports it; that gap is
  documented rather than assumed away.
- **Single writer slot.** When a writer is already active, additional writer
  spawns queue automatically (FIFO) and start when the slot frees. Queued
  workers can be killed. The spawn result says queued vs running. Reads and
  thinking parallelize; repo writes serialize.
- **Commit on handoff.** A writer commits everything before finishing, with a
  message stating what was done and why. The next writer is briefed from
  `git log` — cheap, durable context transfer.
- **Scratchpad.** Every worker gets a temp directory outside the repo.
- **No worktrees.** Worktree setup/teardown (installs, env, scripts) is harness
  business. If the environment Neta runs in provides workspace isolation, the
  leader may use it for parallel writers; otherwise parallel writing simply is
  not offered.

## Visibility

- Every worker can have a pane (Zellij or tmux) streaming its log, so a person
  can look at what a worker is doing without asking the leader. Panes read
  without consuming: nothing shown in a pane is taken from the leader.
- Token usage and cost are aggregated per worker and shown in `neta workers`.
  Spend that nobody can see is spend nobody controls.

## Flavors

Playbooks the leader reaches for when the task shape matches — ordinary
markdown, user-extendable. Shipped:

- **implement** — decompose the task, spawn workers by tier, reviewer pass,
  iterate until clean, PR/merge per charter.
- **decide** — for real tradeoffs. Frame the question, assign opposing stances
  to debaters in a room, fixed rounds, judge pass. Output is a decision memo
  that records the losing arguments. Architecture discussions are `decide`,
  usually with an `investigate` front.
- **investigate** — parallel scouts map code or reproduce a bug; one
  synthesis. Feeds the other two.

## Non-goals

- A Neta-owned TUI, transcript view, or terminal multiplexer.
- Keystroke injection into other agents' terminals.
- Worker-to-worker messaging outside rooms.
- Worktree or workspace management of our own.
- A daemon: the control plane lives exactly as long as the leader session.
