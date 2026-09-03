# Plan consistency review

Edits across `docs/plan/`, by class. Appendices untouched.

## 1. Cross-workstream name mismatches

- `04-node.md`: `NodeStore.appendEvent` takes `Omit<Event, "seq" | "at">` and
  `listEvents` a Promise, as 02's `EventLog` defines them; `McpServerConfig` →
  `McpServerSpec` (03); "four handler maps" → three, all beside
  `snapshotHandlers`.
- `04-node.md`: added what consumers expect and no file defined —
  `tools.list`/`tools.call` (05 says 04 routes them by actor token); `from?`/
  `to?` on `missions.list` and `events.list` (02 has the window, 09 pages older
  by time); `turnId?` on `conversation.tail` (11's `scrollTo`, via 02's
  `turnRange`); `missionId?` on `leader.setMode` (08's `--mission <n>`);
  `connectedClients()` and the Lead++ ticker 07 has the Node drive; and a T4.10
  fixture of fourteen missions across every `MissionState`, which 09 T9.9/T9.10
  and 10 T10.9 test against.
- `05-tools.md`: `session/load` → `session/resume`, 03's name (2 places); T5.9
  uses 03's `McpServerSpec`/`netaMcpServer` instead of redeclaring it; named the
  callees 06's `WorktreeService.prepare`/`.close` and 07's
  `ModeService.requestLeadPlus`/`.decorate`.
- `06-worktrees.md`: `returnLeadToLead(missionId)` → 07's
  `onMissionClosed(mission)` (deps, steps, tests, facade).
- `07-modes.md`: `src/store/leaders.ts` → `src/store/records.ts` (02's file).
- `08-cli.md`: `runToolProxy({actor, token, dir})` → 05's `runProxy({actorId,
  token, socketPath})`; bin `dist/cli.js` → `dist/main.js` (00 T0.3, 12 T12.1);
  `data.kind` `auth`/`authority` → 04's `data.code` `UNAUTHORIZED`/
  `CONFIRMATION_REQUIRED`; T8.2 wraps 04's `connectNode` instead of a second
  transport, retry window 10 s → 5 s per T4.4.
- `09-desktop-shell.md`: added the `MachineId`/`MissionId`/`AgentId`/
  `SessionId`/`TurnId` typealiases 10 and 11 use; `Snapshot` now mirrors 04's
  `SnapshotResult` field for field; `ConversationPage.cursor` → `nextCursor`;
  `FixtureNodeClient` gains `emit(_:)` and `calls`, which 11 asserts on.
- `10-desktop-spine.md`: "09 provides" corrected — `agentsById`, `ShellState`
  owns `selection`/`select(_:)`, no `.none` case, `Theme.agentHues`,
  `MissionBarView`, `Shell/RootView.swift` not `ContentView.swift`; so `.none` →
  `.leader`, `store.select(ion)` → `shell.…`, `Theme.text2` →
  `Theme.textSecondary`, and `SpineCanvasView` takes `shell`.
- `11-desktop-chat.md`: "What 09 provides" corrected — 09's named client methods
  for a generic `call`, `TurnPayload` → `TurnChange`, Store/ShellState split,
  `FixtureNodeClient(fixtureDirectory:)`; T11.2 uses 09's `ConversationPage`
  rather than redefining it, T11.6 uses `ModelInfo`, T11.5's header takes
  `selection`, T11.8 replaces 09's `ChatPlaceholder`.
- `00-reset.md`: added the `clean` script 12's `prepublishOnly` invokes.
- Backwards paging, second pass: 02 gains `readBefore({sessionId, cursor,
  limit})` with a test line, 04's `conversation.tail` gains `direction?` and
  `prevCursor` with a test line, 09's `ConversationPage` carries `prevCursor`,
  and 11's `loadOlder` pages through them.

## 2. Contradictions with README.md or 01-domain.md

- `08-cli.md`: `neta mode lead++` no longer "refused, exit 3" — 07 defines
  `leader.setMode` as the manual path, the person's choice, no decision record;
  the record belongs to the leader's own `neta_mode`.
- `08-cli.md`: settings docs match 03 — exact-match `forbiddenModels` not globs,
  03's `ProviderSettings` fields and `claude` package, no `skills`/`charters`
  keys (05 owns those lookups), `NETA_SOCKET` alone in the child environment.
- `08-cli.md`: `readVersion` matches `@intervene/neta`, the real package name.

## 3. Task format

- `00-reset.md`: one "Done when" atop Tasks; T0.1/T0.2 gained Reads, Writes,
  Contract, Tests, Commit; T0.3–T0.6 gained Steps, T0.6 Tests.
- `01-domain.md`: one "Done when" atop Tasks; Steps for T1.2–T1.6; Contract for
  T1.3, T1.4, T1.5.
- 02–12 already carried all eight fields. Ids are `T<workstream>.<n>`, unique.

## 4. Scope creep

- Nothing removed: no task builds multi-machine sync, conversation compaction,
  mobile or a v2 migration. 09's machine menus stay nil on one machine, the
  conversation store stays append-only, 10 rewrites the v2 pan capture.

## Left for the operator

None. Both first-pass gaps are closed: 02's `readBefore`, 04's
`conversation.tail` `direction`/`prevCursor` and 11's `loadOlder` give
scrollback a route, and 04's one timer is the Lead++ clock owned by 07.
