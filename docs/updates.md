# Catching up on leader updates

Open `/updates`, click **Updates** in the spine, or choose **Updates** beside
**Chat** in the workspace leader's conversation. It shows the same OpenCode
session and opens at the latest reply at the bottom.

Updates shows full, formatted leader replies, including replies to automatic
mission reports. Thinking, tool output and intermediate tool steps stay in Chat.
Partial replies from interrupted or failed steps are labelled **Incomplete**.
Headings, lists, code and tables retain their formatting. There are no collapsed
previews, selection arrows or per-message Reply controls.

- Scroll normally or use Page Up/Page Down.
- Press `a` with the feed focused, or click **Mark all read**, to mark all current
  updates read, including older pages that have not been loaded.
- Press `i` to focus the normal composer. Successfully sending from Updates
  marks all current updates read. Failed sends retain the draft and unread state.
- **All** includes read replies. **Show in chat** opens an update's source.
- Escape returns to Chat when the feed has focus; the composer retains
  OpenCode's normal Escape behavior.

New replies remain unread and appear behind a **new update** control. They do
not move your reading position. Marking read or sending keeps visible messages
in place until the list is refreshed or reopened. Reading or replying never
closes a mission or grants permission for an action.

The transcript remains authoritative on the owning machine. Read markers and
the read-through timestamp use OpenCode's local TUI storage, keyed by host and
Neta session. They survive client restarts and do not leak across chat resets.
They are device-local preferences. No extra model call or MCP tool is involved.

History loads in native OpenCode pages. A `+` next to the unread count means
older history could contain unread replies. **Load older updates** retrieves
more; marking all read covers those older replies without fetching them.

Implementation: `neta-opencode-v2/packages/tui/src/neta/updates*.ts*`, with small
integration points in the native session route and composer. Fake-server tests
cover formatting, scrolling, bulk read, new arrivals, failed sends, composer
replies and persistence at 100 and 160 columns without real provider calls.
