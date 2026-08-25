#!/usr/bin/env python3
"""Deterministic tests for the Herdr Agents-sidebar reconciler."""

import json
import os
import socket
import tempfile
import threading
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from reporter import (  # noqa: E402
    IDENTITY_TOKEN,
    HerdrClient,
    LIFECYCLE_SOURCE,
    METADATA_SOURCE,
    OWNER_TOKEN,
    PLUGIN_ID,
    Reporter,
    StateStore,
    WORKER_PANE_LABEL,
    scan_registry,
    socket_request,
)


class FakeHerdr:
    def __init__(self, plugin_root: Path):
        self.plugin_root = str(plugin_root.resolve())
        self.current_panes = []
        self.commands = []
        self.open_count = 0
        self.closed = []
        self.processes = {}

    def panes(self):
        return [dict(pane, tokens=dict(pane.get("tokens", {}))) for pane in self.current_panes]

    def process_info(self, pane_id):
        return {"foreground_processes": self.processes.get(pane_id, [])}

    def open_worker(self, identity, workspace):
        self.open_count += 1
        pane_id = f"proxy-{self.open_count}"
        self.current_panes.append({
            "pane_id": pane_id,
            "workspace_id": workspace or "workspace-1",
            "cwd": self.plugin_root,
            "label": WORKER_PANE_LABEL,
            "tokens": {},
        })
        self.commands.append(["open-worker", identity, workspace])
        return pane_id

    def close(self, pane_id):
        self.closed.append(pane_id)
        self.current_panes = [pane for pane in self.current_panes if pane["pane_id"] != pane_id]
        return True

    def command(self, args):
        self.commands.append(args)
        if args[0] == "report-metadata":
            pane = next((pane for pane in self.current_panes if pane["pane_id"] == args[1]), None)
            if pane is not None:
                for index, value in enumerate(args):
                    if value == "--token":
                        name, token = args[index + 1].split("=", 1)
                        pane.setdefault("tokens", {})[name] = token
                    elif value == "--clear-token":
                        pane.setdefault("tokens", {}).pop(args[index + 1], None)
        return True


