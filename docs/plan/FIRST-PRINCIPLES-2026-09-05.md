# First-principles orchestration review — 2026-09-05

Status: independent proposals and synthesis, not an approved implementation
plan. Existing desktop completion and correctness work continue separately.
Confirmed code findings are in `ORCHESTRATION-REVIEW-2026-09-05.md`.

The user subsequently corrected the problem statement. The final section
records that correction and the independent reassessment; it supersedes the
earlier emphasis on a portfolio as the primary experience.

Operator sequencing decision: finish and verify the current app first. Record
the proposed direction changes now, but do not implement them or change the
current product architecture until a later discussion.

## Method

Three independent `gpt-6-astra` agents, each with a fresh context and high
reasoning effort, received the identical problem below. They were instructed
not to inspect code, files, product documents, other agents' messages, or the
web. They were not given Neta's architecture or the coordinating agent's
earlier recommendations. Their responses were collected before comparison.

> A person wants to accomplish substantial software work with AI assistants
> over days or weeks, sometimes across several projects. Assistants vary in
> capability, cost, speed, and reliability. Work may be ambiguous,
> interdependent, or concurrent; changes and external actions can conflict or
> have consequences. The person has limited time to supervise and needs
> confidence in outcomes, continuity through interruptions, and control of
> spending and authority. Design the dream system for this problem from first
> principles. You are not required to use multiple agents, a hierarchy,
> tasks/missions, chat, a canvas, or any existing architecture. Choose what
> earns its place.

Each was asked for success criteria, interaction and execution models, an
example, essential mechanisms and omissions, the strongest failure mode, and
falsifiable comparisons against one capable assistant. The reports below are
summaries of their conclusions, not private reasoning traces.

These are independent contexts, not independent sources of empirical evidence.
All three use the same model and the same prompt; correlated recommendations
are expected. Agreement is a hypothesis worth testing, not validation.

## Individual proposals

### A — Durable outcomes and evidence freshness

A proposes a portfolio of desired outcomes. Each holds the intended result,
acceptance evidence, uncertainty, next decision, authority, spending, and an
effort forecast. One coherent coordinator chooses replaceable execution:
models, deterministic tools, or independent workers.

Its distinctive emphasis is evidence tied to the exact code and environment
tested. Changed dependencies invalidate affected claims. Authorization for a
reviewed release candidate does not transfer to a materially changed candidate.
Human interruptions are also treated as a budget.

Proposed evaluation: equal-budget multiweek comparisons against a strong single
assistant with the same tools, memory, and background execution. Measure human
supervision, independently assessed results, rework, recovery, forecasts, and
unauthorized effects. A suggested 30% attention-saving threshold is a proposed
experimental target, not an observed benefit.

### B — Commitments and bounded spending increments

B proposes a persistent collaborator managing commitments, each with one
accountable execution process. This ownership need not mean a permanently
running model. Durable artifacts and decisions carry continuity; resumption
reconciles them with the current repository and external reality.

Its distinctive emphasis is externally enforced budgets: execution receives
bounded spending increments and must produce evidence of progress before
further allocation. Repeated activity without reduced uncertainty triggers a
pause or change of approach. The interface presents results, consequential
decisions, and materially changed forecasts.

Proposed evaluation: accepted outcomes per human attention hour, total cost,
elapsed time, defects, resume effort, unnecessary interruptions, missed
decisions, and budget violations. Suggested target: 25% less supervision with
equivalent quality and no higher cost or consequential-error rate.

### C — A working agreement and dependency-aware execution

C proposes outcomes, decisions, and inspectable activity/spending. Execution
defaults to one capable assistant; additional workers are justified by
separable work or useful independent evaluation.

Its distinctive emphasis is recognizing shared dependencies across projects:
repositories, services, environments, credentials, and external commitments.
Each increment identifies prerequisites, permitted changes, verification, and
recovery. Changed requirements or dependencies make affected conclusions
provisional again.

Proposed evaluation: accepted outcomes per dollar and per supervision minute,
escaped defects, interruption recovery, unauthorized actions, and calibration.
Remove persistence, verification, and routing individually to determine which
mechanisms actually contribute.

