#!/usr/bin/env python3
"""Unit tests for Neta monitor script."""

import json
import os
import stat
import socket
import subprocess
import tempfile
import time
import tomllib
import unittest
import warnings
from pathlib import Path
from unittest.mock import patch, MagicMock, call

# Treat warnings as errors in tests
warnings.simplefilter("error", ResourceWarning)

# Add parent directory to path to import monitor
import sys
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from monitor import (
    escape_header_field,
    get_neta_dir,
    is_live_pid,
    validate_registry_record,
    validate_socket_path,
    load_session_registry,
    connect_to_socket,
    get_session_status,
    format_session_display,
    single_display_iteration,
    ensure_monitor_pane_open,
    find_monitor_pane,
    find_all_monitor_panes,
    focus_monitor_pane,
    close_monitor_pane,
    open_monitor_pane,
    get_herdr_panes,
    MAX_RESPONSE_SIZE,
)

TEST_PLUGIN_ROOT = "/tmp/herdr-test-neta-status"


class TestHerdrManifest(unittest.TestCase):
    """Test that Herdr resolves every monitor command from its plugin root."""

    def test_monitor_commands_use_quoted_plugin_root(self):
        """Startup, pane, and action commands use the runtime plugin root."""
        manifest_path = Path(__file__).parent.parent / "herdr-plugin.toml"
        with manifest_path.open("rb") as manifest_file:
            manifest = tomllib.load(manifest_file)

        startup = manifest["startup"][0]["command"]
        self.assertEqual(startup[:2], ["bash", "-c"])
        self.assertIn('"$HERDR_PLUGIN_ROOT/scripts/reporter.py" --startup', startup[2])
        worker = next(pane for pane in manifest["panes"] if pane["id"] == "worker")
        self.assertIn('"$HERDR_PLUGIN_ROOT/scripts/reporter.py" --worker-pane', worker["command"][2])
        monitor = next(pane for pane in manifest["panes"] if pane["id"] == "monitor")
        commands = [
            monitor["command"],
            manifest["actions"][0]["command"],
        ]
        expected_startup = [False, True]

        for command, starts_up in zip(commands, expected_startup):
            self.assertEqual(command[:2], ["bash", "-c"])
            self.assertEqual(len(command), 3)
            shell_argv = command[2]
            self.assertIn('"$HERDR_PLUGIN_ROOT/scripts/monitor.py"', shell_argv)
            self.assertNotIn("scripts/monitor.py", command)
            self.assertNotIn("personal-plugins", shell_argv)
            self.assertNotIn("/Users/", shell_argv)
            self.assertEqual(
                shell_argv.endswith(" --startup"),
                starts_up,
            )


class TestHeaderEscaping(unittest.TestCase):
    """Test escaping of untrusted header fields."""

    def test_escape_normal_string(self):
        """Normal strings pass through unchanged."""
        result = escape_header_field("normal-session-id")
        self.assertEqual(result, "normal-session-id")

    def test_escape_control_characters(self):
        """Control characters are replaced with ?."""
        result = escape_header_field("session\x00id\x01test")
        self.assertEqual(result, "session?id?test")

    def test_escape_newlines(self):
        """Newlines are replaced with ?."""
        result = escape_header_field("session\nid")
        self.assertEqual(result, "session?id")

    def test_escape_none(self):
        """None becomes ?."""
        result = escape_header_field(None)
        self.assertEqual(result, "?")

    def test_escape_delete_char(self):
        """DEL character (0x7f) is replaced with ?."""
        result = escape_header_field("session\x7fid")
        self.assertEqual(result, "session?id")


class TestIsLivePid(unittest.TestCase):
    """Test live PID detection."""

    def test_current_pid_is_live(self):
        """Current process PID is live."""
        result = is_live_pid(os.getpid())
        self.assertTrue(result)

    def test_negative_pid_is_dead(self):
        """Negative PID is rejected."""
        result = is_live_pid(-1)
        self.assertFalse(result)

    def test_zero_pid_is_dead(self):
        """Zero PID is rejected."""
        result = is_live_pid(0)
        self.assertFalse(result)

    def test_invalid_pid_type_is_dead(self):
        """Non-integer PID is rejected."""
        result = is_live_pid("not-a-number")
        self.assertFalse(result)

    def test_dead_pid_is_dead(self):
        """Dead PID (e.g., 1 on non-init systems) is rejected or accepted gracefully."""
        result = is_live_pid(999999)
        # May or may not be live depending on system, but should not crash
        self.assertIsInstance(result, bool)


