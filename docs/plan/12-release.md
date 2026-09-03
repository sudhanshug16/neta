# 12 — Release

Packaging, versioning, publishing, docs. Runs last: every task assumes 00–11
are merged. Nothing here changes behaviour; it changes how the two artifacts
are built, shipped and described. Read first: `docs/plan/README.md`,
`docs/plan/00-reset.md` ("Publish trap"). The artifacts are npm
`@intervene/neta` 3.0.0 — a Node-runnable bundle `dist/main.js` with
`bin.neta` and no dependency tree, so a user needs neither Bun nor a build
step — and `NetaDesktop.app`, built by a script and attached to a GitHub
release by CI, not on npm and not in the App Store.

## Traps

- **Publish trap.** CI publishes whenever `package.json` `version` is not on
  npm. `version` stays `2.2.5` until T12.7, the last commit of the whole plan.
- **Package name.** The registry name stays `@intervene/neta`; `neta` is the
  command. Renaming means a fresh npm package with no trusted-publishing
  configuration and no existing users. Do not rename.
- **Tags pushed by CI do not start workflows.** The publish job pushes
  `v<version>` with `GITHUB_TOKEN` and GitHub suppresses triggers from it, so
  `release.yml` also takes `workflow_dispatch` and T12.7 dispatches it.
- **One version literal.** It lives in `package.json`; the CLI, the `hello`
  reply and the app's plist all read it from there.

## Tasks

### T12.1 package metadata and one version source
Goal: the npm artifact's version is read from `package.json` at runtime, in
exactly one place.
Reads: `docs/plan/12-release.md`, `docs/plan/00-reset.md`, `package.json`.
Writes: `package.json`, `src/version.ts`, `test/version.test.ts`.
Contract: `src/version.ts` exports `netaVersion(): string`, cached in a
module-level variable. From `dirname(fileURLToPath(import.meta.url))` it walks
up at most four directories, reads the first `package.json` named
`@intervene/neta` and returns its `version`, else `"0.0.0-dev"` — so it works
from `src/` and from `dist/main.js`. No other file in `src/` or `apps/` holds
a version literal. `package.json`: `"bin": { "neta": "dist/main.js" }`,
`"engines": { "node": ">=22" }`, `"files": ["dist", "README.md", "LICENSE",
"MANIFESTO.md", "CHARTER.example.md", "CHANGELOG.md", "docs"]`,
`"prepublishOnly": "bun run clean && bun run check && bun test && bun run
build"`, `"version": "2.2.5"` unchanged.
Steps:
1. Write `src/version.ts` as above, `node:fs`, `node:path`, `node:url` only.
2. Point `neta --version` and the Node's `hello` reply at `netaVersion()`;
   delete every constant `grep -rn "2\.2\.5\|VERSION" src apps` finds.
3. Set the `package.json` fields above. Leave `version` alone.
Tests: `test/version.test.ts` — `netaVersion()` equals the `version` field of
`package.json` parsed independently, and matches `/^\d+\.\d+\.\d+/`.
Done when: `bun run check`, `bun test`, `bun run build` and
`node dist/main.js --version` pass and print that version.
Commit: `chore: single version source and v3 package metadata`

### T12.2 macOS app bundle script and notarisation runbook
Goal: one command produces a runnable `NetaDesktop.app` that starts a Node
without npm.
Reads: `docs/plan/12-release.md`, `apps/macos/Package.swift`,
`apps/macos/Resources/Info.plist`, `package.json`.
Writes: `apps/macos/scripts/build-app.sh`, `apps/macos/NOTARIZE.md`,
`apps/macos/README.md`.
Contract: `apps/macos/scripts/build-app.sh` is bash with `set -euo pipefail`,
runs from any working directory (it resolves the repo root from `$0`; `APP_DIR`
is `apps/macos`), takes an optional output directory (default
`$APP_DIR/.build`), and prints the bundle's absolute path as its last line and
nothing else on stdout. In order:
1. `bun build --compile src/cli/main.ts --outfile "$APP_DIR/.build/neta"`
2. `swift build -c release --package-path "$APP_DIR"`
3. assemble `NetaDesktop.app/Contents/{MacOS,Resources}`; copy
   `.build/release/NetaDesktop` to `Contents/MacOS/NetaDesktop`,
   `$APP_DIR/Resources/Info.plist` to `Contents/Info.plist`, every other file
   in `$APP_DIR/Resources/` to `Contents/Resources/`, and the compiled CLI to
   `Contents/Resources/neta` (`chmod 755`)
