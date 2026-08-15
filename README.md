# Neta

Neta is a leader agent. You talk to a leader; it delegates work to tiered
worker agents and drives them until the problem is done. The leader never
edits files — that restriction is enforced, not suggested.

Neta is not a TUI. You live in the native UI of the coding agent you already
use and pay for — Claude Code, Codex, or OpenCode. Neta runs behind it:

- `neta` detects the installed agent CLIs, lets you pick one as the leader,
  and launches its native UI with Neta's config injected (system prompt,
  worker tools, write restrictions).
- The leader manages workers through real tools (MCP): spawn, watch, answer,
  kill. Workers run headless over ACP, or in multiplexer panes (Zellij or
  tmux) you can enter and watch yourself.
- Restrictions use each vendor's own enforcement — Codex's kernel sandbox,
  Claude Code's permission rules — so a "read-only" worker is read-only in
  its shell too, not just in its file tools.

Design: [MANIFESTO.md](MANIFESTO.md) — tiers, roles, the single-writer rule,
and the charter that bounds the leader's authority.
Implementation plan: [PLAN.md](PLAN.md).

## Status

Pre-implementation. This repo currently holds the design and plan; code lands
per the phases in PLAN.md. The previous iteration (a pi fork) is archived
locally and being ported per the plan's port map.