class TestSocketPathValidation(unittest.TestCase):
    """Test socket path validation."""

    def setUp(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.current_uid = os.getuid()

    def tearDown(self):
        """Clean up."""
        self.temp_dir.cleanup()

    def test_nonexistent_socket_rejected(self):
        """Nonexistent socket path is rejected."""
        result = validate_socket_path("/tmp/nonexistent_socket_xyz.sock")
        self.assertFalse(result)

    def test_regular_file_rejected(self):
        """Regular file (not socket) is rejected."""
        file_path = self.temp_path / "not_a_socket"
        file_path.write_text("test")
        result = validate_socket_path(str(file_path))
        self.assertFalse(result)

    def test_symlink_rejected(self):
        """Symlink to socket is rejected."""
        real_socket = self.temp_path / "real.sock"
        real_socket.touch()
        link = self.temp_path / "link.sock"
        link.symlink_to(real_socket)
        result = validate_socket_path(str(link))
        self.assertFalse(result)

    def test_socket_with_group_perms_rejected(self):
        """Socket with group permissions is rejected."""
        sock_path = self.temp_path / "test.sock"
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.bind(str(sock_path))
            sock_path.chmod(0o660)
            result = validate_socket_path(str(sock_path))
            self.assertFalse(result)
            sock.close()
        except (OSError, TypeError):
            self.skipTest("Cannot create test socket on this system")

    def test_socket_with_other_perms_rejected(self):
        """Socket with other permissions is rejected."""
        sock_path = self.temp_path / "test.sock"
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.bind(str(sock_path))
            sock_path.chmod(0o606)
            result = validate_socket_path(str(sock_path))
            self.assertFalse(result)
            sock.close()
        except (OSError, TypeError):
            self.skipTest("Cannot create test socket on this system")

    def test_parent_with_group_perms_rejected(self):
        """Socket with parent having group perms is rejected."""
        subdir = self.temp_path / "subdir"
        subdir.mkdir()
        sock_path = subdir / "test.sock"
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.bind(str(sock_path))
            sock_path.chmod(0o600)
            subdir.chmod(0o750)  # Add group perms
            result = validate_socket_path(str(sock_path))
            self.assertFalse(result)
            sock.close()
        except (OSError, TypeError):
            self.skipTest("Cannot create test socket on this system")


class TestRegistryValidation(unittest.TestCase):
    """Test strict validation of registry files."""

    def setUp(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.current_uid = os.getuid()

    def tearDown(self):
        """Clean up."""
        self.temp_dir.cleanup()

    def test_validate_good_record(self):
        """Valid record with live PID passes validation."""
        session_file = self.temp_path / "test.json"
        session_file.write_text(json.dumps({
            "id": "test-1",
            "socket": "/tmp/test.sock",
            "token": "abc123",
            "cwd": "/home/test",
            "leader": "claude",
            "pid": os.getpid(),
        }))
        session_file.chmod(0o600)

        session = json.loads(session_file.read_text())
        result = validate_registry_record(session, session_file)
        self.assertTrue(result)

    def test_validate_reject_dead_pid(self):
        """Record with dead PID is rejected."""
        session_file = self.temp_path / "test.json"
        session_file.write_text(json.dumps({
            "id": "test-1",
            "socket": "/tmp/test.sock",
            "token": "abc123",
            "cwd": "/home/test",
            "leader": "claude",
            "pid": 999999,  # Likely dead
        }))
        session_file.chmod(0o600)

        session = json.loads(session_file.read_text())
        result = validate_registry_record(session, session_file)
        # Dead PID should be rejected
        self.assertFalse(result)

    def test_validate_accept_no_pid(self):
        """Record without PID is accepted."""
        session_file = self.temp_path / "test.json"
        session_file.write_text(json.dumps({
            "id": "test-1",
            "socket": "/tmp/test.sock",
            "token": "abc123",
            "cwd": "/home/test",
            "leader": "claude",
        }))
        session_file.chmod(0o600)

        session = json.loads(session_file.read_text())
        result = validate_registry_record(session, session_file)
        self.assertTrue(result)

    def test_validate_reject_symlink(self):
        """Symlink files are rejected."""
        real_file = self.temp_path / "real.json"
        real_file.write_text(json.dumps({
            "id": "test", "socket": "/tmp/test.sock",
            "token": "abc", "cwd": "/home", "leader": "c",
        }))

        link_file = self.temp_path / "link.json"
        link_file.symlink_to(real_file)

        session = json.loads(real_file.read_text())
        result = validate_registry_record(session, link_file)
        self.assertFalse(result)

    def test_validate_reject_group_readable(self):
        """Files with group permissions are rejected."""
        session_file = self.temp_path / "test.json"
        session_file.write_text(json.dumps({
            "id": "test-1",
            "socket": "/tmp/test.sock",
            "token": "abc123",
            "cwd": "/home/test",
            "leader": "claude",
        }))
        session_file.chmod(0o640)

        session = json.loads(session_file.read_text())
        result = validate_registry_record(session, session_file)
        self.assertFalse(result)

    def test_validate_reject_missing_socket(self):
        """Record without socket string is rejected."""
        session_file = self.temp_path / "test.json"
        session_file.write_text(json.dumps({
            "id": "test-1",
            "token": "abc123",
            "cwd": "/home/test",
            "leader": "claude",
        }))
        session_file.chmod(0o600)

        session = json.loads(session_file.read_text())
        result = validate_registry_record(session, session_file)
        self.assertFalse(result)


class TestLoadSessionRegistry(unittest.TestCase):
    """Test loading session registry from directory."""

    def setUp(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.sessions_dir = self.temp_path / "sessions"
        self.sessions_dir.mkdir()

    def tearDown(self):
        """Clean up."""
        self.temp_dir.cleanup()

    def test_load_empty_directory(self):
        """Test loading from empty sessions directory."""
        sessions = load_session_registry(self.temp_path)
        self.assertEqual(sessions, [])

    def test_load_single_valid_session(self):
        """Test loading a single valid session with live PID."""
        session_file = self.sessions_dir / "test-1.json"
        session_file.write_text(json.dumps({
            "id": "test-1",
            "socket": "/tmp/test.sock",
            "token": "abc123",
            "cwd": "/home/test",
            "leader": "claude",
            "pid": os.getpid(),
        }))
        session_file.chmod(0o600)

        sessions = load_session_registry(self.temp_path)
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]["id"], "test-1")

    def test_load_skips_dead_pid(self):
        """Test that dead PID sessions are skipped."""
        # Live session
        live_file = self.sessions_dir / "live.json"
        live_file.write_text(json.dumps({
            "id": "live",
            "socket": "/tmp/test.sock",
            "token": "abc123",
            "cwd": "/home/test",
            "leader": "claude",
            "pid": os.getpid(),
        }))
        live_file.chmod(0o600)

        # Dead session
        dead_file = self.sessions_dir / "dead.json"
        dead_file.write_text(json.dumps({
            "id": "dead",
            "socket": "/tmp/test.sock",
            "token": "abc123",
            "cwd": "/home/test",
            "leader": "claude",
            "pid": 999999,
        }))
        dead_file.chmod(0o600)

        sessions = load_session_registry(self.temp_path)
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]["id"], "live")


