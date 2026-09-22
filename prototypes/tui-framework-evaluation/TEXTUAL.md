# Textual and Toad evaluation

Verdict: Textual supplies mature reusable terminal mechanics, not a complete chat. Toad supplies a complete ACP chat application, but its Conversation is coupled to its application and provider lifecycle. Neither is demonstrated as a drop-in Neta chat pane. No provider was launched; no production code or dependency was changed.

Inspected source snapshots:
- [Textual 8.2.8](https://github.com/Textualize/textual/tree/06dbeef4bb70fb718236aa418ed658ef4667a126), MIT license.
- [Toad](https://github.com/batrachianai/toad/tree/dd4f90e8b3700c3de80ad4b0eaa488ad0105e2c1), AGPLv3 LICENSE; COMMERCIAL_LICENSE.md offers a commercial license. These are repository facts, not legal conclusions. Its pyproject pins Textual 8.2.7 and requires Python >=3.14. Toad itself was source-inspected, not run.

## Executed framework probe

Run from repository root:

```
/private/tmp/neta-textual-eval/venv/bin/python prototypes/tui-framework-evaluation/textual_probe.py
```

The temporary venv contains Textual installed from the exact inspected source. The headless test uses the real Textual Pilot mouse input and widgets. Assertions intentionally capture negative results too; successful exit does not mean every requirement passed.

- Drag starting in chat and ending in a sibling spine selects text from both. Textual uses the common ancestor of endpoints, not a pane selection namespace.
- Setting ALLOW_SELECT=False on the spine text still includes that endpoint's text. `selection.py::_apply_content_selections` adds endpoint widgets without checking this flag; `Screen.get_selected_text` does not recheck it. No `selection_container` API was found.
- Minimal public `get_selection` override returning None on the spine content excludes its copied text, but spine remains in `screen.selections`. This does not prove highlight containment; a true selection namespace still needs policy/customization or upstream repair. No screenshot assertion was made.
- `App.copy_to_clipboard("SSH clipboard ✓")` writes exactly `ESC ]52;c;U1NIIGNsaXBib2FyZCDinJM= BEL` to the driver. This proves OSC52 emission, not receipt by a real terminal or tmux/SSH passthrough. Textual's own method doc explicitly excludes macOS Terminal.
- Markdown.get_stream writes 60 paragraphs and a VerticalScroll anchor follows the bottom (scroll_y=104). Releasing anchor and scrolling home preserves scroll_y=0 on append. This proves explicit anchor controls, not every mouse-wheel/autofollow edge case.
- TextArea accepts multiline keyboard input `hi\nx`.

Framework widgets solve markdown stream parsing/rendering, scrollbars/scroll control, multiline editing, layout and OSC52 encoding. Still custom: Neta spine; Node protocol adapter; transcript replay/pagination; selection containment policy; permissions/tool/control mappings; keybindings and product polish. The test is not a polished chat prototype or virtualization benchmark.

## Toad app reuse boundary

[Conversation source](https://github.com/batrachianai/toad/blob/dd4f90e8b3700c3de80ad4b0eaa488ad0105e2c1/src/toad/widgets/conversation.py) composes SessionsTabs, Window, ContentsGrid, Contents, Flash and Prompt. `on_mount` directly accesses app.settings_changed_signal and app.settings, initializes shell/history, constructs `toad.acp.agent.Agent`, then starts it. Other methods use app telemetry, notifications, modal screens and settings. This is application-owned chat, not a documented transport-injected reusable Chat widget.

[AgentResponse](https://github.com/batrachianai/toad/blob/dd4f90e8b3700c3de80ad4b0eaa488ad0105e2c1/src/toad/widgets/agent_response.py) streams using Textual MarkdownStream. Conversation already has responses/thoughts, tool calls, permission handling, slash commands, tabs and input: meaningful existing app behavior worth reusing only if maintaining an adapted application is acceptable.

[ACP Agent](https://github.com/batrachianai/toad/blob/dd4f90e8b3700c3de80ad4b0eaa488ad0105e2c1/src/toad/acp/agent.py) uses configured run_command via asyncio.create_subprocess_shell with stdio pipes, owns process/session state, and handles ACP notifications and file/terminal requests. An SSH command is structurally conceivable, but untested and not a Neta attachment seam: Neta's Node must remain session/process owner. A Node-to-ACP bridge or replacement Agent adapter would need explicit design; launching a second provider would violate the requested architecture.

Conversation `check_prune/prune_window` removes older widget children above configurable height marks. That is bounded pruning, not proof of a virtualized transcript with history rematerialization. Textual Markdown also is not established here as a fully virtualized transcript.

Practical choice: Textual if building the Neta-specific chat composition is acceptable; Toad if an app adaptation/fork with coupled lifecycle changes is acceptable. Neither can honestly be recommended as "only add spine and connect existing ACP" based on this evidence.