## Agreement and uncertainty

All three recommend:

- Durable outcomes and constraints as the central record; conversation remains
  an input and explanation surface.
- One accountable owner, with execution resources chosen as needed.
- Extra agents only when their benefit exceeds handoff and verification costs.
- Completion supported by relevant evidence, with unknowns kept explicit.
- Authority and spending enforced outside the model.
- Recovery that reconciles recorded understanding with current reality.
- An operator view focused on results, decisions, and material changes.

All three identify the same major failure mode: persisting a mistaken
interpretation and producing convincing evidence for the wrong outcome. Early
examples, runnable slices, and contact with real use matter more than adding
more internal agreement.

There was little substantive disagreement. Differences concern emphasis,
not validated competing architectures. This exercise therefore does not
establish the right scheduling algorithm, UI, model-routing policy, or number
of workers. Those require observation and experiments.

## Adversarial follow-up

After collecting A's original answer, A was separately asked to argue against
building an orchestration product. It received no other proposal.

Its counterargument: one capable assistant with durable notes, Git, CI, and
deployment controls may be better for mostly sequential work. An orchestration
layer can become another stale representation the person must maintain.
Organized activity is not proof of reliability.

The capability it would defend is automatic invalidation across ongoing work:
when assumptions, interfaces, environments, or approved candidates change,
identify downstream evidence and pending actions that are no longer valid.
Even this may be reproducible with ordinary tools; uniqueness is unproven.

It proposed a two-week, six-developer crossover pilot on related projects,
using equal model budgets and realistic interruptions, shared-interface
changes, and changes after approval. Its suggested kill criterion: no 25%
reduction in supervision at equal quality/safety, or equivalent benefits
available from at most a day of ordinary tooling. A small pilot would be a
screening exercise, not definitive statistical evidence.

## Mapping back to Neta — coordinator's synthesis

This section was written after the independent reviews. It was not supplied
to them.

Neta already has valuable foundations: machine-local durable ownership,
workspace continuity, bounded missions, isolation, explicit authority,
observable work, and deliberate closeout. Its manifesto already permits
direct work and delegation by judgment. Adaptive delegation is therefore a
principle to preserve, not a newly discovered missing feature.

The potential shift is the unit people organize around. A mission could be a
durable agreement about an outcome, with agents beneath it treated as
replaceable execution resources. This would strengthen, rather than require
discarding, the existing mission model.

The largest unproven opportunities are:

1. A compact mission agreement connecting outcome, constraints, assumptions,
   budget, authority, and acceptance evidence.
2. Evidence linked to the revision and environment it establishes, with
   invalidation when relevant dependencies change.
3. A decision-oriented view complementing the spine and exact conversations.
4. Measured routing and selective review, evaluated against single-assistant
   execution under the same budget.

Retain the spine as history and orientation while testing whether the primary
view should foreground results and decisions. Do not remove the canvas or
introduce a new dashboard merely because three models recommended a similar
abstraction.

The strongest product hypothesis is: Neta preserves the relationship between
intent, authorized action, and trustworthy evidence across time and concurrent
work, reducing the person's management burden. An agent roster alone is a weak
reason to build it.

## Smallest useful next experiment

Prototype a mission agreement and evidence record over the existing system.
Use one executor by default. Compare it with the same executor using structured
project notes, then separately enable extra workers. Keep spending and task
difficulty comparable. Include a changed requirement, a shared dependency, and
an interrupted session.

Measure accepted results, supervision minutes, total cost including review and
retries, rework, missed decisions, and stale evidence. Record the baseline
before adding more orchestration. Decide whether to expand the product from
these results; do not implement the full dream design on model consensus alone.

## User correction: one conversation and shared working memory

The user explained that the central burden is hundreds of related chats across
projects and subprojects. They personally reconstruct and relay context between
them. They want one conversational front door, automatic reuse of relevant prior
understanding, concurrent agents, and a coordinator that remains available while
substantial work runs. Letting a model decide whether to delegate can occupy the
conversation with implementation and varies by model.

The original independent prompt did not state these requirements explicitly.
Its emphasis on supervision and sustained work was incomplete. Recommendations
derived from it must not be treated as a rebuttal of the corrected problem.

