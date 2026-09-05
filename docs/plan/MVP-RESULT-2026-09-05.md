# MVP delivery result — 2026-09-05

> **Latest corrective delivery:** project opening, failed-provider recovery,
> and Claude catalog presentation are documented in
> [`PROJECT-MODELS-FIX-2026-09-05.md`](PROJECT-MODELS-FIX-2026-09-05.md).

The current-app MVP is delivered as
`/Users/runner/NetaDesktop-mvp.zip`.

- SHA-256: `bdb7f5da0d0271183ae14003cbe147ce7e4e9e0b9bfaa7266033c0bda5a15d2e`
- Signed bundle: `/private/tmp/neta-mvp-ui-final10-1788571330/NetaDesktop.app`
- Runtime build: `15b57218354d96e840bd55d1`
- Archive integrity and extracted-bundle `codesign --verify --deep --strict`: pass.

The final signed-app smoke is
`/private/tmp/neta-delivery-acceptance-20260905`. Its `assertions.txt` reports
`PASS rich-terminal cancel disconnect-terminal recovery-terminal monotonic-seq`.
The final native mode-control run is
`/private/tmp/neta-mode-final10-1788572002`: a real mission supplied the
prerequisite, then native controls completed Lead → Lead++ → Lead and durable
events 2/3.

Validation passed:

- Swift: 487 tests, 0 failures — `/private/tmp/neta-mvp-final-swift.log`
- AgentChatKit: 10 tests, 0 failures — `/private/tmp/neta-mvp-final-chatkit.log`
- Backend: 534 tests, 0 failures twice —
  `/private/tmp/neta-mvp-final-bun-repeat1.log` and
  `/private/tmp/neta-mvp-final-bun-repeat2.log`
- `bun run check`, typecheck, and diff checks: pass.

The delivery includes native chat rendering through AgentChatKit, provider and
model switching with reviewable handoff, workspace and project actions,
mission lifecycle presentation, Glance cards with source links and explicit
catch-up, free canvas navigation, native Liquid Glass controls, and readable
Details. Supporting final evidence includes workspace flow at
`/private/tmp/neta-workspace-final10-1788571402`, Details at
`/private/tmp/neta-details-final10-1788571341`, and Glance at
`/private/tmp/neta-glance-final.ESG3nX`.

Limits are explicit. The locked host could open but not choose and confirm a
system picker URL, and it could not assess physical Liquid Glass composition.
Apple Intelligence was unavailable, so generated-summary quality was not
observed; the labeled excerpt fallback was tested. Rich signed-app smoke uses
an isolated fake ACP provider. Actual provider discovery and initialization
were checked earlier, but this result does not claim a paid-model round trip.
