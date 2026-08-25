#!/usr/bin/env python3
"""Reconcile live Neta actors into Herdr 0.8.2 pane-backed Agents rows."""

from __future__ import annotations

import fcntl
import json
import os
import signal
import socket
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


PLUGIN_ID = "personal.neta-status"
LIFECYCLE_SOURCE = f"{PLUGIN_ID}:worker"
METADATA_SOURCE = f"{PLUGIN_ID}:metadata"
OWNER_TOKEN = "neta_plugin_owner"
IDENTITY_TOKEN = "neta_actor_identity"
SESSION_TOKEN = "neta_session_id"
WORKER_PANE_LABEL = "Neta Worker"
ACTIVE_STATES = {"starting", "running", "waiting", "queued", "blocked"}
TERMINAL_STATES = {"done", "failed", "killed", "interrupted"}
STATE_MAP = {
    "starting": "working",
    "running": "working",
    "waiting": "working",
    "queued": "idle",
    "blocked": "blocked",
}
MAX_RESPONSE_SIZE = 1024 * 1024


def canonical_path(value: str) -> str | None:
    try:
        return str(Path(value).expanduser().resolve(strict=True))
    except (OSError, RuntimeError, TypeError):
        return None


def process_start_time(pid: int) -> str | None:
    if not isinstance(pid, int) or pid <= 1:
        return None
    try:
        result = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=2,
        )
        value = result.stdout.strip()
        return value if result.returncode == 0 and value else None
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None


def secure_regular_file(path: Path) -> bool:
    try:
        info = path.lstat()
        return (
            stat.S_ISREG(info.st_mode)
            and info.st_uid == os.getuid()
            and not info.st_mode & (stat.S_IRWXG | stat.S_IRWXO)
        )
    except OSError:
        return False


def secure_socket(path_value: str) -> bool:
    try:
        path = Path(path_value)
        info = path.lstat()
        parent = path.parent.lstat()
        return (
            stat.S_ISSOCK(info.st_mode)
            and info.st_uid == os.getuid()
            and not info.st_mode & (stat.S_IRWXG | stat.S_IRWXO)
            and stat.S_ISDIR(parent.st_mode)
            and parent.st_uid == os.getuid()
            and not parent.st_mode & (stat.S_IRWXG | stat.S_IRWXO)
        )
    except (OSError, TypeError):
        return False


def validate_registry(
    value: object,
    path: Path,
    identify: Callable[[int], str | None] = process_start_time,
) -> dict | None:
    if not secure_regular_file(path) or not isinstance(value, dict):
        return None
    strings = ("id", "socket", "token", "cwd", "leader", "processStartedAt")
    if any(not isinstance(value.get(key), str) or not value[key] for key in strings):
        return None
    if value["id"] != path.stem:
        return None
    pid = value.get("pid")
    started_at = value.get("startedAt")
    if not isinstance(pid, int) or pid <= 1 or not isinstance(started_at, (int, float)):
        return None
    if identify(pid) != value["processStartedAt"]:
        return None
    cwd = canonical_path(value["cwd"])
    if cwd is None or cwd != value["cwd"]:
        return None
    return value


@dataclass
class RegistryScan:
    valid: dict[str, dict]
    uncertain: set[str]
    dead: set[str]


def scan_registry(
    neta_dir: Path,
    identify: Callable[[int], str | None] = process_start_time,
) -> RegistryScan:
    sessions_dir = neta_dir / "sessions"
    valid: dict[str, dict] = {}
    uncertain: set[str] = set()
    dead: set[str] = set()
    try:
        paths = sorted(sessions_dir.glob("*.json"))
    except OSError:
        return RegistryScan(valid, uncertain, dead)
    for path in paths:
        try:
            raw = json.loads(path.read_text())
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            uncertain.add(path.stem)
            continue
        record = validate_registry(raw, path, identify)
        if record is not None:
            valid[record["id"]] = record
            continue
        if isinstance(raw, dict) and raw.get("id") == path.stem:
            pid = raw.get("pid")
            expected = raw.get("processStartedAt")
            if isinstance(pid, int) and isinstance(expected, str) and identify(pid) != expected:
                dead.add(path.stem)
                continue
        uncertain.add(path.stem)
    return RegistryScan(valid, uncertain, dead)