class TestSessionStatusValidation(unittest.TestCase):
    """Test session status response validation."""

    def test_reject_scalar_response(self):
        """Scalar response (not dict) is rejected."""
        session = {
            "socket": "/tmp/test.sock",
            "token": "test-token",
        }

        with patch("monitor.validate_socket_path") as mock_validate:
            with patch("monitor.connect_to_socket") as mock_connect:
                mock_validate.return_value = True
                mock_sock = MagicMock()
                mock_connect.return_value.__enter__.return_value = mock_sock
                # Simulate scalar response
                mock_sock.recv.side_effect = [b'"scalar response"\n', b'']

                status = get_session_status(session)
                self.assertIsNone(status)

    def test_reject_list_response(self):
        """List response (not dict) is rejected."""
        session = {
            "socket": "/tmp/test.sock",
            "token": "test-token",
        }

        with patch("monitor.validate_socket_path") as mock_validate:
            with patch("monitor.connect_to_socket") as mock_connect:
                mock_validate.return_value = True
                mock_sock = MagicMock()
                mock_connect.return_value.__enter__.return_value = mock_sock
                # Simulate list response
                mock_sock.recv.side_effect = [b'["item1", "item2"]\n', b'']

                status = get_session_status(session)
                self.assertIsNone(status)

    def test_accept_dict_response(self):
        """Dict response is accepted."""
        session = {
            "socket": "/tmp/test.sock",
            "token": "test-token",
        }

        with patch("monitor.validate_socket_path") as mock_validate:
            with patch("monitor.connect_to_socket") as mock_connect:
                mock_validate.return_value = True
                mock_sock = MagicMock()
                mock_connect.return_value.__enter__.return_value = mock_sock
                # Simulate dict response
                mock_sock.recv.side_effect = [
                    b'{"ok": true, "text": "status"}\n',
                    b'',
                ]

                status = get_session_status(session)
                self.assertIsNotNone(status)
                self.assertTrue(status.get("ok"))