4. stamp `v=$(node -p "require('./package.json').version")` with
   `/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $v"` and
   `-c "Set :CFBundleVersion $v"`
5. ad-hoc sign inner first, `codesign --force --sign -
   "$APP/Contents/Resources/neta"`, then `codesign --force --options runtime
   --sign - "$APP"`; verify `--deep --strict`; echo the path
Steps:
1. Write the script as contracted; `rm -rf` the bundle path first so a rebuild
   is clean; `chmod +x` it; ignore `apps/macos/.build/`.
2. Add "Building the app" to `apps/macos/README.md`: the command, where the
   bundle lands, and that the app's CLI is at `Contents/Resources/neta`.
3. Write `apps/macos/NOTARIZE.md` as a manual runbook. CI never notarises and
   release zips are ad-hoc signed, so a downloader clears quarantine with
   `xattr -dr com.apple.quarantine NetaDesktop.app`. Then the signed path:
   - `codesign --force --options runtime --timestamp --sign "Developer ID Application: <name> (<TEAMID>)"` on `"$APP/Contents/Resources/neta"`, then on `"$APP"`
   - `xcrun notarytool store-credentials neta-notary --apple-id <apple-id> --team-id <TEAMID> --password <app-specific-password>`
   - `ditto -c -k --keepParent "$APP" NetaDesktop.zip`
   - `xcrun notarytool submit NetaDesktop.zip --keychain-profile neta-notary --wait`
   - `xcrun notarytool log <submission-id> --keychain-profile neta-notary`
   - `xcrun stapler staple "$APP"`, then `spctl -a -vvv -t install "$APP"`
Tests: none automatic; by hand on macOS the script prints a path and `open` on
it launches the window.
Done when: the script succeeds on a clean tree, `codesign --verify --deep
--strict` exits 0, `swift build` and `swift test` pass, and the commit is made.
Commit: `chore: build and sign the NetaDesktop app bundle`

### T12.3 release workflow for the app bundle
Goal: a `v3.*` tag produces a GitHub release with the app zip attached.
Reads: `docs/plan/12-release.md`, `.github/workflows/ci.yml`,
`apps/macos/scripts/build-app.sh`.
Writes: `.github/workflows/release.yml`, `.github/workflows/ci.yml`.
Contract: `release.yml`, named `release`, triggers on `push: tags: ['v3.*']`
and on `workflow_dispatch` with a required `tag` input, has `permissions:
contents: write`, and runs one job `app` on `macos-15` or newer that selects
Xcode 26 (`sudo xcode-select -s /Applications/Xcode_26.app`), checks out the
tag, installs Bun 1.3.14 (`oven-sh/setup-bun@v2`), runs `bun install
--frozen-lockfile` then `bash apps/macos/scripts/build-app.sh`, zips with
`ditto -c -k --keepParent "$APP" "NetaDesktop-$TAG.zip"`, then `gh release
create "$TAG" --verify-tag --generate-notes --title "Neta $TAG"` (tolerating
"already exists") and `gh release upload "$TAG" "NetaDesktop-$TAG.zip"
--clobber`, with `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`. No actions beyond
`actions/checkout@v4` and `oven-sh/setup-bun@v2`. `ci.yml` keeps its `ts`,
`macos` and version-gated `publish` jobs from T0.5 unchanged in behaviour;
the only edit is `ts` running `node dist/main.js --version` after the build.
Steps:
1. Write `release.yml`; resolve `TAG` from `github.ref_name` or the dispatch
   input into `$GITHUB_ENV` in one step so both triggers share the rest.
