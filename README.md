# Neta

[![ci](https://github.com/sudhanshug16/neta/actions/workflows/ci.yml/badge.svg)](https://github.com/sudhanshug16/neta/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@intervene/neta)](https://www.npmjs.com/package/@intervene/neta)

Neta is the interface, engine, and machine service for running persistent agent
teams across workspaces. You talk to the leader belonging to a workspace on a
machine; sustained work becomes missions with mission leads and agents,
isolated in worktrees, visible on a spine canvas.

**v3 is in progress.** This checkout is being rebuilt from scratch against
[MANIFESTO.md](MANIFESTO.md); the engineering plan is
[docs/plan/README.md](docs/plan/README.md). The last v2 release is 2.2.x on
npm, and there is no migration: v2 sessions are not imported.

## Install

```
npm install -g @intervene/neta
```

One bundled file, no runtime dependencies. Neta needs Node 22+.

## Documentation

- [MANIFESTO.md](MANIFESTO.md) — the product: workspaces, leaders, missions,
  agents, Lead and Lead++, the spine.
- [How it works](docs/how-it-works.md) — the architecture as it ships today.
- [Settings](docs/settings.md) — providers, leader defaults, models.

## Development

The toolchain is [Bun](https://bun.sh):

```
bun install
bun test            # tests talk only to the fake ACP agent fixture
bun run check       # biome + tsc --noEmit
bun run build       # dist/main.js — one file, targets Node
```

The macOS app lives in `apps/macos` (Swift 6, Swift Package Manager):

```
cd apps/macos
swift build
swift test
```

To release, bump `version` in `package.json` and push to `main`. CI publishes
that version to npm if the registry does not already have it. The CLI reads
its version from `package.json`, so there is nothing else to bump.
