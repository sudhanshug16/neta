# Chat UI reuse decision

Updated 2026-09-10. This closes the interrupted awesome-tuis evaluation from
the "Finish Neta desktop app" Codex task. The objective is to reuse a finished
agent chat surface beside Neta's spine, regardless of language, while the
remote Neta Node retains ownership of agents and their exact conversations.

## Recommendation

Evaluate adapting Toad first. It is the closest semantic match: an existing
ACP client with an editor, streamed Markdown, tools, permissions and session
UI. This is a candidate for an integration prototype, not an adoption decision.
Its current application owns provider startup and depends on application-wide
services; its Conversation widget is not a documented standalone component.

Concrete example: selecting an already-running mission must display its
existing Neta conversation. Starting another provider from Toad would create
the wrong owner and potentially the wrong conversation. A thin bridge process
could instead expose a selected Node conversation as an ACP endpoint. Whether
Toad can use that bridge without extensive lifecycle changes remains unproven.

| Candidate | Reuse value | Remaining cost | Decision |
| --- | --- | --- | --- |
| Toad | Finished ACP chat application | Node attachment, spine layout, selection containment, history and app coupling | First integration candidate |
| OpenCode | Finished chat and separate HTTP server | Its client speaks OpenCode's server API; Neta needs an adapter or maintained UI fork | Secondary candidate |
| Crush | Finished agent chat and a Workspace interface | Broad backend contract covering much more than conversation rendering | Fork fallback |
| Textual | Editor, Markdown, layout, scroll and selection widgets | Neta still builds agent chat semantics | Toolkit fallback |
| OpenTUI | Good editor/rendering primitives | Chat semantics, history windowing, runtime/native packaging | Toolkit fallback |
| Terminal agent managers | Session navigation and terminal attachment | Do not supply a structured client of Neta conversations | No fit for this objective |
| General messaging clients | Mature messaging shells | Agent tools, permission UX and ACP controls still need implementation | Lower reuse value than Toad |

This screens applications as well as libraries. It does not claim every entry
in awesome-tuis was built or source-audited. The detailed application screen
covers Crush, Kagan, agent-deck, hcom and WeeChat. OpenCode's documented server
split establishes an integration boundary, not compatibility with Neta.

## What was actually verified

The existing probes were rerun on noscrubsblr during this continuation before
the operator moved work locally:

- Textual's probe exited successfully. Cross-pane dragging included sidebar
  text. Disabling selection on sidebar content did not fix that case; a public
  selection-text override excluded copied text but did not prove highlight
  containment. Streaming, manual reading position and multiline input worked
  in the tested cases.
- OpenTUI's probe passed 1 test with 9 assertions. Cross-pane selection also
  included sidebar text by default. Editing, incomplete Markdown updates and
  preserving manual scroll position passed their bounded checks.
- Neither probe proved end-to-end SSH clipboard delivery, long-history
  virtualization, or finished application integration. Successful probe exits
  include assertions that reproduce defects; they are not acceptance passes.

The three companion reports are preserved from the remote investigation.
Their temporary paths and test-file references refer to that host. Test
fixtures and dependencies were not copied locally, and no local runtime test
has been claimed. No production implementation or dependency was imported.

## Smallest useful next prototype

Use a fake Node conversation and Toad's real UI. Prove that a selected existing
session can be attached, streamed, cancelled, disconnected and reopened with
the same identity, without starting a provider. Include a sibling spine pane,
drag selection across its boundary, and multiline input. Then test real
terminal clipboard transport separately. Keep the prototype isolated from
the production client and preserve upstream license/provenance.

If attachment requires replacing most of Toad's conversation behavior, its
reuse advantage has failed the test. Only then compare the narrower cost of
owning the chat composition on Textual or OpenTUI. Language alone is not a
reason to retain a separate terminal client or choose a replacement.

## Sources

- [Toad documentation](https://github.com/batrachianai/toad): ACP support,
  existing UI behavior and AGPL/commercial licensing.
- [OpenCode server API](https://opencode.ai/docs/server/): client/server split.
- [Application source screen](APPS.md): bounded source evidence and limitations.
- [Textual and Toad evidence](TEXTUAL.md): pinned revisions and probe findings.
- [OpenTUI evidence](OPENTUI.md): pinned runtime and probe findings.
