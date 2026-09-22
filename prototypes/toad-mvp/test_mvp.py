import asyncio
import os
from pathlib import Path
import tempfile
import unittest

from app import NetaApp
from bridge import Bridge
from fixture import FixtureNode
from toad.widgets.prompt import PromptTextArea


class MVPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="neta-test-")
        self.root = Path(self.directory.name)
        self.previous = {"NO_COLOR": os.environ.pop("NO_COLOR", None)}
        for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
            self.previous[key] = os.environ.get(key)
            os.environ[key] = str(self.root / key)
        self.token = self.root / "token"
        self.token.write_text("demo")
        self.node = FixtureNode(str(self.root / "node.sock"))
        await self.node.start()

    async def asyncTearDown(self):
        await self.node.close()
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.directory.cleanup()

    async def test_attachment_stream_cancel_reconnect(self):
        events = []
        bridge = Bridge(self.node.socket, "demo", "leader", events.append)
        await bridge.connect()
        try:
            with self.assertRaises(ValueError):
                await bridge.dispatch("session/new", {})
            with self.assertRaises(ValueError):
                await bridge.dispatch("session/load", {"sessionId": "wrong"})
            await bridge.dispatch("session/load", {"sessionId": "leader"})
            self.assertIn("already exists", events[0]["params"]["update"]["content"]["text"])
            result = await asyncio.wait_for(bridge.dispatch("session/prompt", {"sessionId": "leader", "prompt": [{"type": "text", "text": "hello"}]}), 5)
            self.assertEqual(result["stopReason"], "end_turn")
            prompt = asyncio.create_task(bridge.dispatch("session/prompt", {"sessionId": "leader", "prompt": [{"type": "text", "text": "slow"}]}))
            await asyncio.sleep(0.3)
            await bridge.dispatch("session/cancel", {"sessionId": "leader"})
            self.assertEqual((await asyncio.wait_for(prompt, 3))["stopReason"], "cancelled")
        finally:
            await bridge.close()
        replay = []
        replacement = Bridge(self.node.socket, "demo", "leader", replay.append)
        await replacement.connect()
        try:
            await replacement.dispatch("session/load", {"sessionId": "leader"})
            self.assertTrue(any(e["params"]["update"]["content"]["text"] == "hello" for e in replay))
            self.assertEqual(set(self.node.history), {"leader", "mission-1", "mission-2"})
            self.assertNotIn("session/new", self.node.calls)
        finally:
            await replacement.close()

    async def test_real_toad_ui(self):
        app = NetaApp(self.node.socket, self.token, self.root)
        async with app.run_test(size=(120, 40)) as pilot:
            for _ in range(30):
                await pilot.pause(0.1)
                if app.screen.conversation.agent_ready:
                    break
            self.assertTrue(app.screen.conversation.agent_ready)
            composer = app.screen.query_one(PromptTextArea)
            composer.load_text("hello\nfrom the composer")
            self.assertEqual(composer.text, "hello\nfrom the composer")
            await pilot.click("#mission-1")
            await pilot.pause(0.5)
            self.assertEqual(app.selected, "mission-1")
            self.assertEqual(app.screen.conversation.agent.session_id, "mission-1")
            await app.attach("leader")
            await pilot.pause(0.2)
            self.assertEqual(app.screen.query_one(PromptTextArea).text, "hello\nfrom the composer")
            app.screen.query_one(PromptTextArea).load_text("hello")
            app.screen.query_one(PromptTextArea).action_submit()
            for _ in range(60):
                await pilot.pause(0.1)
                if any(block["role"] == "user" for block in self.node.history["leader"]) and "leader" not in self.node.active:
                    break
            self.assertTrue(any(block["role"] == "user" and block["text"] == "hello" for block in self.node.history["leader"]))
            self.assertNotIn("leader", self.node.active)
            app.screen.query_one(PromptTextArea).load_text("slow")
            app.screen.query_one(PromptTextArea).focus()
            app.screen.query_one(PromptTextArea).action_submit()
            for _ in range(20):
                await pilot.pause(0.1)
                if "leader" in self.node.active:
                    break
            self.assertIn("leader", self.node.active)
            await pilot.press("escape")
            for _ in range(20):
                await pilot.pause(0.1)
                if "leader" not in self.node.active and not app.screen.conversation.busy_count:
                    break
            self.assertNotIn("leader", self.node.active)
            self.assertIn("conversation.cancel", self.node.calls)
            await app.attach("leader", reconnect=True)
            for _ in range(30):
                await pilot.pause(0.1)
                if app.screen.conversation.agent is not None and app.screen.conversation.agent_ready:
                    break
            self.assertEqual(app.screen.conversation.agent.session_id, "leader")
            self.assertTrue(app.screen.conversation.agent_ready)
            self.assertFalse(app.screen.conversation._agent_fail)
            await pilot.pause(0.5)
            paragraphs = [widget for widget in app.screen.query("MarkdownParagraph") if 2 < widget.region.y < 34]
            self.assertTrue(paragraphs)
            paragraph = paragraphs[-1]
            await pilot.mouse_down(offset=(paragraph.region.x + 2, paragraph.region.y))
            await pilot.hover(offset=(3, 3))
            await pilot.mouse_up(offset=(3, 3))
            selected = app.screen.get_selected_text() or ""
            self.assertTrue(selected)
            self.assertNotIn("Local UI", selected)
            self.assertNotIn("Build chat MVP", selected)
            app.screen.clear_selection()
            await pilot.pause(0.2)
            app.save_screenshot(str(Path(__file__).with_name("preview.svg")))

    async def test_disconnect_does_not_cancel_node_turn(self):
        bridge = Bridge(self.node.socket, "demo", "mission-2", lambda event: None)
        await bridge.connect()
        await bridge.dispatch("session/load", {"sessionId": "mission-2"})
        prompt = asyncio.create_task(bridge.dispatch("session/prompt", {"sessionId": "mission-2", "prompt": [{"type": "text", "text": "survive disconnect"}]}))
        await asyncio.sleep(0.1)
        self.assertIn("mission-2", self.node.active)
        await bridge.close()
        with self.assertRaises(ConnectionError):
            await asyncio.wait_for(prompt, 2)
        for _ in range(30):
            if "mission-2" not in self.node.active:
                break
            await asyncio.sleep(0.1)
        self.assertNotIn("mission-2", self.node.active)
        self.assertNotIn("conversation.cancel", self.node.calls)
        self.assertTrue(self.node.history["mission-2"][-1]["text"].strip())

    async def test_workspace_switcher_and_archived_view(self):
        snapshot = self.node.snapshot()
        snapshot["missions"][1]["state"] = "closed"
        snapshot["agents"][1]["state"] = "archived"
        snapshot["workspaces"].append({"id": "second", "name": "Another workspace"})
        snapshot["leaders"].append({"workspaceId": "second", "sessionId": "second-leader", "name": "Mace", "state": "idle", "model": "fixture"})
        self.node.history["second-leader"] = list(self.node.history["leader"])
        app = NetaApp(self.node.socket, self.token, self.root, snapshot)
        async with app.run_test(size=(144, 43)) as pilot:
            for _ in range(40):
                await pilot.pause(0.1)
                if app.screen.conversation.agent_ready:
                    break
            self.assertTrue(app.screen.conversation.agent_ready)
            await pilot.pause(0.6)
            self.assertGreaterEqual(app.screen.conversation.window.scroll_offset.y, 0)
            paragraphs = list(app.screen.query("MarkdownParagraph"))
            self.assertTrue(paragraphs)
            self.assertLess(paragraphs[0].region.y, 20)
            prompt = app.screen.query_one(PromptTextArea)
            self.assertGreater(prompt.region.height, 0)
            app.save_screenshot(str(Path(__file__).with_name("design-live.svg")))
            self.assertLess(prompt.region.bottom, app.screen.size.height, [(w.css_identifier, str(w.region)) for w in app.screen.query("#neta-body, #chat-shell, Center, Conversation, Prompt, #neta-footer")])
            app.save_screenshot(str(Path(__file__).with_name("design-live.svg")))
            await pilot.press("ctrl+k")
            await pilot.pause(0.2)
            app.save_screenshot(str(Path(__file__).with_name("design-switcher.svg")))
            await pilot.click("#workspace-1")
            await pilot.pause(0.5)
            self.assertEqual(app.workspace_id, "second")
            await app.choose_workspace("demo")
            await pilot.pause(0.2)
            await pilot.click("#archives")
            await pilot.pause(0.2)
            self.assertTrue(app.show_archive)
            await pilot.click("#mission-2")
            for _ in range(40):
                await pilot.pause(0.1)
                if app.screen.conversation.agent_ready:
                    break
            self.assertTrue(app.screen.conversation.has_class("archived"))
            self.assertFalse(app.screen.query_one("Prompt").display)
            before = self.node.calls.count("conversation.prompt")
            app.screen.query_one(PromptTextArea).load_text("should not send")
            app.screen.query_one(PromptTextArea).action_submit()
            await pilot.pause(0.2)
            self.assertEqual(self.node.calls.count("conversation.prompt"), before)
            app.save_screenshot(str(Path(__file__).with_name("design-archive.svg")))
            await pilot.click("#export-run")
            await pilot.pause(0.2)
            exports = list(self.root.glob("neta-run-*.json"))
            self.assertEqual(len(exports), 1)
            self.assertIn("Verify reconnect", exports[0].read_text())
            await pilot.click("#follow-up")
            await pilot.pause(0.2)
            self.assertEqual(app.selected, "leader")
            self.assertIn("follow-up mission", app.screen.query_one(PromptTextArea).text)
            self.assertEqual(self.node.calls.count("conversation.prompt"), before)
            await app.attach("mission-2")
            await pilot.pause(0.2)
            await pilot.press("ctrl+w")
            await pilot.pause(0.2)
            self.assertEqual(app.selected, "leader")
            self.assertNotIn("mission-2", app.visible_tabs())