2. Add the bundle-runs step to `ci.yml`'s `ts` job.
3. Comment at the top of `release.yml` that a CI-pushed tag does not trigger
   it, so it is dispatched by hand.
Tests: none automatic; `actionlint` if available.
Done when: both files parse, CI stays green, and the commit is made.
Commit: `chore: attach the macOS app bundle to v3 releases`

### T12.4 end-to-end smoke script
Goal: one script proves the built bundle opens a workspace and creates a
mission, with no real provider.
Reads: `docs/plan/12-release.md`, `docs/plan/03-acp.md` (provider config file
name and shape), `docs/plan/08-cli.md` (exact command and flag names),
`test/fixtures/fake-acp-agent.mjs`.
Writes: `scripts/smoke.sh`, `.github/workflows/ci.yml`, `package.json`.
Contract: `scripts/smoke.sh` is bash, `set -euo pipefail`, takes no
arguments, needs only `node`, `git` and a built `dist/main.js`, and exits 0
only on success. It creates `WORK=$(mktemp -d)` with
`trap 'node dist/main.js node stop >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT`;
exports `NETA_DIR="$WORK/neta"`; creates `$WORK/repo` with `git init`, a local
`user.name`/`user.email` and one commit; writes the provider config named in
`03-acp.md` with `test/fixtures/fake-acp-agent.mjs` as the only provider; runs
`neta open "$WORK/repo"`; drives one prompt through the CLI chat that makes
the fake agent call `neta_mission` once; then asserts
`grep -rq '"kind":"mission.created"' "$NETA_DIR/events"` and that
`neta missions` lists exactly one mission, numbered 1. Every `neta` invocation
is `node dist/main.js …`; the run fails rather than hangs after 120 seconds;
the last line is `smoke: ok`. `package.json` gains `"smoke": "bash
scripts/smoke.sh"`.
Steps:
1. Use the fixture's existing scripting mechanism to make the agent emit one
   `neta_mission` tool call; do not modify the fixture.
2. Write the script and `chmod +x` it.
3. Add `bun run build && bun run smoke` to the `ts` job in `ci.yml`, and the
   same two steps to the `macos` job after `swift test`.
Tests: the script is the test; it passes twice in a row from a clean `NETA_DIR`.
Done when: `bun run smoke`, `bun run check`, `bun test` pass, commit made.
Commit: `chore: end-to-end smoke test for the released bundle`

### T12.5 rewrite docs/how-it-works.md for v3
Goal: the architecture document describes v3 and no v2 concept.
Reads: `MANIFESTO.md`, `docs/plan/README.md`, and in `docs/plan/`:
`02-store.md`, `04-node.md`, `06-worktrees.md`, `07-modes.md`, `08-cli.md`;
plus the first 40 lines of `docs/how-it-works.md` for tone, not content.
Writes: `docs/how-it-works.md`.
Contract: replaced whole, 250–400 lines, present tense, no emoji, sections in
this order: the process tree (Node, CLI, desktop, `neta mcp` proxy) as an
ASCII diagram, then why the Node is long-lived and what happens when each
client dies; the socket protocol (`hello`, snapshot, notification kinds, why
there is no "changes since revision"); the store layout under `~/.neta/` with
its directory listing; missions (permanent numbers, states, dispositions,
closed missions never leaving the registry); agents and the name pool;
worktrees and the single writer lease; Lead and Lead++; the clients and what
each can and cannot do. Every claim is checkable against a named source file;
the words tier, role, room, note, `neta_exec`, Zellij, tmux and bridge do not
appear.
Steps:
1. Draft from the plan files, not from memory of v2.
2. Fix every internal link (`README.md`, `MANIFESTO.md`, `docs/settings.md`).
Tests: none.
Done when: `grep -in "tier\|\brole\b\|room\|neta_exec\|zellij\|tmux\|bridge"
docs/how-it-works.md` is empty, links resolve, `bun run check` passes, and the
commit is made.
Commit: `docs: rewrite how-it-works for v3`

