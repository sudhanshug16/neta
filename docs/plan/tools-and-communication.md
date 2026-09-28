# Tools and communication

## Problem

Separate route, question, answer, progress, and completion protocols made ordinary
conversation depend on bookkeeping. A coordinator could answer a question
while the workspace leader still believed the answer was pending.

## Contract

Use the eleven tool names and role restrictions in
[How Neta works](../how-it-works.md#tools). The namespace remains `neta`.
Removed tools have no aliases.

The workspace leader sends a message to its coordinator. Leaders send messages to authorized
subordinates. Node supplies sender and native turn context, including the user's
original wording. Completed worker and mission-lead replies return to their parent.
Every completed coordinator reply enters the filter. Only the final visible
native assistant message is the reply; commentary, reasoning, and tool output
are not concatenated into it. Failed or interrupted turns remain labeled.

The filter is one internal native session per workspace copy. Its input includes
completed replies, incoming context, recent user/workspace-leader conversation, current
activity, and earlier presentations. It decides send, suppress, or defer for any
reply. Node chooses the destination, persists before sending, deduplicates retries,
and tracks delivery. Filter failures are visible and stop retrying after three
attempts. The workspace leader's responses do not trigger filtering.

Internal messages enter an active OpenCode execution at its next safe model step.
Node retains their native identities and records admission separately from context
inclusion. A reply with unread reports is kept in history while the agent resumes;
only its later final reply travels upward. The filter reads both native
conversations incrementally and rechecks them before deciding. Only the Workspace
leader may ask the user a question, in an ordinary final reply; managed native
question tools are unavailable and denied.

Mission lifecycle is open/closed. Close retains its disposition and dirty-worktree
and active-execution checks. Activity is Running / Not running from execution.
Writing turns acquire their slot before starting and release it after execution
stops. Queued messages and parent wakeups follow the same rule. Mission leads
inherit mission access; workers retain assigned access; the coordinator can
review and integrate.

## Clean cutover

The fresh filter store records its cutover timestamp. Earlier notifications are
not replayed. Retained mission and agent records are normalized on load; saved
missions, worktrees, artifacts, and native transcripts remain. Reset chats and
restart the Node/native client together to refresh their tool catalogs and
instructions. There is no parallel compatibility workflow.

## Verification

Use fake runtimes to verify exact role catalogs; rejection of removed names;
plain final replies including questions; all filter decisions and processing
failure; busy recipients, duplicate retries, restarts and uncertain delivery;
writer handoff and parent resume; assigned read-only access; active and dirty
closeout protection; preservation of saved work without notification replay.

Run affected tests, the full Bun suite, TypeScript, the Node bundle build, and
native integration verification. Export the native overlay before building it.
