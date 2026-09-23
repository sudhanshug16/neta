# Delegation model routing

OpenCode mission leads and workers receive an explicit task difficulty,
`effort: 1–5`. This is not the provider's reasoning setting. The workspace
leader's selected model does not become the default worker model.

| Effort | Meaning |
| --- | --- |
| 1 | Confirmation, extraction, lookup |
| 2 | Bounded investigation, straightforward change |
| 3 | Ordinary implementation and debugging |
| 4 | Ambiguous debugging, substantial design |
| 5 | Exceptionally difficult reasoning or architecture |

Choose the lowest adequate effort. A startup response check is effort 1.
Explicit model selections bypass routing but must still be connected and
allowed. They do not need effort.

## Fixed routing

Place this in `~/.neta/routing.json` (or `$NETA_DIR/routing.json` when that
Neta directory override is used). Replace the example IDs with exact IDs from
OpenCode's connected model catalog:

```json
{
  "mode": "fixed",
  "models": {
    "1": "openai/gpt-5.6-luna",
    "2": "openai/gpt-5.6-luna",
    "3": "openai/gpt-5.6-terra",
    "4": "openai/gpt-5.6-sol",
    "5": "openai/gpt-6-astra"
  }
}
```

All five keys are required. Repeated models are allowed. Each effort maps to
one model; it is not a fallback sequence. If that model is disconnected,
Neta refuses the launch and points to the configuration or `/connect`.
Fixed routing does not call Jev, PublicAI, or models.dev.

A workspace can supply `.neta/routing.json`. It replaces the entire user policy.
The config is read on each new delegation, so mapping changes need no Node
restart. Invalid config is an error, not permission to use a different mode.
Existing and queued agents keep their saved decision unless the user requests
an effort change.

## Changing an existing agent

Ask the workspace leader to "bump mission #4 up", "use a smaller model for
Cove", or "set Cove to effort 4". The leader calls `neta_model`:

```json
{ "missionId": 4, "change": "up" }
```

```json
{ "agentId": "Cove", "effort": 4 }
```

`change` moves the recorded task effort one level up or down, bounded at 1 and 5.
Use either `change` or `effort`. If an older or explicitly selected agent has no
recorded effort, supply an explicit level. Names must be unique within the
caller's scope; exact agent IDs also work. Mission leads can adjust themselves
or their workers, and omitting the target selects their own lead session.
You can also ask a worker directly in its chat. Ordinary workers omit target
fields and can adjust only themselves; they cannot change their lead or peers.

A mission target changes only its lead. Other workers keep their models. Routing
uses the agent's assignment, mission objective, new effort and previous model.
It follows the current fixed mapping or Jev policy and connected model catalog.
If routing selects the same model, Neta reports that without claiming an upgrade.
Routing failure leaves the existing choice in place.

The session and transcript stay intact. The change applies at the next model
call; an in-flight response is not cancelled or restarted. Queued workers use the
new choice when launched, without being started by this tool. Archived agents
and closed missions cannot be adjusted. Missions led by the workspace leader
share its conversation; use `/models` there instead.

This tool is for user-requested changes. Agents must not increase effort on their
own to bypass a routing refusal. Task effort remains separate from the model's
reasoning setting.

## Jev routing

The default policy when no routing file exists is:

```json
{ "mode": "jev", "model": "jev-1.13.0" }
```

Open `/routing`, paste your TypeSafe/Jev API key into the masked field, and
press Enter to save. It is stored on the connected machine in
`~/.neta/routing-auth.json` (or `$NETA_DIR/routing-auth.json`), with owner-only
file permissions. The next delegation reads it immediately, with no restart.
The field can replace an existing key; Neta never sends the stored key back
to the UI. Saving does not make a paid validation request or change the routing
policy, and fixed routing still needs no key.

For headless use, `TYPESAFE_API_KEY` in the Neta Node environment remains
supported. A saved key takes precedence over that environment variable. The
UI shows which source is active. Never put credentials in `routing.json` or
workspace configuration. Credentials are excluded from diagnostic exports,
agent tools, transcripts, and routing decisions.

Jev receives the bounded task, mission objective, effort and eligible model
metadata. It does not receive the transcript, repository files, or other
provider credentials. This is a separate TypeSafe API request; existing model
subscriptions do not authenticate it. No paid request is made by the tests.

Only currently connected, allowed OpenCode models are considered. Jev candidates
must have models.dev metadata indicating tool calls and at least 16,384 context
tokens. All eligible models reach Jev; the router does not discard everything
except the five cheapest or interpret effort as a catalog score percentile.
Unknown benchmark scores stay unknown. Optional `maxReferencePrice` bounds the
sum of input and output USD per million tokens; models with unknown prices are
excluded when that ceiling is set.