def socket_request(record: dict) -> dict | None:
    if not secure_socket(record["socket"]):
        return None
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(2)
            client.connect(record["socket"])
            request = {"type": "actor-snapshot", "token": record["token"]}
            client.sendall((json.dumps(request) + "\n").encode())
            response = bytearray()
            while len(response) <= MAX_RESPONSE_SIZE:
                chunk = client.recv(4096)
                if not chunk:
                    break
                response.extend(chunk)
            if not response or len(response) > MAX_RESPONSE_SIZE:
                return None
        value = json.loads(response.decode().strip())
        return value if isinstance(value, dict) else None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def validate_snapshot(response: object, registry: dict) -> dict | None:
    if not isinstance(response, dict) or response.get("ok") is not True:
        return None
    data = response.get("data")
    if not isinstance(data, dict) or data.get("version") != 1:
        return None
    session = data.get("session")
    leader = data.get("leader")
    workers = data.get("workers")
    if not isinstance(session, dict) or not isinstance(leader, dict) or not isinstance(workers, list):
        return None
    exact = (
        session.get("id") == registry["id"]
        and session.get("managerPid") == registry["pid"]
        and session.get("processStartedAt") == registry["processStartedAt"]
        and canonical_path(session.get("cwd")) == registry["cwd"]
        and leader.get("backend") == registry["leader"]
        and leader.get("state") == "running"
    )
    if not exact:
        return None
    seen: set[str] = set()
    for worker in workers:
        if not isinstance(worker, dict):
            return None
        required_strings = ("id", "state", "name", "role", "tier", "backend", "task", "cwd")
        if any(not isinstance(worker.get(key), str) for key in required_strings):
            return None
        if worker["id"] in seen or worker["state"] not in ACTIVE_STATES | TERMINAL_STATES:
            return None
        if not isinstance(worker.get("writer"), bool) or not isinstance(worker.get("startedAt"), (int, float)):
            return None
        if canonical_path(worker["cwd"]) != registry["cwd"]:
            return None
        seen.add(worker["id"])
    return data


class HerdrClient:
    def __init__(self, binary: str | None = None):
        self.binary = binary or os.environ.get("HERDR_BIN_PATH", "herdr")

    def run(self, args: list[str]) -> dict | None:
        try:
            result = subprocess.run([self.binary, *args], capture_output=True, text=True, timeout=5)
            if result.returncode != 0:
                return None
            value = json.loads(result.stdout)
            return value if isinstance(value, dict) else None
        except (FileNotFoundError, OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
            return None

    def panes(self) -> list[dict] | None:
        response = self.run(["pane", "list"])
        panes = response and response.get("result", {}).get("panes")
        return panes if isinstance(panes, list) else None

    def process_info(self, pane_id: str) -> dict | None:
        response = self.run(["pane", "process-info", "--pane", pane_id])
        value = response and response.get("result", {}).get("process_info")
        return value if isinstance(value, dict) else None

    def open_worker(self, identity: str, workspace: str | None) -> str | None:
        args = [
            "plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "worker",
            "--placement", "tab", "--no-focus", "--env", f"NETA_ACTOR_IDENTITY={identity}",
        ]
        if workspace:
            args.extend(["--workspace", workspace])
        response = self.run(args)
        pane = response and response.get("result", {}).get("plugin_pane", {}).get("pane")
        pane_id = pane.get("pane_id") if isinstance(pane, dict) else None
        return pane_id if isinstance(pane_id, str) and pane_id else None

    def close(self, pane_id: str) -> bool:
        return self.run(["plugin", "pane", "close", pane_id]) is not None

    def command(self, args: list[str]) -> bool:
        return self.run(["pane", *args]) is not None


class StateStore:
    def __init__(self, state_dir: Path):
        self.path = state_dir / "reporter-state.json"
        self.data = {"panes": {}, "seq": {}}
        try:
            value = json.loads(self.path.read_text())
            if isinstance(value, dict) and isinstance(value.get("panes"), dict) and isinstance(value.get("seq"), dict):
                self.data = value
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            pass

    def next_seq(self, pane_id: str, source: str) -> int:
        key = f"{pane_id}\0{source}"
        value = self.data["seq"].get(key, 0) + 1
        self.data["seq"][key] = value
        self.save()
        return value

    def save(self) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.data, sort_keys=True))
        temporary.chmod(0o600)
        temporary.replace(self.path)


