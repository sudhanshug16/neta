"""Exercise the attachment against a real Neta Node with the fake ACP provider."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from bridge import Bridge
from node_client import NodeClient


class LiveNodeTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_node_session_round_trip(self):
        repo = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="nt-", dir="/tmp") as directory:
            root = Path(directory)
            work = root / "workspace"
            work.mkdir()
            (root / "settings.json").write_text(json.dumps({
                "providers": {"fake": {"command": shutil.which("bun"), "args": [str(repo / "test/fixtures/fake-acp-agent.mjs")], "resume": True, "defaultModel": "test-model"}},
                "leader": {"provider": "fake", "model": "test-model"}, "forbiddenModels": [],
            }))
            with (root / "node.log").open("w") as log:
                process = await asyncio.create_subprocess_exec("bun", str(repo / "src/cli/main.ts"), "node", "start", env={**os.environ, "NETA_DIR": str(root)}, stdout=log, stderr=log)
                node = None
                bridge = None
                try:
                    for _ in range(200):
                        if (root / "node.json").exists():
                            break
                        await asyncio.sleep(0.05)
                    self.assertTrue((root / "node.json").exists(), (root / "node.log").read_text())
                    descriptor = json.loads((root / "node.json").read_text())
                    node = NodeClient(descriptor["socket"], descriptor["token"])
                    await node.connect()
                    opened = await node.request("workspace.open", {"path": str(work)})
                    session = opened["leader"]["sessionId"]
                    events = []
                    bridge = Bridge(descriptor["socket"], descriptor["token"], session, events.append)
                    await bridge.connect()
                    await bridge.dispatch("session/load", {"sessionId": session})
                    result = await asyncio.wait_for(bridge.dispatch("session/prompt", {"sessionId": session, "prompt": [{"type": "text", "text": "hello from Toad"}]}), 20)
                    self.assertEqual(result["stopReason"], "end_turn")
                    self.assertTrue(events)
                    tail = await node.request("conversation.tail", {"sessionId": session})
                    self.assertTrue(any(b["role"] == "user" and b["text"] == "hello from Toad" for b in tail["blocks"]))
                    streamed = "".join(e["params"]["update"]["content"]["text"] for e in events if e["params"]["update"]["sessionUpdate"] == "agent_message_chunk")
                    stored = "".join(b["text"] for b in tail["blocks"] if b["role"] == "agent" and b["kind"] == "text")
                    self.assertEqual(streamed, stored, "cumulative stream lost or duplicated text")
                    before = len(events)
                    await node.request("conversation.prompt", {"sessionId": session, "text": "sent by another client"})
                    for _ in range(100):
                        if len(events) > before:
                            break
                        await asyncio.sleep(0.05)
                    self.assertGreater(len(events), before, "idle client missed peer activity")
                    await bridge.close()
                    bridge = None
                    snapshot = await node.snapshot()
                    self.assertEqual(snapshot["leaders"][0]["sessionId"], session)
                finally:
                    if bridge:
                        await bridge.close()
                    if node:
                        await node.close()
                    process.terminate()
                    await asyncio.wait_for(process.wait(), 10)
