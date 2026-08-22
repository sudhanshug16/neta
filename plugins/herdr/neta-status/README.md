# Neta Status Plugin for Herdr

A Herdr plugin that monitors live Neta sessions and displays their status in a persistent terminal pane.

## Features

- **Live session monitoring**: Displays status of all active Neta sessions
- **Persistent pane**: Tab-based pane that can be kept open during development
- **Real-time updates**: Refreshes status ~1 second intervals
- **Socket-based communication**: Connects directly to session control planes using Unix sockets

## Installation

The canonical plugin source is `plugins/herdr/neta-status/` in this repository.
From a checkout or installed package, link it with:

```bash
herdr plugin link <neta-repo-or-installed-package>/plugins/herdr/neta-status
```

## Usage

### Opening the monitor pane

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

## Limitations

### Herdr plugin v1 constraints

- **Authoritative monitoring**: The monitor pane works for normal and muxed Neta sessions
- **Per-worker details**: Native per-worker Agent sidebar rows are not available in Herdr plugin v1
  - Use `neta inspect <worker-id>` in a terminal for detailed worker logs and status
  - Full worker state (model, task, timing) requires direct Neta control plane access

### Runtime

- **Socket availability**: Sessions must have accessible Unix sockets; adjust `ulimit -n` if needed
- **Token security**: Session tokens are never printed to output
- **Startup hook**: The monitor pane auto-opens on Herdr startup for consistency

## Testing

Run the test suite:

```bash
python3 tests/test_monitor.py
```

For single-run validation against the real current session:

```bash
python3 scripts/monitor.py --once
```

## Implementation notes

- Monitor uses Python 3 stdlib only (no external dependencies)
- Connects to Neta session sockets using the leader channel protocol
- Respects NETA_DIR environment variable and default ~/.neta location
- Handles socket errors, malformed JSON, and missing registry files gracefully
- Does not persist checkpoint data; relies on active session registry