class TestFormatSessionDisplay(unittest.TestCase):
    """Test formatting session display with verbatim status."""

    def test_format_unreachable(self):
        """Test formatting when socket is unreachable."""
        session = {
            "id": "test-1",
            "cwd": "/home/test",
            "leader": "claude",
        }

        output = format_session_display(session, None)
        self.assertIn("test-1", output)
        self.assertIn("claude", output)
        self.assertIn("Control plane unreachable", output)

    def test_format_status_format_unavailable(self):
        """Test formatting when status has no text."""
        session = {
            "id": "test-1",
            "cwd": "/home/test",
            "leader": "claude",
        }

        status = {"ok": True, "text": ""}
        output = format_session_display(session, status)
        self.assertIn("Status format unavailable", output)

    def test_format_verbatim_status_text(self):
        """Test that status text is rendered verbatim."""
        session = {
            "id": "test-1",
            "cwd": "/home/test",
            "leader": "claude",
        }

        status_text = """Neta status
Writer slot:
  worker-1

Terminal:
  worker-2"""

        status = {"ok": True, "text": status_text}
        output = format_session_display(session, status)

        # Verify status is preserved verbatim
        self.assertIn("Neta status", output)
        self.assertIn("Writer slot:", output)
        self.assertIn("Terminal:", output)