Jev is required in this mode. Missing credentials, timeouts, errors, malformed
responses and explicit abstention refuse the launch. A valid highest-probability
model selection proceeds, even when overall classification confidence is low.
Confidence below 0.5 adds a visible warning to the saved routing decision and
creation result. It does not trigger a second request, fallback, or a different
model. Confidence describes classification certainty, not task success probability.
An explicit no-suitable-model answer remains a failure, reported with the effort,
candidate count, benchmark coverage and confidence.
The routing instructions treat missing benchmark scores as unknown and permit
Jev to choose among several adequate models; neither condition alone calls for
abstention.
Only an otherwise well-formed, non-abstaining Jev choice that disagrees with its
highest probability is classified once more with the identical request, within
the original 10-second deadline. A valid second answer proceeds with a warning;
a repeated mismatch refuses launch with bounded candidate/probability diagnostics.
No other invalid response, abstention, transport failure or HTTP error is retried.
HTTP 429/529 responses back off, honoring `Retry-After` when supplied; there is
no automatic retry that can duplicate a launch. There is no local-policy or
parent-model fallback. Choose a model explicitly, repair the connection, or
intentionally change the routing policy.

## Metadata and evidence

PublicAI supplies independent coding, agent and overall measurements, with
`reports=false`. Each score retains its own snapshot date, retrieval date,
benchmark ID, evidence coverage and agreement. Only exact callable ID matches
are used. Ambiguous benchmark variants stay unknown. The 100-row ranking cap
means missing models are not necessarily weak models.

Successful scope refreshes replace old scores, including newly missing or
unranked entries. Failed refreshes may retain earlier measurements with their
original provenance and a warning. Refreshes are coalesced and cached hourly;
per-source backoff prevents retries during rate limits. Reference metadata and
measurements older than 24 hours are excluded. Invalid cached data is ignored.
The cache is private, under `model-routing-catalog.json` in the Neta directory.

models.dev prices are reference API prices, not subscription billing, remaining
quotas, or latency. Zero listed price does not prove free capacity. Benchmarks
may use different reasoning settings or agent harnesses. These are selection
inputs, not guarantees. PublicAI public access does not establish an open-data
license; no PublicAI dataset is bundled or redistributed with Neta.

The TUI `/routing` command, creation tool results, `neta_status.agentDetails`,
and persisted agent records expose the selected model,
effort, policy, reason and warnings. Jev decisions additionally preserve the
candidate IDs, classifier model/confidence and selected metadata. Runtime
notifications may update the actual model; the original decision remains intact.
The full staffing plan is resolved before creating missions or worktrees.
Provider fallback remains the separate explicitly permitted `fallbackModels`
mechanism; routing never adds one automatically.

## Validation

Run `bun test test/agent-model.test.ts test/model-routing.test.ts test/tools-mission.test.ts
 test/tools-schemas.test.ts test/worker-model.test.ts` and `bun run typecheck`.
Fixtures cover both modes, explicit overrides, unavailable models, cache
replacement and expiration, rate limits, classifier failures and routing once
before launch or writer queue reservation. Adjustment tests cover both directions,
queued workers, preserved sessions, concurrent changes, failures and mission scope.
No provider API or key is used.

The public PublicAI endpoint returned HTTP 403 in the implementation environment;
its live response contract has not been revalidated here. Live Jev inference
also remains untested; validation uses fixtures rather than paid calls.

Sources: [PublicAI API](https://docs.publicai.io/publicai-documentation/publicai-index/api),
[TypeSafe API](https://docs.typesafe.ai/api), [models.dev](https://models.dev).

## Model preferences

Open `/routing`, then **F2 · Models**. Click a checkbox or press **Space/Enter**
to allow or exclude that model. **Select all (F2)** and **Deselect all (F3)**
apply to the whole list, including models hidden by search. Bulk changes save
together; a failed save leaves the displayed selections unchanged.

Use **Prefer (F4)** to prefer or unprefer the highlighted model. Select all keeps
existing Preferred choices. Prefer is a task-fit preference for Jev, not
permission to select an inadequate model. Fixed effort mappings stay exact.
The decision view records when the selected model was preferred by the user.

Preferences live in `$NETA_DIR/model-preferences.json` (normally
`~/.neta/model-preferences.json`) on the selected machine and apply across its
workspaces. Workspace routing configs cannot override them:

```json
{
  "version": 1,
  "models": {
    "meta/muse-spark-1.3-contributor": "prefer",
    "openai/gpt-6-astra": "exclude"
  }
}
```

An absent entry permits the model. Every model uses the same checkbox flow;
selecting one saves the preference immediately. Neta does not infer training
policies or require extra confirmation based on model names. Existing explicit
allow, prefer, and exclude choices remain in effect.

Exclusions apply to automatic routing, explicit delegation overrides, model
adjustments, and launch fallback choices. They do not interrupt an already
running conversation or retroactively revoke a fallback policy already handed
to a running provider. Changes apply to the next delegation/model adjustment.
The model cannot change preferences through the Neta MCP tools. A malformed
preferences file stops routing instead of silently losing the user's policy.

Meta's [pricing documentation](https://dev.meta.ai/docs/pricing-rate-limits)
lists Contributor at $0.10 input / $0.20 output per million tokens, versus
Standard at $1.25 / $4.25 (checked 2026-09-21). Neta continues to get reference
prices from models.dev; subscription usage may differ. Contributor pricing does
not create or duplicate PublicAI capability measurements.

## Connected model refresh

Opening model preferences in `/routing` and automatic routing both refresh the
connected model catalog through the workspace's existing OpenCode adapter.
New provider connections become eligible without resetting the conversation or
changing its selected model. Saved model preferences are preserved.

Press `F5` in model preferences to refresh or retry a failed refresh. A failed
refresh reports an error instead of silently routing against a cached list.
