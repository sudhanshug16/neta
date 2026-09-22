# Recovering a partial Worktrunk setup

If `neta_mission` reports `error setupFailed`, no mission is registered and no
agent or provider session started. The private diagnostic path and safe output
excerpts identify the failed Worktrunk setup.

After an operator has handled or deliberately waived setup, retry the same
mission request with `recoverWorktree`: its historical number plus the exact
path, branch and base reported by Worktrunk, and `setupDisposition` set to
`handled` or `waived`. Recovery verifies the repository, canonical path,
branch, base and unused number. It adopts the existing worktree only: it does
not run `wt switch --create`, replay hooks, or claim setup succeeded.

This is intentionally not automatic. A mismatched, moved, replaced, registered
or non-Git worktree is refused.

The operator's disposition is stored in the mission's `worktreeRecovery` field
with the registration itself, including legacy adoption with no diagnostic log.
If a diagnostic cannot be written, the response still reports `setupFailed`,
the original exit/output, and `persistenceError`; it does not advertise a saved
log path. Logs retain at most 20 numeric diagnostic files and 128 KiB per
workspace. Output capture is bounded to 64 KiB per stream; displayed/persisted
excerpts are limited to 4 KiB plus a truncation marker and common credentials
are redacted. These excerpts are diagnostic evidence, not a complete transcript.
Structured `wt list` output has a separate 8 MiB capture budget to support large
repositories; its stderr retains the 64 KiB limit.

## Existing NoScrubs attempts 34 and 35

Read-only inspection confirmed both branches/worktrees at
`228284ad0ada9ba4a4688ae687368da74f001761`. Worktrunk's command log records
pre-start exit 1 for both; it contains no output identifying the failed script
step. The underlying cause remains unknown. Disposable tests with installed
Worktrunk 0.72.0 reproduced partial creation with a failing **pre-start** hook.
A failing post-start hook returned success and is not an equivalent reproduction.

After independently handling setup or explicitly deciding to waive it, the
workspace leader may repeat the intended `neta_mission` staffing request, using
the original mission name `Migrate product GPT workloads` and this additional
field (shown for 34):

```json
{
  "recoverWorktree": {
    "number": 34,
    "path": "/Users/sudhanshugautam/workspace/noscrubs.mission-34-migrate-product-gpt-workloads",
    "branch": "mission/34-migrate-product-gpt-workloads",
    "base": "main",
    "setupDisposition": "handled"
  }
}
```

For 35, replace all three occurrences of 34 with 35. `handled` is an operator
assertion, not a recommendation to run the original setup script. Use `waived`
only for an intentional waiver. The persisted number counter must confirm the
number was allocated and the mission registry must still contain no such mission.
No diagnostic file needs to be invented for these legacy attempts.

This adoption starts the requested mission staffing once validation succeeds.
It runs no setup or removal hooks. Neither procedure was executed on NoScrubs;
its setup and pre-remove hooks include database operations requiring a separate
operator decision.