class TestSingleDisplayIteration(unittest.TestCase):
    """Test single display iteration function."""

    def setUp(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.sessions_dir = self.temp_path / "sessions"
        self.sessions_dir.mkdir()

    def tearDown(self):
        """Clean up."""
        self.temp_dir.cleanup()

    def test_does_not_hang_with_no_sessions(self):
        """Test that iteration completes quickly with no sessions."""
        start = time.time()
        single_display_iteration(self.temp_path)
        elapsed = time.time() - start
        # Should complete quickly (under 0.5 seconds)
        self.assertLess(elapsed, 0.5)


class TestHerdrPaneManagement(unittest.TestCase):
    """Test Herdr pane management functions."""

    def setUp(self):
        """Provide the plugin root Herdr supplies at runtime."""
        self.plugin_root = patch.dict(
            os.environ,
            {"HERDR_PLUGIN_ROOT": TEST_PLUGIN_ROOT},
        )
        self.plugin_root.start()

    def tearDown(self):
        """Restore the caller's environment."""
        self.plugin_root.stop()

    def test_get_herdr_panes_success(self):
        """Test successful pane listing with Herdr 0.8.2 envelope format."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout=json.dumps({"id": "cli:pane", "result": {"panes": [], "type": "pane_list"}})
            )
            result = get_herdr_panes()
            self.assertIsNotNone(result)
            # Should return the result envelope content
            self.assertEqual(result.get("panes"), [])

    def test_get_herdr_panes_failure(self):
        """Test pane listing failure."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1)
            result = get_herdr_panes()
            self.assertIsNone(result)

    def test_get_herdr_panes_timeout(self):
        """Test pane listing timeout."""
        with patch("subprocess.run") as mock_run:
            mock_run.side_effect = subprocess.TimeoutExpired("cmd", 5)
            result = get_herdr_panes()
            self.assertIsNone(result)

    def test_find_monitor_pane_zero_panes(self):
        """Test finding monitor pane when none exist."""
        with patch("monitor.get_herdr_panes") as mock_get:
            mock_get.return_value = {"panes": []}
            result = find_monitor_pane()
            self.assertIsNone(result)

    def test_find_monitor_pane_one_pane(self):
        """Test finding monitor pane when one exists."""
        with patch("monitor.get_herdr_panes") as mock_get:
            mock_get.return_value = {
                "panes": [
                    {
                        "pane_id": "wF:pJ",
                        "cwd": TEST_PLUGIN_ROOT,
                        "label": "Neta Monitor",
                    }
                ]
            }
            result = find_monitor_pane()
            self.assertEqual(result, "wF:pJ")

    def test_find_monitor_pane_multiple_panes(self):
        """Test finding monitor pane when multiple exist (returns first)."""
        with patch("monitor.get_herdr_panes") as mock_get:
            mock_get.return_value = {
                "panes": [
                    {
                        "pane_id": "wF:pJ",
                        "cwd": TEST_PLUGIN_ROOT,
                        "label": "Neta Monitor",
                    },
                    {
                        "pane_id": "wF:pK",
                        "cwd": TEST_PLUGIN_ROOT,
                        "label": "Neta Monitor",
                    },
                ]
            }
            result = find_monitor_pane()
            # Should return first one
            self.assertEqual(result, "wF:pJ")

    def test_find_monitor_pane_list_failure(self):
        """Test finding pane when listing fails."""
        with patch("monitor.get_herdr_panes") as mock_get:
            mock_get.return_value = None
            result = find_monitor_pane()
            self.assertIsNone(result)

    def test_find_all_monitor_panes_zero(self):
        """Test finding all panes when none exist."""
        with patch("monitor.get_herdr_panes") as mock_get:
            mock_get.return_value = {"panes": []}
            result = find_all_monitor_panes()
            self.assertEqual(result, [])

    def test_find_all_monitor_panes_multiple(self):
        """Test finding all monitor panes."""
        with patch("monitor.get_herdr_panes") as mock_get:
            mock_get.return_value = {
                "panes": [
                    {
                        "pane_id": "wF:pJ",
                        "cwd": TEST_PLUGIN_ROOT,
                        "label": "Neta Monitor",
                    },
                    {
                        "pane_id": "wF:pK",
                        "cwd": TEST_PLUGIN_ROOT,
                        "label": "Neta Monitor",
                    },
                ]
            }
            result = find_all_monitor_panes()
            self.assertEqual(result, ["wF:pJ", "wF:pK"])

    def test_get_herdr_panes_no_json_flag(self):
        """Test that herdr pane list is called WITHOUT --json flag."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout=json.dumps({"id": "cli:pane", "result": {"panes": []}})
            )
            get_herdr_panes()
            # Verify the command has no --json flag
            args = mock_run.call_args[0][0]
            self.assertIn("pane", args)
            self.assertIn("list", args)
            self.assertNotIn("--json", args)

    def test_close_monitor_pane_success(self):
        """Test successful pane close."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            result = close_monitor_pane("wF:pJ")
            self.assertTrue(result)
            args = mock_run.call_args[0][0]
            self.assertIn("pane", args)
            self.assertIn("close", args)
            self.assertIn("wF:pJ", args)

    def test_close_monitor_pane_failure(self):
        """Test failed pane close."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1)
            result = close_monitor_pane("wF:pJ")
            self.assertFalse(result)

    def test_focus_monitor_pane_success(self):
        """Test successful pane focus."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            result = focus_monitor_pane("pane-123")
            self.assertTrue(result)
            # Verify argv
            args = mock_run.call_args[0][0]
            self.assertIn("pane-123", args)

    def test_focus_monitor_pane_failure(self):
        """Test failed pane focus."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1)
            result = focus_monitor_pane("pane-123")
            self.assertFalse(result)

    def test_open_monitor_pane_success(self):
        """Test successful pane open."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            result = open_monitor_pane()
            self.assertTrue(result)

    def test_open_monitor_pane_failure(self):
        """Test failed pane open."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1)
            result = open_monitor_pane()
            self.assertFalse(result)


class TestEnsureMonitorPaneIdempotent(unittest.TestCase):
    """Test idempotent ensure_monitor_pane_open function."""

    def test_idempotent_pane_exists_focuses(self):
        """Test that existing pane is focused, not opened anew."""
        with patch("monitor.find_monitor_pane") as mock_find:
            with patch("monitor.focus_monitor_pane") as mock_focus:
                with patch("monitor.open_monitor_pane") as mock_open:
                    mock_find.return_value = "pane-123"
                    mock_focus.return_value = True

                    result = ensure_monitor_pane_open()

                    self.assertTrue(result)
                    mock_focus.assert_called_once_with("pane-123")
                    mock_open.assert_not_called()

    def test_idempotent_no_pane_opens(self):
        """Test that new pane is opened when none exists."""
        with patch("monitor.find_monitor_pane") as mock_find:
            with patch("monitor.focus_monitor_pane") as mock_focus:
                with patch("monitor.open_monitor_pane") as mock_open:
                    mock_find.return_value = None
                    mock_open.return_value = True

                    result = ensure_monitor_pane_open()

                    self.assertTrue(result)
                    mock_focus.assert_not_called()
                    mock_open.assert_called_once()

    def test_idempotent_find_fails_opens(self):
        """Test that pane is opened when finding fails (graceful degradation)."""
        with patch("monitor.find_monitor_pane") as mock_find:
            with patch("monitor.open_monitor_pane") as mock_open:
                mock_find.return_value = None  # Simulate failure to list
                mock_open.return_value = True

                result = ensure_monitor_pane_open()

                self.assertTrue(result)
                mock_open.assert_called_once()

    def test_idempotent_existing_focus_fails_still_succeeds(self):
        """Test that True is returned when pane exists, even if focus fails (idempotent)."""
        with patch("monitor.find_monitor_pane") as mock_find:
            with patch("monitor.focus_monitor_pane") as mock_focus:
                mock_find.return_value = "pane-123"
                mock_focus.return_value = False  # Focus fails

                result = ensure_monitor_pane_open()

                # Still returns True because pane exists (idempotent = no duplicate created)
                self.assertTrue(result)

    def test_idempotent_no_pane_open_fails_returns_false(self):
        """Test that False is returned when no pane exists and open fails."""
        with patch("monitor.find_monitor_pane") as mock_find:
            with patch("monitor.open_monitor_pane") as mock_open:
                mock_find.return_value = None
                mock_open.return_value = False

                result = ensure_monitor_pane_open()

                self.assertFalse(result)


class TestTokenNonDisclosure(unittest.TestCase):
    """Test that authentication tokens are never disclosed."""

    def setUp(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.sessions_dir = self.temp_path / "sessions"
        self.sessions_dir.mkdir()

    def tearDown(self):
        """Clean up."""
        self.temp_dir.cleanup()

    def test_registry_tokens_not_displayed(self):
        """Verify registry file tokens are never printed to output."""
        secret_token = "very-secret-registry-token-xyz"
        session_file = self.sessions_dir / "secret.json"
        session_file.write_text(json.dumps({
            "id": "secret-session",
            "socket": "/tmp/nonexistent.sock",
            "token": secret_token,
            "cwd": "/home/test",
            "leader": "claude",
            "pid": os.getpid(),
        }))
        session_file.chmod(0o600)

        sessions = load_session_registry(self.temp_path)
        self.assertEqual(len(sessions), 1)

        # Format the session (socket unreachable)
        output = format_session_display(sessions[0], None)

        # Token must not appear in output
        self.assertNotIn(secret_token, output)
        self.assertNotIn("registry-token", output)


if __name__ == "__main__":
    unittest.main()
