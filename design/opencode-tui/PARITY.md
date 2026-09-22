# Paper / terminal parity checklist

Reference: Paper page `TUI · Concept exploration`, five OpenCode screens. Reviewed 2026-09-18. The implementation uses the production Neta shell and native OpenCode controls.

| Element | Shipped treatment | Verification |
| --- | --- | --- |
| Workspace selector | `[ workspace ▾  ^K ]` at the left edge; no separate wordmark | Native colored capture |
| Leader jump | `[ Jump to leader ]`, separate activity counts | E2E delimiter assertion |
| Machine/filter | `SPINE` plus right-aligned `[ machine ▾ ]`; `CONNECTED` plus `[ all states ▾ ]` | Populated capture; long-host regression |
| Shell/chat surfaces | `#111315` / `#171717` | Exact theme and emitted RGB assertions |
| Text/dividers | `#E5E7EB`, `#A5ADB3`, `#363B40` | Theme tests and capture |
| Amber/selection | `#E8B86D`, selected row `#322A1E`, active tab `#1B1E21` with amber underline | Separate chat/dialog tests and capture |
| User/tool/composer | `#303030`, `#252525`, `#232323`; amber composer border | Theme tests and real chat capture |
| Tabs | Mission number, actual state, close control, `[ tabs ▾ ]`; fixed slots | E2E and narrow/wide review |
| Spine | Fixed timestamp/branch/title lanes; `├` siblings and `└` final child; selected row fills its lane | E2E column and connector assertions |
| Data | Real running/attention counts; singular `agent`; queued, blocked, merged-closeout and archived states kept distinct | Unit tests and populated fixture |
| Breadcrumb | Workspace / machine / mission / actor; role, state, mode, runtime below | Populated native capture |
| Archive | Eight newest missions remain visible including archives; older history behind disclosure; closure date, disposition and recorded session end; saved blocks, no composer or provider restart | Snapshot, rendered sidebar, and archive tests |
| Status indicators | Native one-cell loader for active execution; distinct blocked, failed, complete, archived, idle, queued, interrupted and closeout marks; text labels retained | Rendered state transitions, light/dark, animations disabled, native E2E |
| Workspace picker | Name and right-aligned activity; path below; machine context and keyboard hints | Native dialog capture |
| Reset | Two separate options with complete descriptions; preservation note and confirmation hint | Native dialog capture |
| Details pane | Available manually; does not open automatically alongside the Neta spine | Wide native capture |
| Commands | Native suggested/session groups; search `neta` for workspace, machine, tab, archive, reset and delivery commands | Default and filtered palette captures |
| Compact terminal | Sidebar and leader-jump button hidden below 95 columns; commands and native chat remain accessible | 80×32 E2E |

## Deliberate adaptations

- A terminal uses whole character cells; fonts and glyph metrics belong to the terminal. Captures are rendered from ANSI cells using Menlo, not claimed as Ghostty screenshots or pixel-identical Paper exports.
- OpenCode keeps its transcript rendering, streaming/tool interactions, slash completion, provider/model pickers and command palette. Paper's transcript content is illustrative; no duplicate chat renderer was built to imitate a static screenshot.
- Native pickers keep filtering and keyboard selection. Their row descriptions are expanded where necessary instead of clipping the design copy.
- Native dialogs share a gray border, amber focus, and whole-row selection. The workspace reference now uses that same border treatment.
- Archive dates come from recorded closure/end timestamps. Missing timestamps stay omitted; fixture dates and activity counts are illustrative.
- The Paper labels `WAITING` and `COMPLETED` were corrected where they implied nonexistent or misleading registry states. Queued work and merged work awaiting closeout stay visibly distinct.
- An explicit custom OpenCode theme remains an override; an unconfigured Neta session now defaults to the Neta theme.

The former monochrome, nearly empty fixture was insufficient evidence. The populated full-color captures and targeted assertions supersede that review. Test success proves the listed contracts, not all possible terminals, content lengths, or custom themes.
