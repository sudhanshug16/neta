# Neta

Neta (Hindi: leader) is a leader agent built on a fork of [pi](https://github.com/badlogic/pi-mono).
The user talks to the leader. The leader delegates substantive work to worker
agents — Claude Code, Codex, OpenCode, pi — and drives them to completion.
Given a problem, it finishes the problem and stops. It does not interrupt the
user for decisions the user has already delegated to it.

Vocabulary: **leader** and **workers**. Not "orchestrator" — orchestration
implies mechanical fan-out; the leader exercises judgment, like a tech lead
running a team of engineers.

## Principles

1. **The leader does not write code.** It reads, decides, delegates, verifies.
2. **Delegate by trust, not by "intelligence."** Capability is not one axis;
   a numeric intelligence scale is fake precision.
3. **Finish, then report.** The charter defines what the leader may decide on
   the user's behalf; everything inside that boundary is done without asking.
4. **Stay a thin layer on pi.** Extension-first, minimal core divergence, no
   reinvented TUI. pi already provides steering queues, sessions, skills,
   extensions, and an RPC mode.
5. **One repo, one writer.** Reads parallelize; writes serialize.
6. **Workers are quiet.** Progress is pulled by the leader; only terminal
   events push.

## The leader

- A pi session on a high-capability model, with the read-only tool bundle
  (read, grep, find, ls) plus bash. No edit or write tools. Guidance forbids
  editing through bash; trivial fixes go to a junior worker.
- Implemented as pi extensions plus a system prompt. The only core fork change
  is context-file loading (see charter below).
- Worker events land in pi's message queue: they wake an idle leader
  (`triggerTurn`) but never interrupt an active conversation with the user.

## CHARTER.md

A user-authored file defining the leader's decision authority: which decisions
it may take alone (pick a library, merge a PR, close an issue), which need the
user, and when to interrupt. Example: "open and merge PRs on my behalf; ask
before anything touching billing."

- Loaded in addition to AGENTS.md / CLAUDE.md (small change in pi's
  context-file loader, which currently takes the first match per directory).
- The charter is about authority, not plumbing. Model mappings and backend
  config live in settings.

## Workers

Every backend is driven over ACP (Agent Client Protocol) through one internal
`Worker` interface:

| Backend | ACP entry point | Auth |
| --- | --- | --- |
| Claude Code | `claude-agent-acp` (Zed-maintained, Agent SDK) | Claude subscription |
| Codex | `codex-acp` | ChatGPT subscription |
| OpenCode | `opencode acp` (native) | its own config |
| pi | `pi-acp` (wraps `pi --mode rpc`) | pi config |

A spawn is **role + tier + task**, plus optional writer flag and room.

### Tiers: junior, senior, staff

Tiers describe what you would trust the worker with, not how smart it is.
The descriptions go in the leader's prompt verbatim:

- **junior** — mechanical work with a precise spec: renames, applying a
  reviewed diff, running tests and reporting output. Fails silently on
  ambiguity, so it only gets exact instructions.
- **senior** — well-scoped features, bug fixes with tests, code review.
- **staff** — ambiguity: unknown-cause debugging, design work, debates.

The tier-to-model mapping (e.g. junior=Haiku, senior=Sonnet/Codex, staff=Opus)
lives in settings with shipped defaults and is user-editable. The leader never
sees model names.

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

Worker-to-leader channel is the `neta` CLI over a local socket — no MCP server,
works from any backend's bash tool:

- `neta notify <msg>` — appends to the worker's log. The leader pulls this on
  demand; it does not push. Workers can narrate freely without hammering the
  leader.
- `neta ask <question>` — blocks the worker until the leader answers. Pushed
  into the leader's queue. Tier-gated: juniors do not get `ask` — a blocked
  junior fails fast with a report and the leader respawns it with a better
  spec.
- Completion and failure push into the leader's queue.

## Workspace

All workers run in the directory they were spawned in.

- **Read-only by default.** Enforced at the ACP permission layer: the client
  (Neta) approves reads and `neta` CLI calls, denies edits and writes. Not
  prompt discipline — protocol enforcement, identical across backends.
- **Single writer slot.** The spawn tool errors if a writer is already active.
  Reads and thinking parallelize; repo writes serialize.
- **Commit on handoff.** A writer commits everything before finishing, with a
  message stating what was done and why. The next writer is briefed from
  `git log` — cheap, durable context transfer.
- **Scratchpad.** Every worker gets a temp directory outside the repo.
- **No worktrees.** Worktree setup/teardown (installs, env, scripts) is harness
  business. If the environment Neta runs in provides workspace isolation (e.g.
  Superset), the leader may use it for parallel writers; otherwise parallel
  writing simply is not offered.

## Flavors

Playbooks the leader picks when the task shape matches — ordinary pi skills,
user-extendable. Shipped:

- **implement** — decompose the task, spawn workers by tier, reviewer pass,
  iterate until clean, PR/merge per charter.
- **decide** — for real tradeoffs. Frame the question, assign opposing stances
  to debaters in a room, fixed rounds, judge pass. Output is a decision memo
  that records the losing arguments. Architecture discussions are `decide`,
  usually with an `investigate` front.
- **investigate** — parallel scouts map code or reproduce a bug; one
  synthesis. Feeds the other two.

## Non-goals (v1)

- Worker-to-worker messaging outside rooms.
- Worktree/workspace management of our own.
- An MCP server (the `neta` CLI covers the channel).
- Backward compatibility with upstream pi behavior where it conflicts with the
  above.