### Independent reassessment

A and B each received the corrected requirements without the other's answer,
code, or existing Neta design. Both changed their emphasis:

- Shared understanding across conversations is the primary service.
- One interface does not require one model session or one execution queue.
- Conversation needs reserved capacity and bounded work. Substantial research,
  implementation, and verification execute outside that lane, enforced by the
  runtime rather than delegation instructions alone.
- Source conversations and artifacts remain a provenance archive. A separate
  maintained representation distinguishes decisions, observations, hypotheses,
  project relationships, open work, and superseded statements.
- Workers receive relevant, permitted context automatically. Retrieval should
  use known relationships as well as semantic similarity, without loading all
  chats into every prompt.
- Corrections propagate to affected workers and invalidate obsolete results.
- Context-sharing permissions apply across projects; one front door does not
  imply every worker may access every source.

A emphasizes that the useful execution boundary is whether work monopolizes
the conversational lane, not whether the leader does any work at all. It also
distinguishes accepting a cancellation from confirming all workers have stopped.

B emphasizes that the coordinator must be neither the sole memory writer nor
the execution bottleneck. It distinguishes responsiveness from an immediate,
correct answer to a question requiring investigation.

Both warn that bad shared memory can spread errors farther than disconnected
chats. Sources, scope, correction propagation, and an answer to “Why are you
assuming that?” are core mechanisms, not optional transparency.

### Revised synthesis and open questions

The proposed promise becomes: tell Neta once; it carries relevant understanding
into other work, keeps execution moving, and remains available for new direction.
The single chat is primary. Mission and evidence records support execution;
the user should not have to navigate them to relay context.

The strongest unresolved scope question is whether this means one conversation
across all projects and machines or one per project. A global front door would
change the current manifesto's explicit workspace-local leader boundary. No
global-leader implementation or manifesto change has been made based on this
discussion.

Questions presented to the user:

1. One conversation across all projects, or one per project?
2. When related decisions conflict, should the latest explicit, applicable
   decision normally govern, or should the system ask first?
3. What concrete recent case required repeating context from another chat?

Additional design questions from the reviews concern which project boundaries
permit automatic sharing and what should stop immediately after a correction.

Evaluation must now include repeated explanations avoided, correct reuse of
prior decisions, inappropriate cross-project transfers, correction propagation,
and conversational response latency under concurrent execution. Outcome quality,
cost, and supervision still matter, but are insufficient on their own.

## User requirement: at-a-glance catch-up

The user reported that lengthy asynchronous updates themselves cause context
switching: returning after roughly nineteen minutes required rereading thousands
of words and navigating intervening discussion. A single conversation does not
solve this if catching up still requires reading the whole stream.

Glance now implements this recap/catch-up capability. Each ordinary
reader-directed assistant response becomes a separate source-linked card;
internal lifecycle prompts, tools, thoughts, and agent-to-agent traffic are
excluded. The recap should foreground consequential changes since the person's last
visit: what changed, what requires their attention, and what remains open.
It should distinguish proposed direction changes from decisions actually made,
and completed implementation from pending work. Detailed evidence and source
messages should remain reachable without appearing in the default recap.

“Last caught up” is explicit: opening a source does not review it. Cards and
the review cursor are durable per workspace. Apple Foundation Models creates
bounded, hierarchical on-device summaries when available; otherwise the UI
labels a verbatim excerpt as an excerpt and never sends a paid model request.
Oversized saved sources are labeled as truncated and are not presented as
complete summaries.

### Recap format clarification

The user prefers a sequence of scrollable recap cards added at the bottom of
the reader chat (their preferred name), recapping agent messages addressed to them. Do not collapse the entire
catch-up into a single overcompressed “at a glance” summary. Preserve enough
separation to read through the updates without reconstructing the full stream.

Generation must be automatic from ordinary user-directed assistant responses.
It must not depend on an agent choosing a special recap tool or remembering to
call a user-message tool: different leader models may simply return normal text.
This is a client/runtime capability, not a required agent behavior. One closed
reader-directed response is one chronological card, and review is always an
explicit action.