if __name__ == "__main__":
    unittest.main()

class ProtocolRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def test_cumulative_blocks_and_tool_updates(self):
        events = []
        bridge = Bridge("unused", "unused", "s", events.append)
        base = {"turnId": "turn", "seq": 1, "role": "agent", "kind": "text"}
        bridge.block({**base, "text": "hello"})
        bridge.block({**base, "text": "hello world"})
        bridge.block({**base, "text": "hello world"})
        self.assertEqual("".join(e["params"]["update"]["content"]["text"] for e in events), "hello world")
        bridge.block({**base, "seq": 2, "kind": "tool", "text": "Run tests", "data": {"toolCallId": "t", "status": "in_progress"}})
        bridge.block({**base, "seq": 2, "kind": "tool", "text": "Run tests", "data": {"toolCallId": "t", "status": "completed"}})
        self.assertEqual(events[-1]["params"]["update"]["sessionUpdate"], "tool_call_update")
        self.assertEqual(events[-1]["params"]["update"]["status"], "completed")

    async def test_archived_bridge_rejects_mutations(self):
        bridge = Bridge("unused", "unused", "s", lambda event: None)
        bridge.read_only = True
        bridge.loaded = True
        for method in ("session/prompt", "session/cancel"):
            with self.assertRaisesRegex(ValueError, "Archived"):
                await bridge.dispatch(method, {"sessionId": "s"})

    async def test_queued_prompt_follows_inbox_turn(self):
        bridge = Bridge("unused", "unused", "s", lambda event: None)
        bridge.loaded = True
        async def request(method, params):
            return {"messageId": "message", "status": "queued"}
        bridge.request = request
        prompt = asyncio.create_task(bridge.dispatch("session/prompt", {"sessionId": "s", "prompt": [{"type": "text", "text": "queued"}]}))
        await asyncio.sleep(0)
        bridge.notification({"method": "turn", "params": {"sessionId": "s", "turn": {"id": "turn", "endedAt": "now"}}})
        bridge.notification({"method": "turn", "params": {"sessionId": "s", "inbox": {"id": "message", "status": "delivered", "turnId": "turn"}}})
        self.assertEqual((await asyncio.wait_for(prompt, 1))["stopReason"], "end_turn")

    async def test_history_pages_and_reconnect_replay(self):
        blocks = [{"turnId": "turn", "seq": seq, "role": "agent", "kind": "text", "text": str(seq) + " "} for seq in range(1, 206)]
        with tempfile.TemporaryDirectory() as directory:
            cursor = Path(directory) / "cursor"
            events = []
            bridge = Bridge("unused", "unused", "s", events.append, cursor)
            async def request(method, params):
                end = int(params.get("cursor", len(blocks)))
                start = max(0, end - 200)
                return {"blocks": blocks[start:end], "turns": [], "prevCursor": str(start) if start else None}
            bridge.request = request
            await bridge.dispatch("session/load", {"sessionId": "s"})
            self.assertEqual(len(events), 205)
            self.assertEqual(events[0]["params"]["update"]["content"]["text"], "1 ")
            replay = []
            replacement = Bridge("unused", "unused", "s", replay.append, cursor)
            replacement.request = request
            await replacement.dispatch("session/load", {"sessionId": "s"})
            self.assertEqual(replay, [])
            replacement.block({**blocks[-1], "text": "205 more"})
            self.assertEqual(replay[0]["params"]["update"]["content"]["text"], "more")


