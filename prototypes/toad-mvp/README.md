# Neta Toad client

A local terminal client for the existing Neta Node. The Node owns sessions,
providers, missions and permissions; Toad supplies the conversation renderer,
Markdown, tool cards, selection and composer. Closing a tab or quitting does
not cancel a Node turn.

From the repository root:

```sh
bun src/cli/main.ts tui
```

The launcher starts the local Node if needed and opens the current directory as
a workspace. It requires `uv`; the pinned Python/Toad environment is resolved
on first launch. After `bun run build`, `node dist/main.js tui` uses the staged
client under `dist/toad`.

For the isolated demo (no provider calls):

```sh
bun src/cli/main.ts tui --demo
```

When running Python directly, an existing local Node must already be running:

```sh
bun run --cwd prototypes/toad-mvp start --project /absolute/workspace/path
```

## Controls

Press **Ctrl-B**, release it, then press a command key. This follows Herdr's
one-shot prefix handling: Escape cancels prefix mode; an unknown command exits
without typing into the conversation; modifier-only keys such as Shift leave
prefix mode active. Pressing the prefix twice passes the
original control key to the focused widget. A visible `PREFIX` indicator appears
in the footer. `Ctrl-B ?` opens the full clickable command list.

| After Ctrl-B | Command |
| --- | --- |
| `?` | All commands |
| `w` | Switch workspace |
| `M` (or `m`) | Machines: add or connect an SSH host |
| `g` | Toggle spine / chat focus (replaces Ctrl-Space) |
| `h` / `l` | Focus spine / chat |
| `o` | Jump to workspace leader |
| `p` / `n` | Previous / next tab |
| `1`–`9` | Select tab |
| `X` (Shift-X) | Close tab; work continues |
| `r` | Reconnect conversation |
| `a` | Show / hide archived missions |
| `f` | Toggle all / needs-you filter |
| `e` | Export conversation to a private JSON file in the project directory |
| `c` | Prepare an unsent follow-up mission draft in the leader |
| `x` | Cancel the current reply |
| `s` | Settings |
| `q` | Quit client; Node work continues |

Tab / Enter navigate and activate spine controls; click a mission to expand its
agents. Enter sends a chat message, Shift-Enter inserts a newline. Existing
Ctrl-K, Ctrl-L, Ctrl-W, Ctrl-R, Ctrl-Q and F1 shortcuts remain available. Escape
outside prefix mode cancels the current reply. Archived conversations remain
read-only. Navigation preserves drafts, and follow-up drafts preserve existing
leader input.

To avoid a terminal/multiplexer conflict, choose a different prefix:

```sh
NETA_TUI_PREFIX=f12 bun src/cli/main.ts tui
```

Supported prefixes are `ctrl+a` through `ctrl+z`, and `f1` through `f24`.
The default is `ctrl+b`, matching Herdr. Configuration is read at startup.
The protocol and mode behavior were checked against the local Herdr source:
`src/config/model.rs` and `src/app/input/navigate.rs` (`handle_prefix_key`).

## Design

Checked against Paper's `neta` file, page **TUI · Concept exploration**:
**Revised — spine + agent tabs + native Pi**, **Ctrl+K workspace switcher**,
and **archived mission inspection**. Read through Paper MCP using JSX, computed
styles and screenshots on 2026-09-10.

The implementation uses its charcoal ground (`#111315`), amber accent
(`#E8B86D`), selected surface (`#30291E`), divider (`#363B40`) and text colors,
with a chronological spine, agent tabs, workspace/machine breadcrumb, centered
workspace switcher and read-only archive. Toad replaces the old Pi surface.
The terminal controls font and cell size; JetBrains Mono is the design font.
`NO_COLOR` is respected. Screenshots from UI tests are `design-live.svg`,
`design-switcher.svg`, and `design-archive.svg`.

## Verification

```sh
bun run --cwd prototypes/toad-mvp test
bun test test/toad-cli.test.ts test/cli-args.test.ts
bun run typecheck
bun run build
```

The tests cover actual Node round trips with a fake ACP provider, cumulative
stream replacements, idle peer messages, queued inbox delivery, cancellation,
reconnect, client-disconnect ownership, draft retention, workspace switching,
archive mutation rejection, export, and layout/composer visibility.

## Machines

Use **Ctrl-B, then M** (lowercase `m` also works), or click **Machines** in the
spine. Existing connections are loaded from `$NETA_DIR/client-hosts.json`
(default `~/.neta/client-hosts.json`).

To add one, enter its name, SSH destination (such as `runner@noscrubsblr`), and
remote Neta directory (default `~/.neta`), then choose **Save and connect**.
Enter an absolute remote project path to open that workspace, or when the
remote Node has no workspaces yet. Existing saved custom SSH config paths and
remote launchers are preserved and used.

The remote machine needs Neta installed and SSH key/config authentication set
up. On first connection to a host, connect using `ssh user@host` in a terminal
to handle host verification/authentication. The client uses batch SSH and shows
connection errors in the form; it never stores passwords or keys. A missing
Node descriptor triggers `neta node start --detach` on that machine. A stopped
Node with a stale descriptor must be restarted there before reconnecting.

Machine switches preserve client tabs and drafts, with session identities
scoped to each host. Quitting closes only the SSH tunnels, leaving Node work
running. Ctrl-R refreshes a disconnected remote transport.

## Current boundary

Attachments, model selection and provider-specific slash commands are not
implemented here. All history pages are loaded on attachment; very large
histories may take time. Tabs and drafts persist across navigation within the
app run; Node transcripts persist across app restarts. The existing rmux client
is still available separately.

Toad is pinned at `dd4f90e8b3700c3de80ad4b0eaa488ad0105e2c1` (0.6.20),
AGPL-3.0. No provider implementation is embedded in this client.

## Reset a workspace leader

Type `/reset` and press Enter, or press Ctrl-B followed by uppercase R.
This starts a fresh provider session for the current workspace leader, retaining
its saved transcript and the workspace's missions. Cancel an active leader reply
first. Lowercase r still reconnects the client transport. The slash menu contains
only `/reset`; Toad's internal commands are not exposed.

## Resume and layout

The normal TUI stores its selected machine, workspace, and conversation in
`$NETA_DIR/tui-view.json` (default `~/.neta/tui-view.json`). Reopening restores
that view, including a saved SSH machine. A replaced session falls back to the
workspace's current leader. Unavailable machines show a restore error and keep
the saved selection until you choose another view. Demo mode does not read or
write this file. Draft text is not persisted across app exits.

The shell follows the Paper layout: a quarter-width spine with compact machine
and filter rows, aligned mission branches, agent tabs above the conversation,
a thin composer separator, and the session folder/provider footer.
