# Development Rules

Read MANIFESTO.md (design) and PLAN.md (current plan and phase) before
non-trivial work. The repo is in the phase PLAN.md says it is in — do not
start a later phase without the operator saying so.

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

## Git

- Never commit unless the user asks. Stage explicit paths; never
  `git add -A` / `git add .`.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`,
  `git stash`, or `git commit --no-verify`.
- Commit message format: `{feat,fix,docs,chore}: <message>` — informative
  and concise.

## Tests

- `bun test`. If you create or modify a test file, run it and iterate until
  it passes. No real provider APIs, keys, or paid tokens in tests — use the
  fake ACP agent fixture.