class ReporterHarness(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.neta = self.root / "neta"
        self.sessions = self.neta / "sessions"
        self.sessions.mkdir(parents=True)
        self.cwd = self.root / "repo"
        self.cwd.mkdir()
        self.plugin = self.root / "plugin"
        self.plugin.mkdir()
        self.state = StateStore(self.root / "state")
        self.herdr = FakeHerdr(self.plugin)
        self.identities = {}
        self.snapshots = {}
        self.reporter = Reporter(
            self.neta,
            self.state,
            self.herdr,
            self.plugin,
            identify=lambda pid: self.identities.get(pid),
            fetch=lambda record: self.snapshots.get(record["id"]),
        )

    def tearDown(self):
        self.temp.cleanup()

    def add_session(self, session_id="s1", pid=101, worker_id="ro1", state="running"):
        started = f"start-{pid}"
        self.identities[pid] = started
        record = {
            "id": session_id,
            "socket": str(self.root / f"{session_id}.sock"),
            "token": f"token-{session_id}",
            "cwd": str(self.cwd.resolve()),
            "leader": "codex",
            "pid": pid,
            "processStartedAt": started,
            "startedAt": 1000,
        }
        path = self.sessions / f"{session_id}.json"
        path.write_text(json.dumps(record))
        path.chmod(0o600)
        worker = {
            "id": worker_id,
            "state": state,
            "name": "socket bridge",
            "role": "worker",
            "tier": "expert",
            "backend": "codex",
            "writer": True,
            "task": "connect Herdr",
            "cwd": record["cwd"],
            "startedAt": 1100,
            "lastProgress": {"text": "reporting", "at": 1200},
        }
        self.snapshots[session_id] = {
            "ok": True,
            "data": {
                "version": 1,
                "session": {
                    "id": session_id,
                    "logicalId": f"logical-{session_id}",
                    "cwd": record["cwd"],
                    "managerPid": pid,
                    "processStartedAt": started,
                    "startedAt": 1000,
                },
                "leader": {"id": f"{session_id}:leader", "backend": "codex", "state": "running", "startedAt": 1000},
                "workers": [worker],
            },
        }
        return record, worker

    def lifecycle_states(self):
        return [
            command[command.index("--state") + 1]
            for command in self.herdr.commands
            if command and command[0] == "report-agent"
        ]


class TestReconciliation(ReporterHarness):
    def test_duplicate_reconciliation_and_monotonic_sequences(self):
        self.add_session()
        self.assertTrue(self.reporter.reconcile_once())
        self.assertTrue(self.reporter.reconcile_once())
        self.assertEqual(self.herdr.open_count, 1)
        sequences = {}
        for command in self.herdr.commands:
            if not command or command[0] not in {"report-agent", "report-agent-session", "report-metadata"}:
                continue
            source = command[command.index("--source") + 1]
            seq = int(command[command.index("--seq") + 1])
            sequences.setdefault((command[1], source), []).append(seq)
        for values in sequences.values():
            self.assertEqual(values, sorted(set(values)))

    def test_state_mapping_including_queued_and_blocked_metadata(self):
        _, worker = self.add_session(state="starting")
        for neta_state in ("starting", "running", "waiting", "queued", "blocked"):
            worker["state"] = neta_state
            if neta_state == "blocked":
                worker["pendingQuestion"] = "Which owner?"
            self.reporter.reconcile_once()
        self.assertEqual(self.lifecycle_states(), ["working", "working", "working", "idle", "blocked"])
        queued_metadata = [
            command for command in self.herdr.commands
            if command and command[0] == "report-metadata" and "state=queued" in command
        ]
        self.assertEqual(len(queued_metadata), 1)
        blocked = [command for command in self.herdr.commands if command and command[0] == "report-agent"][-1]
        self.assertIn("Which owner?", blocked)

    def test_transient_socket_failure_retains_row_as_unknown_then_terminal_cleans_up(self):
        _, worker = self.add_session()
        self.reporter.reconcile_once()
        identity = "s1:worker:ro1"
        pane_id = self.state.data["panes"][identity]["pane_id"]
        self.snapshots["s1"] = None
        self.reporter.reconcile_once()
        self.assertIn(identity, self.state.data["panes"])
        self.assertEqual(self.lifecycle_states()[-1], "unknown")
        self.add_session(state="done")
        self.reporter.reconcile_once()
        self.assertNotIn(identity, self.state.data["panes"])
        self.assertEqual(self.herdr.closed, [pane_id])
        cleanup = [command[0] for command in self.herdr.commands[-2:]]
        self.assertEqual(cleanup, ["report-metadata", "release-agent"])

    def test_identical_worker_ids_in_two_sessions_get_distinct_composite_rows(self):
        self.add_session("s1", 101, "ro1")
        self.add_session("s2", 202, "ro1")
        self.reporter.reconcile_once()
        self.assertEqual(set(self.state.data["panes"]), {"s1:worker:ro1", "s2:worker:ro1"})
        self.assertEqual(self.herdr.open_count, 2)

    def test_leader_metadata_requires_one_exact_native_process_match(self):
        record, _ = self.add_session()
        leader = {
            "pane_id": "leader", "workspace_id": "workspace-1", "cwd": record["cwd"],
            "foreground_cwd": record["cwd"], "label": "Codex", "agent": "codex", "tokens": {},
        }
        self.herdr.current_panes.append(leader)
        self.herdr.processes["leader"] = [{"pid": record["pid"], "name": "neta"}]
        self.reporter.reconcile_once()
        leader_metadata = [
            command for command in self.herdr.commands
            if command and command[0] == "report-metadata" and command[1] == "leader"
        ]
        self.assertEqual(len(leader_metadata), 1)
        self.assertNotIn("report-agent", [command[0] for command in leader_metadata])

        self.herdr.commands.clear()
        duplicate = dict(leader, pane_id="leader-2")
        self.herdr.current_panes.append(duplicate)
        self.herdr.processes["leader-2"] = [{"pid": record["pid"], "name": "neta"}]
        self.reporter.reconcile_once()
        self.assertFalse(any(command[0] == "report-metadata" and command[1].startswith("leader") for command in self.herdr.commands))

    def test_pid_reuse_removes_only_owned_rows(self):
        self.add_session()
        self.reporter.reconcile_once()
        identity = "s1:worker:ro1"
        pane_id = self.state.data["panes"][identity]["pane_id"]
        self.identities[101] = "reused-start"
        self.reporter.reconcile_once()
        self.assertEqual(self.herdr.closed, [pane_id])

    def test_malformed_registry_and_snapshot_retain_unknown(self):
        self.add_session()
        self.reporter.reconcile_once()
        identity = "s1:worker:ro1"
        (self.sessions / "s1.json").write_text("{bad")
        self.reporter.reconcile_once()
        self.assertIn(identity, self.state.data["panes"])
        self.add_session()
        self.snapshots["s1"] = {"ok": True, "data": {"version": 1, "workers": "bad"}}
        self.reporter.reconcile_once()
        self.assertIn(identity, self.state.data["panes"])
        self.assertEqual(self.lifecycle_states()[-1], "unknown")

    def test_refuses_to_close_non_plugin_pane(self):
        self.add_session()
        identity = "s1:worker:ro1"
        self.state.data["panes"][identity] = {"pane_id": "native", "session_id": "s1", "agent": "codex"}
        self.state.save()
        self.herdr.current_panes.append({
            "pane_id": "native", "workspace_id": "workspace-1", "cwd": str(self.cwd),
            "label": "Codex", "tokens": {OWNER_TOKEN: PLUGIN_ID, IDENTITY_TOKEN: identity},
        })
        self.snapshots["s1"]["data"]["workers"][0]["state"] = "done"
        self.reporter.reconcile_once()
        self.assertEqual(self.herdr.closed, [])
        self.assertIn(identity, self.state.data["panes"])


class TestRegistryIdentity(ReporterHarness):
    def test_registry_requires_exact_start_identity(self):
        self.add_session()
        self.assertIn("s1", scan_registry(self.neta, lambda pid: f"start-{pid}").valid)
        scan = scan_registry(self.neta, lambda _pid: "replacement")
        self.assertIn("s1", scan.dead)
        self.assertNotIn("s1", scan.valid)


class TestRealProtocolHarness(unittest.TestCase):
    def test_fake_authenticated_unix_socket_records_structured_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            directory.chmod(0o700)
            socket_path = directory / "manager.sock"
            requests = []
            errors = []
            ready = threading.Event()

            def serve():
                try:
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                        server.bind(str(socket_path))
                        socket_path.chmod(0o600)
                        server.listen(1)
                        ready.set()
                        connection, _ = server.accept()
                        with connection:
                            requests.append(json.loads(connection.recv(4096).decode().strip()))
                            connection.sendall(b'{"ok":true,"data":{"version":1}}\n')
                except OSError as error:
                    errors.append(error)
                    ready.set()

            thread = threading.Thread(target=serve)
            thread.start()
            self.assertTrue(ready.wait(2))
            if errors:
                thread.join(2)
                self.skipTest(f"Unix sockets unavailable: {errors[0]}")
            response = socket_request({"socket": str(socket_path), "token": "secret"})
            thread.join(2)
            self.assertEqual(requests, [{"type": "actor-snapshot", "token": "secret"}])
            self.assertEqual(response, {"ok": True, "data": {"version": 1}})

    def test_fake_herdr_executable_records_exact_argv(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            executable = directory / "herdr-fake"
            argv_log = directory / "argv.json"
            executable.write_text(
                "#!/usr/bin/env python3\n"
                "import json, sys\n"
                f"open({str(argv_log)!r}, 'w').write(json.dumps(sys.argv[1:]))\n"
                "print(json.dumps({'result': {'panes': []}}))\n"
            )
            executable.chmod(0o700)
            self.assertEqual(HerdrClient(str(executable)).panes(), [])
            self.assertEqual(json.loads(argv_log.read_text()), ["pane", "list"])


if __name__ == "__main__":
    unittest.main()
