# Mission 3 follow-up verification

Baseline: `a7de7b6b275facfdf30b6a334b1777b8391c94b0`.
Follow-up commit candidate: the worktree changes following `9ac670a`.

## Checks that pass

- Isolated pinned OpenCode fork: `bun test --cwd packages/tui test/neta-recent-missions.test.tsx test/neta-archive-navigation.test.tsx test/neta-presentation.test.ts test/neta-viewport.test.tsx` — 11 pass.
- Isolated fork TUI and CLI typechecks.
- Root `bun run test:opencode` — 7 pass.
- Root `bun run typecheck` and `bun run build`.

## Biome comparison

`bunx biome check .` fails at the baseline with 14 diagnostics. The final worktree has the same 14 diagnostics at the same paths/rules:

1. `test/fixtures/neta-visual-proxy.ts` — `useTemplate` (2) and `organizeImports`.
2. `src/opencode/gateway.ts` — `noUnusedImports`.
3. `test/tools-mission.test.ts` — `noNonNullAssertion`.
4. `src/node/handlers-diagnostics.ts` — `organizeImports` and `noImplicitAnyLet` (2).
5. `src/opencode/attachment.ts`, `src/opencode/launcher.ts`, `src/version.ts`, `test/node-conversation-handlers.test.ts`, `test/version.test.ts`, and `test/worker-model.test.ts` — `organizeImports`.

No mission-added `test/cli-args.test.ts` blank-line diagnostic is present: `git diff --check a7de7b6..HEAD` is clean, and the mission's only change to that test removed the obsolete `rmux` command case.

## Full Bun suite comparison

Baseline `bun test`: 781 pass, 13 skip, 23 fail, 1 module-resolution error across 817 tests/116 files (231.81 s).

After this mission's coherent removal of obsolete rmux/Pi ACP test surfaces, `bun test`: 757 pass, 18 fail, 1 module-resolution error across 775 tests/104 files (154.46 s).

The remaining exact failures are:

1. `the built CLI initializes, prompts, and steers through its installed default Claude adapter without npx` — `mise ERROR No version is set for shim: node`.
2. `an interrupted agent resumes its exact conversation when the leader continues it`.
3. `completed lead follow-up keeps identity and off-screen clients receive completion and question events`.
4. `a rejected idle-agent resume does not invent a replacement session`.
5. `restart preserves writer FIFO and explicit continuation starts the queued head` — queued-head timeout.
6. `an interrupted writer queued behind another resumes its exact history when promoted`.
7. `runtime wakes workspace leader when mission leader ends without a completion tool`.
8. `assignment alternatives [] survive cold resume, reset, and crash recovery` — timeout.
9. `assignment alternatives ["allowed-small-model"] survive cold resume, reset, and crash recovery` — timeout.
10. `the production bundle stages the default Codex adapter and injects live steering`.
11. `a process lost mid-turn produces one interrupted result before closing its journal`.
12. `the built CLI routes the default OpenCode ACP through its installed launcher`.
13. `Pi PTY survives detach and reattach with ordered replay and stale input rejection` — `posix_spawnp failed`.
14. `concurrent attaches start one process and only the latest connection owns input` — `posix_spawnp failed`.
15. `closing one Pi session rejects stale input without affecting another` — `posix_spawnp failed`.
16. `Claude discovery augments rather than replaces an explicit bridge configuration` — `posix_spawnp failed`.
17. `session tool wiring and end-to-end mission creation` — unexpected `neta_model` tool.
18. `prototypes/tui-framework-evaluation/opentui/smoke.test.ts` — `@opentui/core` cannot resolve (the suite's one module-resolution error).

Raw logs are retained outside the repository at:

- `/private/var/folders/l7/vnynj5k50dbgqttzyq_jt6540000gn/T/opencode/neta-mission-3-baseline-full-test.log`
- `/private/var/folders/l7/vnynj5k50dbgqttzyq_jt6540000gn/T/opencode/neta-mission-3-followup-full-test.log`
- `/private/var/folders/l7/vnynj5k50dbgqttzyq_jt6540000gn/T/opencode/neta-mission-3-baseline-biome.log`
- `/private/var/folders/l7/vnynj5k50dbgqttzyq_jt6540000gn/T/opencode/neta-mission-3-final-biome.log`
