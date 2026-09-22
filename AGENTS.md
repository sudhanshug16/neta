# Development Rules

Read [MANIFESTO.md](MANIFESTO.md) for scope and
[docs/how-it-works.md](docs/how-it-works.md) for the current architecture
before non-trivial work. The v3 rebuild is specified in
[docs/plan/README.md](docs/plan/README.md); each workstream file there is the
engineering spec for its tasks, and the manifesto wins when they disagree. Do
not expand the product beyond those boundaries without the operator saying so.

## Development agent workflow

This repository is developed in regular Codex sessions, outside Neta itself.
Neta's runtime leader modes, mission hierarchy, worker tools, writer leases,
and progress protocol describe the product; they are not prerequisites for
working on this repository.

- Codex may read, investigate, edit, and verify directly. Delegation is optional;
  use ordinary Codex subagents when the task and session instructions allow it.
- Missing Neta tools or an installed `neta` executable do not block development.
- CHARTER.md, when present, governs scope and reserved user decisions. Otherwise,
  decide routine technical matters within the user's request and ask before
  expensive, destructive, or outward-facing actions.
- Preserve unrelated uncommitted work. Serialize edits to shared files and
  verify the resulting diff. Do not commit unless the user asks.
- Report concrete results and blockers using the current Codex session's tools.

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

- Never commit unless the user asks. This applies to Codex and its subagents.
- Stage explicit paths; never `git add -A` / `git add .`.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`,
  `git stash`, or `git commit --no-verify`.
- Commit message format: `{feat,fix,docs,chore}: <message>` — informative
  and concise.

## Tests

- `bun test`. If you create or modify a test file, run it and iterate until
  it passes. No real provider APIs, keys, or paid tokens in tests — use the
  fake ACP agent fixture.