class ErrorContextTests(unittest.TestCase):
    def test_auth_status_retains_cause_and_identifies_remote_recovery(self):
        messages = []
        bridge = Bridge("unused", "unused", "session-123", messages.append, context={"machine": "remote-machine", "provider": "pi", "model": "sonnet"})
        cause = "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed"
        bridge.block({"seq": 1, "turnId": "turn", "role": "agent", "kind": "status", "text": cause})
        text = messages[0]["params"]["update"]["content"]["text"]
        for expected in (cause, "remote-machine", "pi", "sonnet", "session-123", "account that runs Neta", "Signing in only on your local machine"):
            self.assertIn(expected, text)
        self.assertNotIn("authentication failed", bridge.error_details("Connection refused"))


class ReplyHelpTests(unittest.IsolatedAsyncioTestCase):
    async def test_copy_and_restore_do_not_send(self):
        from navigation import ReplyHelp
        from textual.app import App
        class HelpApp(App):
            def on_mount(self):
                self.push_screen(ReplyHelp("Provider failed: model unavailable", "original message"), self.exit)
        app = HelpApp()
        async with app.run_test(size=(100, 40)) as pilot:
            await pilot.click("#copy-error")
            self.assertEqual(app.clipboard, "Provider failed: model unavailable")
            await pilot.click("#restore-message")
        self.assertEqual(app.return_value, "original message")