class Reporter:
    def __init__(
        self,
        neta_dir: Path,
        state: StateStore,
        herdr: HerdrClient,
        plugin_root: Path,
        identify: Callable[[int], str | None] = process_start_time,
        fetch: Callable[[dict], dict | None] = socket_request,
    ):
        self.neta_dir = neta_dir
        self.state = state
        self.herdr = herdr
        self.plugin_root = str(plugin_root.resolve())
        self.identify = identify
        self.fetch = fetch

    def _seq_args(self, pane_id: str, source: str) -> list[str]:
        return ["--seq", str(self.state.next_seq(pane_id, source))]

    def _owned(self, pane: dict, identity: str) -> bool:
        return (
            pane.get("pane_id") == self.state.data["panes"].get(identity, {}).get("pane_id")
            and pane.get("label") == WORKER_PANE_LABEL
            and canonical_path(pane.get("cwd")) == self.plugin_root
            and pane.get("tokens", {}).get(OWNER_TOKEN) == PLUGIN_ID
            and pane.get("tokens", {}).get(IDENTITY_TOKEN) == identity
        )

    def _report_worker(self, pane_id: str, identity: str, session_id: str, worker: dict) -> bool:
        source = LIFECYCLE_SOURCE
        agent = worker["backend"]
        if not self.herdr.command([
            "report-agent-session", pane_id, "--source", source, "--agent", agent,
            "--agent-session-id", identity, "--session-start-source", "startup",
            *self._seq_args(pane_id, source),
        ]):
            return False
        state = STATE_MAP[worker["state"]]
        message = worker.get("pendingQuestion") if state == "blocked" else worker.get("lastProgress", {}).get("text")
        report = ["report-agent", pane_id, "--source", source, "--agent", agent, "--state", state]
        if isinstance(message, str) and message:
            report.extend(["--message", message])
        report.extend(self._seq_args(pane_id, source))
        if not self.herdr.command(report):
            return False
        title = worker["name"] or worker["task"] or worker["role"]
        queued = "queued" if worker["state"] == "queued" else worker["state"]
        metadata = [
            "report-metadata", pane_id, "--source", METADATA_SOURCE, "--agent", agent,
            "--applies-to-source", source, "--title", title,
            "--display-agent", f"Neta {worker['role']}",
            "--token", f"{OWNER_TOKEN}={PLUGIN_ID}",
            "--token", f"{IDENTITY_TOKEN}={identity}",
            "--token", f"{SESSION_TOKEN}={session_id}",
            "--token", f"state={queued}",
            "--token", f"tier={worker['tier']}",
            "--token", f"writer={'yes' if worker['writer'] else 'no'}",
            *self._seq_args(pane_id, METADATA_SOURCE),
        ]
        return self.herdr.command(metadata)

    def _unknown(self, pane_id: str, identity: str) -> None:
        entry = self.state.data["panes"].get(identity, {})
        agent = entry.get("agent", "neta")
        self.herdr.command([
            "report-agent", pane_id, "--source", LIFECYCLE_SOURCE, "--agent", agent,
            "--state", "unknown", "--message", "Neta control plane temporarily unreachable",
            *self._seq_args(pane_id, LIFECYCLE_SOURCE),
        ])

    def _cleanup(self, identity: str, pane: dict | None) -> None:
        entry = self.state.data["panes"].get(identity)
        if not isinstance(entry, dict) or pane is None or not self._owned(pane, identity):
            return
        pane_id = entry["pane_id"]
        agent = entry.get("agent", "neta")
        cleared = self.herdr.command([
            "report-metadata", pane_id, "--source", METADATA_SOURCE, "--agent", agent,
            "--applies-to-source", LIFECYCLE_SOURCE, "--clear-title", "--clear-display-agent",
            "--clear-state-labels", "--clear-token", OWNER_TOKEN, "--clear-token", IDENTITY_TOKEN,
            "--clear-token", SESSION_TOKEN, "--clear-token", "state", "--clear-token", "tier",
            "--clear-token", "writer", *self._seq_args(pane_id, METADATA_SOURCE),
        ])
        released = self.herdr.command([
            "release-agent", pane_id, "--source", LIFECYCLE_SOURCE, "--agent", agent,
            *self._seq_args(pane_id, LIFECYCLE_SOURCE),
        ])
        if released and cleared and self.herdr.close(pane_id):
            del self.state.data["panes"][identity]
            self.state.save()

    def _leader_pane(self, registry: dict, panes: list[dict]) -> dict | None:
        matches = []
        for pane in panes:
            pane_cwd = canonical_path(pane.get("foreground_cwd") or pane.get("cwd"))
            if pane_cwd != registry["cwd"] or pane.get("agent") != registry["leader"]:
                continue
            info = self.herdr.process_info(pane.get("pane_id", ""))
            processes = info.get("foreground_processes", []) if info else []
            if any(process.get("pid") == registry["pid"] for process in processes if isinstance(process, dict)):
                matches.append(pane)
        return matches[0] if len(matches) == 1 else None

    def _report_leader(self, registry: dict, snapshot: dict, pane: dict) -> None:
        pane_id = pane["pane_id"]
        leader = snapshot["leader"]
        self.herdr.command([
            "report-metadata", pane_id, "--source", METADATA_SOURCE,
            "--agent", leader["backend"], "--title", "Neta leader",
            "--display-agent", f"Neta leader · {leader['backend']}",
            "--token", f"{SESSION_TOKEN}={registry['id']}",
            "--token", f"neta_logical_session_id={snapshot['session']['logicalId']}",
            *self._seq_args(pane_id, METADATA_SOURCE),
        ])

    def reconcile_once(self) -> bool:
        panes = self.herdr.panes()
        if panes is None:
            return False
        by_id = {pane.get("pane_id"): pane for pane in panes if isinstance(pane, dict)}
        scan = scan_registry(self.neta_dir, self.identify)
        known_sessions = {entry.get("session_id") for entry in self.state.data["panes"].values() if isinstance(entry, dict)}
        for session_id in known_sessions:
            if not isinstance(session_id, str):
                continue
            session_path = self.neta_dir / "sessions" / f"{session_id}.json"
            identities = [key for key, value in self.state.data["panes"].items() if value.get("session_id") == session_id]
            if session_id in scan.dead or not session_path.exists():
                for identity in identities:
                    entry = self.state.data["panes"].get(identity, {})
                    self._cleanup(identity, by_id.get(entry.get("pane_id")))
            elif session_id in scan.uncertain:
                for identity in identities:
                    entry = self.state.data["panes"].get(identity, {})
                    pane = by_id.get(entry.get("pane_id"))
                    if pane is not None and self._owned(pane, identity):
                        self._unknown(entry["pane_id"], identity)

        for session_id, registry in scan.valid.items():
            response = self.fetch(registry)
            snapshot = validate_snapshot(response, registry)
            session_entries = [
                (identity, entry) for identity, entry in self.state.data["panes"].items()
                if entry.get("session_id") == session_id
            ]
            if snapshot is None:
                for identity, entry in session_entries:
                    pane = by_id.get(entry.get("pane_id"))
                    if pane is not None and self._owned(pane, identity):
                        self._unknown(entry["pane_id"], identity)
                continue
            leader_pane = self._leader_pane(registry, panes)
            if leader_pane is not None:
                self._report_leader(registry, snapshot, leader_pane)
            workspace = leader_pane.get("workspace_id") if leader_pane else None
            if workspace is None:
                cwd_workspaces = {
                    pane.get("workspace_id")
                    for pane in panes
                    if canonical_path(pane.get("foreground_cwd") or pane.get("cwd")) == registry["cwd"]
                    and isinstance(pane.get("workspace_id"), str)
                }
                if len(cwd_workspaces) == 1:
                    workspace = next(iter(cwd_workspaces))
            workers = {worker["id"]: worker for worker in snapshot["workers"]}
            for worker_id, worker in workers.items():
                identity = f"{session_id}:worker:{worker_id}"
                entry = self.state.data["panes"].get(identity)
                pane = by_id.get(entry.get("pane_id")) if isinstance(entry, dict) else None
                if pane is None:
                    candidates = [
                        candidate for candidate in panes
                        if candidate.get("label") == WORKER_PANE_LABEL
                        and canonical_path(candidate.get("cwd")) == self.plugin_root
                        and isinstance(candidate.get("tokens"), dict)
                        and candidate["tokens"].get(OWNER_TOKEN) == PLUGIN_ID
                        and candidate["tokens"].get(IDENTITY_TOKEN) == identity
                    ]
                    if len(candidates) == 1:
                        pane = candidates[0]
                        self.state.data["panes"][identity] = {
                            "pane_id": pane["pane_id"], "session_id": session_id, "agent": worker["backend"]
                        }
                        self.state.save()
                    elif len(candidates) > 1:
                        continue
                if worker["state"] in TERMINAL_STATES:
                    self._cleanup(identity, pane)
                    continue
                if pane is not None and not self._owned(pane, identity):
                    continue
                if pane is None:
                    pane_id = self.herdr.open_worker(identity, workspace)
                    if pane_id is None:
                        continue
                    self.state.data["panes"][identity] = {
                        "pane_id": pane_id, "session_id": session_id, "agent": worker["backend"]
                    }
                    self.state.save()
                    pane = {
                        "pane_id": pane_id, "label": WORKER_PANE_LABEL, "cwd": self.plugin_root,
                        "tokens": {OWNER_TOKEN: PLUGIN_ID, IDENTITY_TOKEN: identity},
                    }
                    by_id[pane_id] = pane
                self.state.data["panes"][identity]["agent"] = worker["backend"]
                self.state.save()
                self._report_worker(pane["pane_id"], identity, session_id, worker)
        return True


