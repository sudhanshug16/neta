# Neta implementation plans

The current product contract is [MANIFESTO.md](../../MANIFESTO.md).
The current architecture and exact tool lists are in
[How Neta works](../how-it-works.md).

## Current work

- [Tools and communication simplification](tools-and-communication.md): the
  clean break to ordinary messages, final replies, and a filter with full judgment.
- [Direct OpenCode control](opencode-direct-control.md): native sessions and
  their execution contract. The simplification plan supersedes older tool names
  and reporting protocols in this document.
- [OpenCode integration](../opencode.md): building and verifying the native client.

## Historical plans

All other documents in this directory record earlier designs and implementation
work. They are historical references, not active requirements. In particular,
numbered workstreams and the earlier conversation/attention plan describe APIs,
modes, statuses, and reporting tools that have since been removed. Do not
reintroduce them when following an old task or example.

Development follows [AGENTS.md](../../AGENTS.md). The manifesto takes precedence
where design documents disagree. Commit only when the user requests it.