class SessionFooterTests(unittest.IsolatedAsyncioTestCase):
    async def test_footer_uses_owner_paths_instead_of_launch_directory(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory(prefix="nf-", dir="/tmp") as directory:
            root = Path(directory)
            fixture = FixtureNode(str(root / "node.sock"))
            await fixture.start()
            token = root / "token"
            token.write_text("demo")
            snapshot = fixture.snapshot()
            snapshot["workspaces"][0].update(name="noscrubs", roots=[{"machineId": snapshot["machine"]["id"], "path": "/remote/workspace/noscrubs"}])
            snapshot["missions"][0]["worktree"] = {"path": "/remote/workspace/noscrubs/.worktrees/4041"}
            environment = {key: str(root / key) for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME")}
            try:
                with patch.dict(os.environ, environment):
                    app = NetaApp(fixture.socket, token, root, snapshot)
                    async with app.run_test(size=(120, 44)) as pilot:
                        await pilot.pause(0.5)
                        self.assertEqual(app.session_folder(), "/remote/workspace/noscrubs")
                        self.assertFalse(app.screen.query_one("#info-container").display)
                        agent = next(agent for agent in snapshot["agents"] if agent["missionId"] == snapshot["missions"][0]["id"])
                        await app.attach(agent["sessionId"])
                        await pilot.pause(0.3)
                        self.assertEqual(app.session_folder(), "/remote/workspace/noscrubs/.worktrees/4041")
                        self.assertIn("noscrubs", app.screen.title)
                        await app.attach("leader")
                        self.assertEqual(app.session_folder(), "/remote/workspace/noscrubs")
                        self.assertIn("/remote/workspace/noscrubs", str(app.screen.query_one("#session-folder").render()))
                        app.save_screenshot(str(root / "footer.svg"))
            finally:
                await fixture.close()
