# Development Rules

Read [MANIFESTO.md](MANIFESTO.md) for scope and
[docs/how-it-works.md](docs/how-it-works.md) for the current architecture
before non-trivial work. Do not expand the product beyond those boundaries
without the operator saying so.

## Neta Operating Contract

How agents work in this repo, in short. Design and rationale:
[MANIFESTO.md](MANIFESTO.md).

- **The leader does not write code.** It reads, decides, delegates, verifies —
  including one-line fixes, which go to a journeyman with an exact instruction.
  Reading is for verifying a bounded claim; building understanding across files
  goes to a scout.
- **CHARTER.md, when present, is the authority on scope.** If the project or
  user has a CHARTER.md, anything inside it, do and report afterwards;
  anything it reserves for the user, stop and ask. Without one, decide
  routine technical matters yourself and ask before expensive, destructive,
  or outward-facing actions. Finish the problem, then report once — never
  ask approval for what the charter already granted, and never end a turn
  with "workers are running".
- **Only Neta workers count as delegation.** A backend's own subagent or task
  tool is not a Neta worker, must not be used as a substitute for one, and
  must never be represented as Neta delegation. If delegation is impossible,
  say so in the first reply and stop — do not do the work yourself and do not
  soften the failure.
- **Reads parallelize; writes serialize.** One writer slot per session; extra
  writer spawns queue. A writer commits everything it changes before it
  finishes, so the next writer can be briefed from `git log`.
- **Workers are quiet.** `neta progress` on start, on a completed major step,
  and when something surprising changes the plan — not a running commentary.
  `neta ask` only when genuinely blocked (apprentices and journeymen have none:
  they stop and report). The leader pulls status and blocks on `neta_wait`
  instead of interrupting the user.

## Conversational Style

- Keep answers short and concise. Technical prose, no fluff, no emojis
  (also no emojis in commits, issues, or code).
- Use concise, simple language; define unavoidable jargon before using it.
- Explain non-trivial designs as: problem, concrete example, then solution.
- When the user asks a question, answer it before making edits or running
  implementation commands.
- When responding to feedback, explicitly say whether you agree or disagree
  before saying what you changed.

## Code Quality

- TypeScript, strict. No `any` unless absolutely necessary.
- No inline imports (`await import()`, `import("pkg").Type`). Top-level
  imports only.
- Only erasable TypeScript syntax (Node strip-only mode): no parameter
  properties, `enum`, `namespace`, `import =`, `export =`.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- Always ask before removing functionality that appears intentional.

## Toolchain

Bun, for everything: `bun install`, `bun test`, `bun run build`,
`bun run check`. `bun.lock` is the lockfile; there is no npm lockfile.
Typechecking is the one exception — `bun run typecheck` shells out to `tsc`,
since Bun does not check types.

The published artifact is a Node-runnable bundle (`bun build --target=node`),
so users need neither Bun nor our dependency tree.

## Dependencies

- Direct external deps pinned to exact versions. Treat dep and lockfile
  changes as reviewed code.
- Install with `bun install`.

## Releases

Bump `version` in `package.json` and push to main; CI publishes it if npm does
not have that version yet. Never publish by hand, and never bump the version in
more than one place — the CLI reads it from `package.json`.

## Git

- Never commit unless the user asks. The one exception is a Neta writer worker:
  its injected working agreement tells it to commit on handoff, and that rule
  wins for the writer and only for the writer. Every other agent waits to be
  asked.
- Stage explicit paths; never `git add -A` / `git add .`.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`,
  `git stash`, or `git commit --no-verify`.
- Commit message format: `{feat,fix,docs,chore}: <message>` — informative
  and concise.

## Tests

- `bun test`. If you create or modify a test file, run it and iterate until
  it passes. No real provider APIs, keys, or paid tokens in tests — use the
  fake ACP agent fixture.
