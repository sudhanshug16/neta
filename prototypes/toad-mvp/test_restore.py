import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from app import NetaApp
from fixture import FixtureNode


class RestoreTests(unittest.IsolatedAsyncioTestCase):
    async def test_reopen_remembers_workspace_and_missing_session_uses_current_leader(self):
        with tempfile.TemporaryDirectory(prefix="nv-", dir="/tmp") as directory:
            root = Path(directory)
            node = FixtureNode(str(root / "node.sock"))
            await node.start()
            token = root / "token"
            token.write_text("demo")
            state_file = root / "state" / "tui-view.json"
            snapshot = node.snapshot()
            snapshot["workspaces"].append({"id": "noscrubs", "name": "noscrubs", "roots": [{"machineId": snapshot["machine"]["id"], "path": "/remote/noscrubs"}]})
            snapshot["leaders"].append({"workspaceId": "noscrubs", "sessionId": "other-leader", "name": "Mace", "state": "idle", "model": "fixture"})
            node.history["other-leader"] = list(node.history["leader"])
            environment = {key: str(root / key) for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME")}
            try:
                with patch.dict(os.environ, environment):
                    app = NetaApp(node.socket, token, root, snapshot, state_file=state_file)
                    async with app.run_test(size=(144, 43)) as pilot:
                        await pilot.pause(0.4)
                        await app.choose_workspace("noscrubs")
                        self.assertEqual(json.loads(state_file.read_text())["workspace"], "noscrubs")
                        self.assertEqual(state_file.stat().st_mode & 0o777, 0o600)
                    saved = json.loads(state_file.read_text())
                    saved["session"] = "retired-session"
                    state_file.write_text(json.dumps(saved))
                    reopened = NetaApp(node.socket, token, root, snapshot, state_file=state_file)
                    async with reopened.run_test(size=(144, 43)) as pilot:
                        await pilot.pause(0.5)
                        self.assertEqual(reopened.workspace_id, "noscrubs")
                        self.assertEqual(reopened.selected, "other-leader")
                        self.assertIn("/remote/noscrubs", str(reopened.screen.query_one("#session-folder").render()))
                        reopened.save_screenshot(str(Path(__file__).with_name("design-restored.svg")))
                    self.assertNotIn("conversation.prompt", node.calls)
            finally:
                await node.close()
