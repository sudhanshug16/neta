#!/usr/bin/env python3
"""Monitor live Neta sessions and display status."""

import json
import os
import socket
import stat
import subprocess
import sys
import time
from argparse import ArgumentParser
from contextlib import contextmanager
from pathlib import Path


# 1 MiB response cap
MAX_RESPONSE_SIZE = 1024 * 1024

# Socket deadline in seconds
SOCKET_TIMEOUT_TOTAL = 2.0


def escape_header_field(value: str | None) -> str:
    """Escape untrusted registry header field for safe display."""
    if value is None:
        return "?"
    # Replace control characters and newlines
    s = str(value)
    return "".join(c if ord(c) >= 32 and c != "\x7f" else "?" for c in s)


def get_neta_dir() -> Path:
    """Get Neta sessions directory, respecting NETA_DIR environment variable."""
    neta_dir = os.environ.get("NETA_DIR")
    if neta_dir:
        return Path(neta_dir)
    home = Path.home()
    return home / ".neta"


def is_live_pid(pid: int) -> bool:
    """Check if a process ID corresponds to a live process."""
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (OSError, TypeError):
        return False


def validate_registry_record(session: dict, session_file: Path) -> bool:
    """Strictly validate a registry record file and content."""
    # File checks
    try:
        # Use lstat to detect symlinks (stat follows symlinks)
        file_stat = session_file.lstat()
    except OSError:
        return False

    # Must be regular file, not symlink
    if not stat.S_ISREG(file_stat.st_mode):
        return False

    # Must be owned by current uid
    current_uid = os.getuid()
    if file_stat.st_uid != current_uid:
        return False

    # Must not be group or other accessible
    if file_stat.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        return False

    # Content checks
    if not isinstance(session, dict):
        return False

    # Required string fields
    socket_path = session.get("socket")
    token = session.get("token")
    session_id = session.get("id")
    cwd = session.get("cwd")
    leader = session.get("leader")
    pid = session.get("pid")

    if not isinstance(socket_path, str) or not socket_path:
        return False
    if not isinstance(token, str) or not token:
        return False
    if not isinstance(session_id, str) or not session_id:
        return False
    if not isinstance(cwd, str) or not cwd:
        return False
    if not isinstance(leader, str) or not leader:
        return False

    # PID must be numeric, positive, and live
    if pid is not None:
        if not isinstance(pid, int):
            return False
        if not is_live_pid(pid):
            return False

    return True


def validate_socket_path(socket_path: str) -> bool:
    """Validate socket file ownership and permissions before connecting."""
    try:
        path = Path(socket_path)
        current_uid = os.getuid()

        # Socket must exist and be a socket
        if not path.exists():
            return False
        stat_info = path.lstat()
        if not stat.S_ISSOCK(stat_info.st_mode):
            return False

        # Must be owned by current uid
        if stat_info.st_uid != current_uid:
            return False

        # Must not have group or other permission bits
        if stat_info.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
            return False

        # Parent directory must exist, be owned by current uid, and not be group/other accessible
        parent = path.parent
        if not parent.exists():
            return False
        parent_stat = parent.lstat()
        if parent_stat.st_uid != current_uid:
            return False
        if parent_stat.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
            return False

        return True
    except (OSError, TypeError):
        return False


def load_session_registry(neta_dir: Path) -> list[dict]:
    """Load all validated session registry files from neta_dir/sessions/*.json."""
    sessions_dir = neta_dir / "sessions"
    if not sessions_dir.exists():
        return []

    sessions = []
    try:
        for session_file in sorted(sessions_dir.glob("*.json")):
            try:
                with open(session_file) as f:
                    data = json.load(f)
                    if validate_registry_record(data, session_file):
                        sessions.append(data)
            except (json.JSONDecodeError, IOError, OSError):
                # Skip malformed files
                pass
    except OSError:
        # Directory read error
        pass

    return sessions


