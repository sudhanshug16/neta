# Existing application reuse screen

Assessed 2026-09-10 from public primary repository documentation and bounded source reads. This evaluates complete applications, independently of implementation language. No application was built or connected to a paid provider. Conclusions about adaptation effort are engineering inferences, not measured prototype results.

Neta needs a client of its existing Node-owned conversations. An ACP agent **server** is not an ACP chat **host**; a terminal/session manager is neither. Reusing a finished application's widgets through private implementation modules is a fork, even when the underlying UI toolkit is public.

| Application | What it actually supplies | Reuse verdict |
| --- | --- | --- |
| Crush | Complete coding chat with composer, attachments, completions, conversation UI and sidebar; its own agent/provider model. | **Conditional fallback fork.** Most plausible finished chat among this subset, but no documented generic ACP-host configuration or public chat/sidebar extension API was established. |
| Kagan (current repository landing page) | OpenCode plugin adding a supervised kanban board; tasks are OpenCode sessions in worktrees. | **Eliminate as a standalone Neta chat base.** Potential reference for extending OpenCode, not a ready independent ACP host. Historical standalone versions need separate evaluation. |
| agent-deck | Bubble Tea application organizing agent terminals through tmux, with session groups, status and worktree management. | **Eliminate.** Reuses existing agent terminal UIs rather than rendering Neta's exact ACP conversation. Replacing that core would remove its principal reuse benefit. |
| hcom | Agent messaging and orchestration through hooks, SQLite and real terminals, with a dashboard. | **Eliminate.** The dashboard is not a reusable ACP conversation host. Its agent lifecycle/message delivery overlaps Neta's engine. |
| WeeChat | Extensible messaging application with buffers, input, bars and a documented plugin API. | **Eliminate for this goal.** Genuine extension points, but ACP blocks, permission requests, tool cards and agent controls would still require substantial new conversation UX. |

## Concrete source evidence

**Crush:** [`internal/ui/model/ui.go`](https://raw.githubusercontent.com/charmbracelet/crush/main/internal/ui/model/ui.go) constructs textarea, chat, completion, attachment and dialog objects, stores sidebar state, and imports Crush's internal session, permission, message and workspace modules. [`Workspace`](https://raw.githubusercontent.com/charmbracelet/crush/main/internal/workspace/workspace.go) is a real adapter seam: existing implementations wrap a local app or an HTTP client. However, its contract spans sessions, agent execution, shell commands, queues, permissions, model initialization, configuration, LSP, MCP, skills and subscription/shutdown. A Neta-backed implementation plus UI changes could retain much of the visual shell, but this is a substantial maintained fork, not plugging an ACP command into a stock host. The [README](https://github.com/charmbracelet/crush) describes direct model providers and MCP extension; that does not establish ACP-client support. Sidebar reuse is source reuse, not a documented third-party slot.

**Kagan:** The [pinned README](https://github.com/kagan-sh/kagan/blob/a6ec11c405f066988e910cc02179b5fc6147cedc/README.md) describes an OpenCode plugin requiring OpenCode 1.17.13 or newer. Its [pinned package metadata](https://github.com/kagan-sh/kagan/blob/a6ec11c405f066988e910cc02179b5fc6147cedc/package.json) exports `./tui` and `./server`, depends on `@opencode-ai/plugin` 1.17.20, and declares OpenTUI/Solid peers. It supplies board/task transitions and review/merge gates. Fresh reads of that exact revision resolve a misleading older browser-cached commit-history page showing standalone Python/ACP development: today's plugin is a different generation. It is useful proof of OpenCode's TUI extensibility, not a stock independent ACP host.

**agent-deck:** Its [README](https://raw.githubusercontent.com/asheshgoplani/agent-deck/main/README.md) explicitly describes tmux integration and status polling, and identifies Bubble Tea plus tmux as its foundation. Terminal attachment and screen observation do not supply Neta's structured conversation renderer. A generic custom command could launch a Neta CLI inside it, but that still leaves Neta responsible for chat UX.

**hcom:** Its [README](https://raw.githubusercontent.com/aannoo/hcom/main/README.md) describes hooks recording activity and delivering messages through SQLite, with each agent running in a real terminal. Existing terminal UX belongs to the wrapped tools. Cross-agent messaging/dashboard facilities do not establish ACP-host or reusable sidebar capabilities.

**WeeChat:** The [official plugin API](https://weechat.org/files/doc/stable/weechat_plugin_api.en.html) includes buffer and bar creation, command hooks and file-descriptor hooks. Thus a Neta transport and sidebar can be implemented as an extension; the missing piece is finished coding-agent conversation rendering. This saves the messaging shell but not the specialized UI the user wants to avoid rebuilding.

## Reproducibility limit

After sandbox DNS failed, approved read-only public network requests verified Kagan at `a6ec11c405f066988e910cc02179b5fc6147cedc` (README and package metadata) and Crush at `bb33cee2d32780cb5afa31fc3aa815302b9f7443` ([workspace interface](https://github.com/charmbracelet/crush/blob/bb33cee2d32780cb5afa31fc3aa815302b9f7443/internal/workspace/workspace.go), [UI model](https://github.com/charmbracelet/crush/blob/bb33cee2d32780cb5afa31fc3aa815302b9f7443/internal/ui/model/ui.go)). The Crush seam described above is confirmed at that exact revision. Other application documentation remains a moving source. No checkout/build or runtime interaction was performed.

None of these five currently earns a direct-adoption recommendation. Keep Crush only as a finished-UI fork fallback while the dedicated ACP chat hosts are evaluated separately.
