# 00 — Reset

Retire the v2 tree and scaffold v3. T0.1 and T0.2 are destructive; the
operator runs them or explicitly tells the leader to.

Read first: `docs/plan/README.md`.

## Publish trap

CI publishes to npm whenever `package.json` `version` is not yet on npm.
Keep `version` at `2.2.5` through the whole rebuild. Bump to `3.0.0` only in
workstream 12. Do not mark the package private; that also changes CI.

## What is kept

- `MANIFESTO.md`, `CHARTER.example.md`, `LICENSE`, `.gitignore`, `.editorconfig`
  if present, `biome.json`, `tsconfig.json` (revised in T0.3), `bun.lock`
  (regenerated in T0.3).
- `test/fixtures/fake-acp-agent.mjs` verbatim. It is the only ACP agent tests
  may talk to.
- `design/` in full.
- `docs/plan/` (this plan), `docs/settings.md` (rewritten in 08),
  `docs/index.html`, `docs/styles.css`, `docs/CNAME`, `docs/favicon.svg`.
- `.github/workflows/` revised in T0.5.

Everything else under `src/`, `test/`, `apps/`, `scripts/`, `plugins/` or
similar is removed.

## Tasks

Done when, for every task: the files it names exist as contracted, `bun run
check` and `bun test` pass once the scaffold exists, and its commit is made.

### T0.1 baseline commit and tag (operator)
Goal: nothing from v2 is lost. Reads: this file. Writes: none.
Contract: tag `v2-final` on `origin/main`. Tests: none.
Steps: commit the current working tree, including the untracked `apps/`,
`src/desktop/`, `src/workspace.ts`, `test/desktop-bridge.test.ts`,
`test/workspace.test.ts`, `design/`, `docs/plan/`; tag `v2-final`; push both.
Done when: `git tag --contains v2-final` lists the tag on `origin/main`.
Commit: `chore: v2 final state before the v3 rebuild`

### T0.2 remove the v2 tree (operator or leader on instruction)
Goal: an empty `src/`, `test/` (fixtures kept), no `apps/`, no `scripts/`.
Reads: this file. Writes: the removals above. Contract: kept list intact.
Tests: none.
Steps: `git rm -r` the paths listed under "removed" above, path by path,
never `git clean`. Keep the kept list.
Done when: `git ls-files` shows only the kept list plus `package.json`.
Commit: `chore: retire the v2 tree`

### T0.3 TypeScript scaffold
Goal: an empty program that builds, checks and tests.
Reads: `docs/plan/README.md`. Writes: `package.json`, `tsconfig.json`,
`biome.json`, `src/index.ts`, `src/cli/main.ts`, `test/smoke.test.ts`.
Contract: scripts `build` (`bun build src/cli/main.ts --target=node
--outdir=dist --sourcemap=linked && chmod +x dist/main.js`), `typecheck`
(`tsc --noEmit`), `check` (`biome check --write --error-on-warnings . && bun
run typecheck`), `test` (`bun test`), `clean` (`rm -rf dist`); `bin.neta` →
`dist/main.js`; version
stays `2.2.5`; zero runtime dependencies; dev deps `typescript`, `@biomejs/
biome`, `@types/node`, `@types/bun` pinned exact; tsconfig strict,
`module: NodeNext`, `target: ES2023`, `verbatimModuleSyntax`,
`erasableSyntaxOnly`. Steps: write the files as contracted.
Tests: `test/smoke.test.ts` imports `src/index.ts`.
Commit: `chore: scaffold v3 TypeScript package`

### T0.4 Swift scaffold
Goal: an empty macOS 26 app that builds and tests.
Reads: `docs/plan/README.md`. Writes: `apps/macos/Package.swift`,
`apps/macos/Sources/NetaDesktop/NetaDesktopApp.swift`,
`apps/macos/Sources/NetaDesktop/ContentView.swift`,
`apps/macos/Tests/NetaDesktopTests/SmokeTests.swift`,
`apps/macos/Resources/Info.plist`, `apps/macos/README.md`.
Contract: `swift-tools-version: 6.2`, `platforms: [.macOS(.v26)]`, one
executable target `NetaDesktop`, one test target; `LSMinimumSystemVersion`
26.0; bundle id `dev.neta.desktop`; window `.hiddenTitleBar`, default size
1600×1000, min 1100×700, `.preferredColorScheme(.dark)`.
Steps: write the files as contracted.
Tests: one XCTest that instantiates the root view model.
Commit: `chore: scaffold v3 macOS app`

### T0.5 CI
Goal: both halves gated.
Reads: `.github/workflows/ci.yml` (current). Writes: `.github/workflows/ci.yml`,
`.github/workflows/publish.yml` if separate.
Contract: job `ts` on `ubuntu-latest`: `bun install --frozen-lockfile`,
`bun run check`, `bun test`, `bun run build`; job `macos` on `macos-15` or
newer with Xcode 26 selected: `swift build`, `swift test` in `apps/macos`.
Publish job unchanged in behaviour (version-gated).
Steps: write the workflow as contracted. Tests: CI green on the scaffold.
Commit: `chore: build and test both halves in CI`

### T0.6 AGENTS.md and README for v3
Goal: repo instructions match the rebuild.
Reads: `AGENTS.md`, `docs/plan/README.md`. Writes: `AGENTS.md`, `README.md`.
Contract: AGENTS.md keeps the operating contract and code rules, replaces the
"scout/journeyman" wording with the manifesto's (agent, mission lead), points
at `docs/plan/README.md` for the rebuild, and adds the Swift rules from the
plan. README states that v3 is in progress and that 2.2.x on npm is the last
v2 release. Steps: rewrite both files. Tests: none.
Commit: `docs: repo instructions for the v3 rebuild`
