# Neta Agents Plugin for Herdr

A personal Herdr 0.8.2 plugin that reports live Neta leaders and workers in
Herdr's Agents sidebar. The terminal monitor remains available as optional
drill-down.

## Features

- **Worker rows**: Creates one plugin-owned, pane-backed Agent row per live Neta worker
- **Leader enrichment**: Adds Neta metadata only to an exactly matched native leader pane
- **Lifecycle mapping**: Reports working, queued/idle, blocked, and unknown states
- **Optional monitor**: Keeps the existing formatted terminal status view as drill-down

## Installation

The canonical plugin source is `plugins/herdr/neta-status/` in this repository.
From a checkout or installed package, link it with:

```bash
herdr plugin link <neta-repo-or-installed-package>/plugins/herdr/neta-status
```

## Agents sidebar

Herdr runs a one-shot startup hook. The hook starts one lock-protected reporter,
which polls the owner-only Neta live registry and requests structured state over
each session's authenticated Unix socket. Starting/running/waiting workers show
as working, queued workers as idle with queued metadata, and blocked workers as
blocked with their pending question. Terminal workers are released, have their
plugin metadata cleared, and then have only their plugin-owned proxy pane closed.

The reporter retains an existing worker row as unknown across a transient socket
failure while the registry still proves the exact manager PID and process start
identity. It removes the row only when that registry disappears or the exact
process identity no longer matches.

Leader panes are never claimed. The plugin adds display-only Neta metadata when
canonical cwd, manager PID membership, process start identity, and the native
agent label all match exactly. If that evidence is unavailable or ambiguous,
the leader remains unchanged rather than being guessed.

## Optional monitor

Use the `open-monitor` action:

```bash
# Via Herdr CLI
herdr plugin action invoke open-monitor --plugin personal.neta-status

# Via keybinding (configure in settings)
# See Herdr docs for adding keybindings to personal.neta-status.open-monitor
```

Or access the action through Herdr's command palette / workspace actions menu.

### Monitor display

The monitor shows each live Neta session with:
- **Session ID**: Unique identifier for the session
- **State**: Worker status (running, queued, blocked, idle)
- **Working directory**: Session cwd
- **Leader**: The backend managing the session (e.g., "claude", "codex")

Example output:
```
Neta Monitor
------------------------------------------------------------
  25027-de1c17: running queued (cwd: /path/to/repo, leader: codex)
  58657-c2c086: idle (cwd: /path/to/other, leader: claude)
------------------------------------------------------------
Press Ctrl+C to exit. Last update: 14:23:45
```

### Environment variables

- `NETA_DIR`: Override the default Neta session directory (default: `~/.neta`)

## Verified Herdr 0.8.2 constraints

- `agent.view.set` cannot create virtual Agent rows; sidebar rows are pane-backed.
  Worker rows therefore use inert plugin-owned terminal panes.
- Native leader integrations retain lifecycle and resumable-session authority.
  Neta leader identity is carried as guarded display metadata/tokens, not a
  competing `report-agent` or `report-agent-session` source.
- Startup hooks are one-shot and unsupervised. The hook detaches the reporter;
  an owner-only lock prevents duplicates, and the reporter exits when Herdr's
  pane API socket disappears.

### Runtime

- **Socket availability**: Sessions must have accessible authenticated Unix sockets
- **Token security**: Session tokens are never printed to output
- **Leader ambiguity**: A leader row stays native and unenriched when the exact
  manager process cannot be proven inside one pane

## Testing

Run the test suite:

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
```

For single-run validation against the real current session:

```bash
python3 scripts/monitor.py --once
```

## Implementation notes

- Reporter and monitor use Python 3 stdlib only (no external dependencies)
- Reporter uses the structured authenticated `actor-snapshot` channel request;
  existing human-formatted `workers` and `status` output is unchanged
- Respects NETA_DIR environment variable and default ~/.neta location
- Persists only plugin pane ownership and per-source sequence counters under
  `HERDR_PLUGIN_STATE_DIR`, with owner-only file permissions
- Does not persist checkpoint data; relies on active session registry