### T12.6 site copy and changelog
Goal: the public page speaks v3 and 3.0.0's removals are written down.
Reads: `docs/index.html`, `docs/how-it-works.md`, `MANIFESTO.md`,
`docs/plan/README.md`.
Writes: `docs/index.html`, `CHANGELOG.md`.
Contract: `docs/index.html` keeps its structure and styles; only copy
changes, to the v3 vocabulary — Node, workspace, leader, mission, mission
lead, agent, spine, mission bar, Lead and Lead++ — and the install line reads
`npm i -g @intervene/neta`. `CHANGELOG.md` is new, newest first, one
`## 3.0.0 — <ISO date>` section with `### Removed`, `### Added`,
`### Changed`, closing on: 2.2.5 is the last v2 release, and there is no
migration because v2 checkpoints are not imported. `### Removed` is one bullet
per thing with its replacement: worker tiers and roles (missions, one agent
each, plus the leader's Lead/Lead++ modes); rooms (the spine and mission bar);
notes (the event log and mission records); `neta_exec` (agents run their own
commands in their own worktree; the Node executes nothing for a leader); the
stdio desktop bridge (a long-lived Node on a Unix socket with push
notifications, surviving every client).
Steps:
1. Rewrite the page copy; leave CSS, `CNAME` and `favicon.svg` alone.
2. Write `CHANGELOG.md`: factual, under 60 lines.
Tests: none.
Done when: `bun run check` passes, the page renders, and the commit is made.
Commit: `docs: v3 site copy and 3.0.0 changelog`

### T12.7 release 3.0.0 (operator)
Goal: 3.0.0 is on npm, the app zip is on the release, the plan is signed off.
Reads: `docs/plan/12-release.md`, `docs/plan/README.md`, `AGENTS.md`
("Releases"), `README.md`.
Writes: `package.json`, `README.md`, `docs/plan/DONE.md`.
Contract: `package.json` `version` becomes `3.0.0` — the only commit in the
plan that changes it, and the last. `README.md` describes v3 as shipped and
drops the "rebuild in progress" wording from T0.6. `docs/plan/DONE.md` is a
checklist of `- [ ]` lines an operator ticks, in this order: workstreams
00–11 merged with their commits present; `bun run check`, `bun test`, `bun run
build`, `node dist/main.js --version` and `bun run smoke` green on a clean
clone; `swift build -c release` and `swift test` green;
`bash apps/macos/scripts/build-app.sh` produces a bundle that launches and
connects to a Node started from `Contents/Resources/neta`; the three docs
updated; and the plan's definition of done — on a real Node with the fake
agent driving fourteen missions, the Paper artboards "Neta · Spine", "Neta ·
Typical day" and "Neta · Navigator open" are reproduced, and every manifesto
MUST in `design/canvas-directions/BRIEF.md` holds in the running app, one
checkbox line per MUST.
Steps:
1. Tick `docs/plan/DONE.md` to the end. If a line cannot be ticked, stop: no
   release, and the gap gets a task.
2. Bump `version` to `3.0.0`, update `README.md`, commit and push to `main`.
   CI publishes `@intervene/neta@3.0.0` and pushes tag `v3.0.0`.
3. That tag does not start the release workflow (see Traps), so run
   `gh workflow run release.yml -f tag=v3.0.0` and confirm
   `NetaDesktop-v3.0.0.zip` is attached to the release.
Tests: `npm view @intervene/neta version` prints `3.0.0`, and
`npx -y @intervene/neta@3.0.0 --version` prints `3.0.0` on a machine with
neither Bun nor this repo.
Done when: both checks pass, the zip is attached, and the commit is made.
Commit: `chore: release 3.0.0`
