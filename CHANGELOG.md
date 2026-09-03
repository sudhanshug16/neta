# Changelog

## 3.0.0 — 2026-09-04

### Removed

- Worker tiers and roles; missions carry one objective each, and leaders coordinate through Lead and Lead++.
- Rooms; the spine and the mission bar show missions and what needs a person.
- Notes; the event log and mission records keep history.
- `neta_exec`; agents run their own commands in their own worktree, and the Node executes nothing for a leader.
- The stdio desktop bridge; a long-lived Node on a Unix socket serves snapshots and push notifications, surviving every client.

### Added

- Long-lived Node owning workspaces, leaders, missions, agents, and conversations under `~/.neta/`.
- Missions with permanent per-workspace numbers, attention states, and closeout with a disposition and evidence.
- Mission leads with Lead and Lead++ access, decision records, and active-time reminders.
- Desktop canvas with the spine, the mission bar, the navigator, and chat on the same Node sessions.
- `neta mcp --actor` stdio proxy forwarding agent tool calls to the Node.

### Changed

- Install is `npm i -g @intervene/neta`; the bundle runs on Node 22+ with neither Bun nor a build step.
- `docs/how-it-works.md` rewritten for the v3 Node, protocol, store, and clients.
- 2.2.5 is the last v2 release. There is no migration: v2 checkpoints are not imported.