@contextmanager
def connect_to_socket(socket_path: str, timeout_total: float = SOCKET_TIMEOUT_TOTAL):
    """Context manager for Unix socket connection with timeout and cleanup."""
    sock = None
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout_total)
        sock.connect(socket_path)
        yield sock
    except (socket.error, OSError):
        raise
    finally:
        if sock:
            try:
                sock.close()
            except OSError:
                pass


def get_session_status(session: dict) -> dict | None:
    """Connect to session socket and fetch status. Returns None if unreachable."""
    socket_path = session.get("socket")
    token = session.get("token")

    if not socket_path or not token:
        return None

    # Validate socket before connecting
    if not validate_socket_path(socket_path):
        return None

    try:
        with connect_to_socket(socket_path) as sock:
            # Send status request as newline-delimited JSON
            request = json.dumps({"type": "status", "token": token})
            sock.sendall((request + "\n").encode())

            # Read response with size limit
            response_data = b""
            while len(response_data) < MAX_RESPONSE_SIZE:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response_data += chunk

            # Must end with newline or EOF
            if not response_data:
                return None

            # Parse response
            response_text = response_data.decode()
            response = json.loads(response_text.strip())

            # Response must be a dict, not a scalar or list
            if not isinstance(response, dict):
                return None

            return response
    except (socket.error, json.JSONDecodeError, UnicodeDecodeError, OSError):
        return None


def format_session_display(session: dict, status: dict | None) -> str:
    """Format session for display with safe header and verbatim status."""
    session_id = escape_header_field(session.get("id"))
    cwd = escape_header_field(session.get("cwd"))
    leader = escape_header_field(session.get("leader"))

    header = f"[{session_id} | {leader} | {cwd}]"

    if status is None:
        return f"{header}\n  Control plane unreachable\n"

    if not status.get("ok"):
        error = escape_header_field(status.get("error"))
        return f"{header}\n  Error: {error}\n"

    status_text = status.get("text", "")
    if not status_text:
        return f"{header}\n  Status format unavailable\n"

    # Render status text verbatim (preserve Neta formatting)
    lines = status_text.split("\n")
    indented = "\n".join("  " + line for line in lines)
    return f"{header}\n{indented}\n"


def single_display_iteration(neta_dir: Path) -> None:
    """Single iteration of status display (used for testing and --once mode)."""
    sessions = load_session_registry(neta_dir)

    if not sessions:
        print("No live Neta sessions")
        return

    for session in sessions:
        status = get_session_status(session)
        output = format_session_display(session, status)
        print(output)


def display_status(neta_dir: Path) -> None:
    """Display live session status, continuously refreshed."""
    try:
        while True:
            single_display_iteration(neta_dir)
            print("---")
            print(f"Last update: {time.strftime('%H:%M:%S')} (Ctrl+C to exit)")
            print()
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nMonitor stopped")
        sys.exit(0)


def display_status_once(neta_dir: Path) -> None:
    """Display live session status once and exit."""
    single_display_iteration(neta_dir)