def state_dir() -> Path:
    value = os.environ.get("HERDR_PLUGIN_STATE_DIR")
    return Path(value) if value else Path.home() / ".local" / "state" / "herdr" / PLUGIN_ID


def neta_dir() -> Path:
    return Path(os.environ.get("NETA_DIR", str(Path.home() / ".neta")))


def plugin_root() -> Path:
    return Path(os.environ.get("HERDR_PLUGIN_ROOT", str(Path(__file__).parent.parent)))


def worker_pane() -> None:
    identity = os.environ.get("NETA_ACTOR_IDENTITY", "unknown")
    print(f"Neta worker sidebar proxy: {identity}", flush=True)
    signal.pause()


def run_reporter(once: bool = False) -> int:
    directory = state_dir()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    lock_path = directory / "reporter.lock"
    with lock_path.open("a+") as lock:
        os.fchmod(lock.fileno(), 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        reporter = Reporter(neta_dir(), StateStore(directory), HerdrClient(), plugin_root())
        while True:
            if not reporter.reconcile_once():
                return 0
            if once:
                return 0
            time.sleep(1)


def start_background() -> int:
    command = [sys.executable, str(Path(__file__).resolve()), "--run"]
    directory = state_dir()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    with (directory / "reporter.log").open("a") as log:
        os.fchmod(log.fileno(), 0o600)
        subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
    return 0


def main() -> int:
    if "--worker-pane" in sys.argv:
        worker_pane()
        return 0
    if "--startup" in sys.argv:
        return start_background()
    return run_reporter(once="--once" in sys.argv)


if __name__ == "__main__":
    raise SystemExit(main())
