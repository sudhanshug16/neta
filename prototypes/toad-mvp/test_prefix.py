"""Prefix input must be handled before focused composer bindings."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from toad.widgets.prompt import PromptTextArea

from app import NetaApp
from fixture import FixtureNode
from prefix import COMMANDS, PrefixHelp, prefix_key
from navigation import WorkspaceSwitcher


class PrefixTests(unittest.IsolatedAsyncioTestCase):
    async def test_prefix_from_composer_navigation_and_modal(self):
        with tempfile.TemporaryDirectory(prefix="np-", dir="/tmp") as directory:
            root = Path(directory)
            token = root / "token"
            token.write_text("demo")
            node = FixtureNode(str(root / "node.sock"))
            await node.start()
            environment = {key: str(root / key) for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME")}
            environment["NETA_TUI_PREFIX"] = "ctrl+b"
            try:
                with patch.dict(os.environ, environment):
                    app = NetaApp(node.socket, token, root)
                    async with app.run_test(size=(120, 40)) as pilot:
                        for _ in range(40):
                            await pilot.pause(0.1)
                            if app.screen.conversation.agent_ready:
                                break
                        composer = app.screen.query_one(PromptTextArea)
                        composer.load_text("keep my draft")
                        composer.focus()
                        await pilot.press("ctrl+b")
                        self.assertTrue(app.prefix_active)
                        await pilot.press("g")
                        self.assertTrue(app.screen.query_one("#neta-spine").has_focus_within)
                        self.assertFalse(app.prefix_active)
                        self.assertEqual(composer.text, "keep my draft")
                        await pilot.press("ctrl+b", "l")
                        self.assertTrue(composer.has_focus)
                        # Escape cancels prefix, without cancelling a Node reply.
                        await pilot.press("ctrl+b", "escape")
                        self.assertNotIn("conversation.cancel", node.calls)
                        # Unknown command and Enter are consumed, not typed/sent.
                        await pilot.press("ctrl+b", "u", "ctrl+b", "enter")
                        self.assertEqual(composer.text, "keep my draft")
                        self.assertNotIn("conversation.prompt", node.calls)
                        # Double prefix passes through without toggling sidebar.
                        await pilot.press("ctrl+b", "ctrl+b")
                        self.assertFalse(app.prefix_active)
                        self.assertTrue(composer.has_focus)
                        app.command_prefix = "f12"
                        await pilot.press("f12", "w")
                        self.assertIsInstance(app.screen, WorkspaceSwitcher)
                        await pilot.press("n", "escape")
                        app.command_prefix = "ctrl+b"
                        self.assertEqual(app.screen.query_one(PromptTextArea).text, "keep my draft")
                        await pilot.press("ctrl+b", "left_shift", "right_shift", "left_control")
                        self.assertTrue(app.prefix_active)
                        await pilot.press("?")
                        self.assertIsInstance(app.screen, PrefixHelp)
                        self.assertEqual(len(app.screen.query("Button")), len(COMMANDS))
                        # Selecting help's navigation command restores the screen first.
                        await pilot.click("#prefix-command-2")
                        await pilot.pause(0.2)
                        self.assertTrue(app.screen.query_one("#neta-spine").has_focus_within)
                        await app.attach("mission-1")
                        await pilot.pause(0.3)
                        await pilot.press("ctrl+b", "1")
                        self.assertEqual(app.selected, "leader")
                        await pilot.press("ctrl+b", "n")
                        self.assertEqual(app.selected, "mission-1")
                        await pilot.press("ctrl+b", "p")
                        self.assertEqual(app.selected, "leader")
                        await pilot.press("ctrl+b", "n", "ctrl+b", "X")
                        self.assertEqual(app.selected, "leader")
                        self.assertNotIn("mission-1", app.visible_tabs())
                        self.assertNotIn("conversation.cancel", node.calls)
                        old_agent = app.screen.conversation.agent
                        await pilot.press("ctrl+b", "r")
                        for _ in range(40):
                            await pilot.pause(0.1)
                            if app.screen.conversation.agent_ready:
                                break
                        self.assertIsNot(app.screen.conversation.agent, old_agent)
                        self.assertTrue(app.screen.conversation.agent_ready)
                        await pilot.press("ctrl+b", "a")
                        self.assertTrue(app.show_archive)
                        await pilot.press("ctrl+b", "f")
                        self.assertEqual(app.state_filter, "needs you")
                        await pilot.press("ctrl+b", "q")
                    self.assertFalse(app.is_running)
            finally:
                await node.close()

    async def test_configurable_prefix(self):
        with patch.dict(os.environ, {"NETA_TUI_PREFIX": "ctrl+a"}):
            self.assertEqual(prefix_key(), "ctrl+a")
        with patch.dict(os.environ, {"NETA_TUI_PREFIX": "f12"}):
            self.assertEqual(prefix_key(), "f12")
        with patch.dict(os.environ, {"NETA_TUI_PREFIX": "space"}):
            with self.assertRaises(ValueError):
                prefix_key()

class ResetTests(unittest.IsolatedAsyncioTestCase):
    async def test_reset_replaces_leader_and_only_neta_command_is_suggested(self):
        from unittest.mock import AsyncMock, patch
        from types import SimpleNamespace
        from toad.widgets.prompt import PromptTextArea
        with tempfile.TemporaryDirectory(prefix="nreset-", dir="/tmp") as directory:
            root = Path(directory)
            fixture = FixtureNode(str(root / "node.sock"))
            await fixture.start()
            token = root / "token"
            token.write_text("demo")
            environment = {key: str(root / key) for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME")}
            try:
                with patch.dict(os.environ, environment):
                    app = NetaApp(fixture.socket, token, root)
                    async with app.run_test(size=(120, 44)) as pilot:
                        await pilot.pause(0.5)
                        commands = app.screen.conversation._build_slash_commands()
                        self.assertEqual([command.command for command in commands], ["/reset"])
                        app.snapshot["workspaces"][0]["roots"] = [{"machineId": app.snapshot["machine"]["id"], "path": str(root)}]
                        snapshot = fixture.snapshot()
                        snapshot["leaders"][0]["sessionId"] = "replacement"
                        node = SimpleNamespace(request=AsyncMock(side_effect=[{"leader": {"sessionId": "revived"}}, {"sessionId": "replacement"}]), snapshot=AsyncMock(return_value=snapshot))
                        app.node = node
                        with patch.object(app, "attach", new_callable=AsyncMock) as attach:
                            app.screen.query_one(PromptTextArea).load_text("/reset")
                            await pilot.press("enter")
                            await pilot.pause(0.3)
                            self.assertEqual(node.request.await_args_list[0].args, ("workspace.open", {"path": str(root)}))
                            self.assertEqual(node.request.await_args_list[1].args, ("conversation.reset", {"sessionId": "revived"}))
                            self.assertEqual(node.request.await_count, 2)
                            attach.assert_awaited_once_with("replacement")
                            self.assertEqual(app.visible_tabs(), ["replacement"])
                            leaders = [record for record in app.sessions.values() if record.get("leader") and record["_host"] == app.host_id]
                            self.assertEqual(len(leaders), 1)
                            rows = list(app.screen.spine_rows())
                            leader_buttons = [row for row in rows if getattr(row, "id", None) in app.buttons and app.buttons[row.id] in ("leader", "replacement")]
                            self.assertEqual(len(leader_buttons), 1)
                            self.assertEqual(app.buttons[leader_buttons[0].id], "replacement")
                            app.index_snapshot()
                            self.assertEqual(app.visible_tabs(), ["replacement"])
                        self.assertNotIn("conversation.prompt", fixture.calls)
                        app.node = None
            finally:
                await fixture.close()