def get_herdr_panes() -> dict | None:
    """Get list of panes from Herdr. Herdr 0.8.2 returns JSON envelope on stdout."""
    herdr_bin = os.environ.get("HERDR_BIN_PATH", "herdr")
    cmd = [herdr_bin, "pane", "list"]  # No --json flag; Herdr returns JSON envelope

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=5,
            text=True,
        )
        if result.returncode != 0:
            return None
        response = json.loads(result.stdout)
        # Herdr 0.8.2 wraps result in envelope
        return response.get("result", {})
    except (subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def get_plugin_root() -> Path | None:
    """Return Herdr's canonical plugin root, if the runtime provided it."""
    plugin_root = os.environ.get("HERDR_PLUGIN_ROOT")
    if not plugin_root:
        return None

    try:
        return Path(plugin_root).expanduser().resolve()
    except (OSError, RuntimeError):
        return None


def is_monitor_pane(pane: dict, plugin_root: Path | None) -> bool:
    """Return whether a pane belongs to this plugin instance."""
    if plugin_root is None or pane.get("label") != "Neta Monitor":
        return False

    pane_cwd = pane.get("cwd")
    if not isinstance(pane_cwd, str):
        return False

    try:
        return Path(pane_cwd).expanduser().resolve() == plugin_root
    except (OSError, RuntimeError):
        return False


def find_monitor_pane() -> str | None:
    """Find first existing monitor pane ID. Returns pane_id if found, None otherwise."""
    panes_data = get_herdr_panes()
    if panes_data is None:
        return None

    plugin_root = get_plugin_root()
    # Herdr 0.8.2 pane list format: result.panes[].
    panes = panes_data.get("panes", [])
    for pane in panes:
        if is_monitor_pane(pane, plugin_root):
            return pane.get("pane_id")

    return None


def find_all_monitor_panes() -> list[str]:
    """Find ALL monitor panes owned by this plugin. Returns list of pane_ids."""
    panes_data = get_herdr_panes()
    if panes_data is None:
        return []

    plugin_root = get_plugin_root()
    pane_ids = []
    panes = panes_data.get("panes", [])
    for pane in panes:
        if is_monitor_pane(pane, plugin_root):
            pane_id = pane.get("pane_id")
            if pane_id:
                pane_ids.append(pane_id)

    return pane_ids


def focus_monitor_pane(pane_id: str) -> bool:
    """Focus existing monitor pane using Herdr CLI."""
    herdr_bin = os.environ.get("HERDR_BIN_PATH", "herdr")
    cmd = [
        herdr_bin,
        "plugin",
        "pane",
        "focus",
        pane_id,
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=5,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


def close_monitor_pane(pane_id: str) -> bool:
    """Close a specific monitor pane using Herdr CLI."""
    herdr_bin = os.environ.get("HERDR_BIN_PATH", "herdr")
    cmd = [
        herdr_bin,
        "plugin",
        "pane",
        "close",
        pane_id,
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=5,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


def open_monitor_pane() -> bool:
    """Open monitor pane using Herdr CLI."""
    herdr_bin = os.environ.get("HERDR_BIN_PATH", "herdr")
    cmd = [
        herdr_bin,
        "plugin",
        "pane",
        "open",
        "--plugin",
        "personal.neta-status",
        "--entrypoint",
        "monitor",
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=5,
            text=True,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


def ensure_monitor_pane_open() -> bool:
    """Ensure monitor pane is open, using existing pane if available (idempotent)."""
    # First, try to find an existing monitor pane
    existing_pane_id = find_monitor_pane()
    if existing_pane_id:
        # Pane exists - idempotence achieved, don't create new one
        # Try to focus it, but if focus fails, still return success
        # (pane already exists, we're not creating a duplicate)
        focus_monitor_pane(existing_pane_id)
        return True

    # No existing pane, open a new one
    return open_monitor_pane()


def main():
    parser = ArgumentParser(description="Monitor live Neta sessions")
    parser.add_argument("--once", action="store_true", help="Display status once and exit")
    parser.add_argument("--neta-dir", type=Path, help="Override NETA_DIR (default: ~/.neta)")
    parser.add_argument("--startup", action="store_true", help="Startup hook mode")

    args = parser.parse_args()

    if args.startup:
        # Startup hook: ensure monitor pane is open (idempotent)
        if not ensure_monitor_pane_open():
            # Fail closed with visible error
            print("Error: Failed to open or focus Neta Monitor pane", file=sys.stderr)
            sys.exit(1)
        sys.exit(0)

    neta_dir = args.neta_dir or get_neta_dir()

    if args.once:
        display_status_once(neta_dir)
    else:
        display_status(neta_dir)


if __name__ == "__main__":
    main()
