import asyncio
import json
import os
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

from textual.widgets import Input, Static
from toad.widgets.prompt import PromptTextArea
from app import NetaApp
from fixture import FixtureNode
from machines import HostRegistry, MachinesScreen, RemoteConnection, remote_path
from node_client import NodeClient


def host(**changes):
    return {"id": "remote", "displayName": "Remote", "sshDestination": "runner@example", "remoteNetaDir": "~/.neta", **changes}


class RegistryTests(unittest.TestCase):
    def test_persistence_preserves_profiles_and_rejects_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = HostRegistry(directory)
            existing = host(sshConfig="/tmp/config", remoteLauncher={"executable": "node", "args": ["neta.js"]})
            registry.save(existing)
            registry.save(host(id="other", sshDestination="another"))
            self.assertEqual(registry.load()[0], existing)
            self.assertEqual(registry.path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError):
                registry.save(host(id="duplicate", sshConfig="/tmp/config"))
            with self.assertRaises(ValueError):
                registry.save(host(sshDestination="-oProxyCommand=bad"))
            registry.path.write_text("broken")
            with self.assertRaises(ValueError):
                registry.save(host())
            self.assertEqual(registry.path.read_text(), "broken")

    def test_remote_paths_are_shell_quoted(self):
        self.assertEqual(remote_path("~/.neta"), '"$HOME"/.neta')
        self.assertEqual(remote_path("/tmp/a b"), "'/tmp/a b'")
        self.assertIn("'", remote_path("/tmp/$(false)"))


class MachineUITests(unittest.IsolatedAsyncioTestCase):
    async def test_add_switch_return_preserves_identity_and_drafts(self):
        with tempfile.TemporaryDirectory(prefix="nm-", dir="/tmp") as directory:
            root = Path(directory)
            local = FixtureNode(str(root / "local.sock"))
            remote = FixtureNode(str(root / "remote.sock"))
            await local.start()
            await remote.start()
            token = root / "token"
            token.write_text("demo")
            nodes = []
            class FakeRemote:
                def __init__(self, profile):
                    self.socket, self.token_file = remote.socket, token
                async def connect(self):
                    self.node = NodeClient(remote.socket, "demo")
                    await self.node.connect()
                    nodes.append(self.node)
                    snapshot = remote.snapshot()
                    snapshot["machine"] = {"id": "remote", "name": "Remote machine"}
                    # Persisted leaders can outlive their workspace. The first
                    # leader must not be selected blindly on machine switch.
                    snapshot["leaders"].insert(0, {**snapshot["leaders"][0], "sessionId": "orphan", "workspaceId": "removed-workspace"})
                    async def read_snapshot():
                        return snapshot
                    self.node.snapshot = read_snapshot
                    return snapshot
                async def close(self):
                    await self.node.close()
            environment = {key: str(root / key) for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "NETA_DIR")}
            try:
                with patch.dict(os.environ, {**environment, "NETA_TUI_PREFIX": "ctrl+b"}), patch("app.RemoteConnection", FakeRemote):
                    app = NetaApp(local.socket, token, root, state_file=root / "tui-view.json")
                    async with app.run_test(size=(120, 44)) as pilot:
                        for _ in range(30):
                            await pilot.pause(0.1)
                            if app.screen.conversation.agent_ready:
                                break
                        app.screen.query_one(PromptTextArea).load_text("local draft")
                        await pilot.press("ctrl+b", "left_shift", "M")
                        self.assertIsInstance(app.screen, MachinesScreen)
                        app.screen.query_one("#machine-name", Input).value = "Remote"
                        app.screen.query_one("#machine-destination", Input).value = "runner@example"
                        await pilot.click("#machine-save")
                        await pilot.pause(0.6)
                        self.assertTrue(app.host_id.startswith("ssh:"))
                        self.assertNotEqual(app.selected, "leader")
                        self.assertEqual(app.screen.conversation.agent.session_id, "leader")
                        self.assertEqual(len(app.visible_tabs()), 1)
                        self.assertNotEqual(app.workspace_name, "Unavailable workspace")
                        await app.attach(app.session_key("orphan"))
                        self.assertEqual(app.screen.conversation.agent.session_id, "leader")
                        app.screen.query_one(PromptTextArea).load_text("remote draft")
                        await pilot.press("ctrl+b", "m")
                        self.assertIsInstance(app.screen, MachinesScreen)
                        await pilot.click("#machine-local")
                        await pilot.pause(0.3)
                        self.assertEqual(app.selected, "leader")
                        self.assertEqual(app.screen.query_one(PromptTextArea).text, "local draft")
                        await pilot.press("ctrl+b", "M")
                        await pilot.click("#machine-0")
                        await pilot.pause(0.3)
                        self.assertEqual(app.screen.query_one(PromptTextArea).text, "remote draft")
                        self.assertNotIn("conversation.prompt", remote.calls)
                        self.assertNotIn("conversation.cancel", local.calls)
                        self.assertEqual(len(app.host_registry.load()), 1)
                        saved = json.loads((root / "tui-view.json").read_text())
                        self.assertEqual(saved["host"], app.host_id)
                        self.assertEqual(saved["workspace"], app.workspace_id)
                        self.assertEqual(saved["session"], "leader")
                    await app.close_machines()
            finally:
                await remote.close()
                await local.close()

class SSHTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_ssh_forwarding_and_disconnect_keep_owner_alive(self):
        # A fake ssh executable forwards real Unix sockets. This tests the
        # client transport without connecting to a user's machine or provider.
        with tempfile.TemporaryDirectory(prefix="ns-", dir="/tmp") as directory:
            root = Path(directory)
            node = FixtureNode(str(root / "owner.sock"))
            await node.start()
            descriptor = root / "descriptor.json"
            descriptor.write_text(json.dumps({"socket": node.socket, "token": "demo", "protocolVersion": 3}))
            script = root / "fake_ssh.py"
            script.write_text('''import asyncio, os, sys
from pathlib import Path
async def main():
    if "-N" not in sys.argv:
        sys.stdout.write(Path(os.environ["TEST_DESCRIPTOR"]).read_text())
        return
    local, remote = sys.argv[sys.argv.index("-L") + 1].split(":", 1)
    async def accept(reader, writer):
        upstream, target = await asyncio.open_unix_connection(remote)
        async def pump(source, sink):
            try:
                while data := await source.read(65536):
                    sink.write(data)
                    await sink.drain()
            finally:
                sink.close()
        await asyncio.gather(pump(reader, target), pump(upstream, writer))
    server = await asyncio.start_unix_server(accept, path=local)
    async with server:
        await server.serve_forever()
asyncio.run(main())
''')
            connection = RemoteConnection(host())
            self.assertIn("BatchMode=yes", connection.ssh_args())
            self.assertIn("ForwardAgent=no", connection.ssh_args())
            try:
                with patch.dict(os.environ, {"TEST_DESCRIPTOR": str(descriptor)}), patch.object(connection, "ssh_args", return_value=[sys.executable, str(script)]):
                    snapshot = await connection.connect()
                    self.assertEqual(snapshot["leaders"][0]["sessionId"], "leader")
                    history = await connection.node.request("conversation.tail", {"sessionId": "leader"})
                    self.assertTrue(history["blocks"])
                    self.assertEqual(connection.token_file.stat().st_mode & 0o777, 0o600)
                await connection.close()
                self.assertIsNotNone(connection.tunnel.returncode)
                observer = NodeClient(node.socket, "demo")
                await observer.connect()
                await observer.request("conversation.tail", {"sessionId": "leader"})
                await observer.close()
                self.assertNotIn("conversation.cancel", node.calls)
                self.assertNotIn("node.stop", node.calls)
            finally:
                await connection.close()
                await node.close()
