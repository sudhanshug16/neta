"""In-memory Node protocol fixture. No provider, shell, or repository writes."""
import asyncio
import json
import uuid


class FixtureNode:
    def __init__(self, socket, token="demo"):
        self.socket, self.token = socket, token
        self.history = {name: [{"turnId": "seed", "seq": 1, "role": "agent", "kind": "text", "text": f"## {title}\n\nThis conversation already exists on the demo Node. Type a message to stream a response.\n\nTry **slow** and press Escape to cancel.\n"}] for name, title in [("leader", "Workspace leader"), ("mission-1", "Build chat MVP"), ("mission-2", "Verify reconnect")]}
        self.clients = {}
        self.active = {}
        self.calls = []

    def snapshot(self):
        return {
            "machine": {"id": "local", "name": "Demo Node"},
            "workspaces": [{"id": "demo", "name": "neta"}],
            "leaders": [{"workspaceId": "demo", "sessionId": "leader", "name": "Leader", "state": "idle", "model": "fixture · no provider"}],
            "missions": [{"id": f"m{i}", "workspaceId": "demo", "number": i, "name": title, "createdAt": f"2026-09-10T14:0{i}:00Z", "state": "running"} for i, title in [(1, "Build chat MVP"), (2, "Verify reconnect")]],
            "agents": [{"id": f"a{i}", "missionId": f"m{i}", "workspaceId": "demo", "sessionId": f"mission-{i}", "name": name, "state": "running", "model": "fixture · no provider"} for i, name in [(1, "Sol"), (2, "Terra")]],
        }

    async def start(self):
        self.server = await asyncio.start_unix_server(self.client, path=self.socket)

    async def close(self):
        for task in self.active.values():
            task.cancel()
        await asyncio.gather(*self.active.values(), return_exceptions=True)
        for writer in list(self.clients):
            writer.close()
        self.server.close()
        await self.server.wait_closed()

    def send(self, writer, message):
        if not writer.is_closing():
            writer.write((json.dumps({"jsonrpc": "2.0", **message}) + "\n").encode())

    def broadcast(self, session, **event):
        for writer, subscribed in list(self.clients.items()):
            if subscribed == session:
                self.send(writer, {"method": "turn", "params": {"sessionId": session, **event}})

    def append(self, session, turn, role, text):
        block = {"turnId": turn, "seq": len(self.history[session]) + 1, "role": role, "kind": "text", "text": text}
        self.history[session].append(block)
        self.broadcast(session, block=block)

    async def stream(self, session, turn, text):
        cancelled = False
        try:
            self.append(session, turn, "user", text)
            response = f"## Reply from {session}\n\nYou wrote:\n\n> {text.replace(chr(10), chr(10) + '> ')}\n\nThe Node owns this conversation. Reopening the chat keeps its history.\n\n- Streaming Markdown\n- Independent session identity\n- Client disconnect does not stop the Node\n"
            for word in response.split(" "):
                await asyncio.sleep(0.12 if "slow" in text.lower() else 0.015)
                self.append(session, turn, "agent", word + " ")
        except asyncio.CancelledError:
            cancelled = True
        finally:
            self.broadcast(session, turn={"id": turn, "endedAt": "2026-09-10T00:00:00Z", "cancelled": cancelled})
            self.active.pop(session, None)

    async def client(self, reader, writer):
        authorized = False
        self.clients[writer] = None
        try:
            while line := await reader.readline():
                message = json.loads(line)
                method, params = message["method"], message.get("params", {})
                self.calls.append(method)
                try:
                    if method == "hello":
                        if params.get("token") != self.token:
                            raise ValueError("Unauthorized")
                        authorized = True
                        result = {"protocolVersion": 3}
                    elif not authorized:
                        raise ValueError("Unauthorized")
                    elif method == "snapshot":
                        result = self.snapshot()
                    elif method == "missions.list":
                        result = {"missions": self.snapshot()["missions"]}
                    elif method == "missions.get":
                        snapshot = self.snapshot()
                        result = {"mission": next(m for m in snapshot["missions"] if m["id"] == params["missionId"]), "agents": [a for a in snapshot["agents"] if a["missionId"] == params["missionId"]]}
                    else:
                        session = params["sessionId"]
                        if session not in self.history:
                            raise ValueError("Unknown session")
                        if method == "conversation.tail":
                            self.clients[writer] = session
                            result = {"blocks": self.history[session][-200:], "turns": [], "prevCursor": None}
                        elif method == "conversation.prompt":
                            if session in self.active:
                                raise ValueError("Session busy")
                            turn = uuid.uuid4().hex
                            result = {"turnId": turn}
                            self.active[session] = asyncio.create_task(self.stream(session, turn, params["text"]))
                        elif method == "conversation.cancel":
                            if task := self.active.get(session):
                                task.cancel()
                            result = {"sessionId": session}
                        else:
                            raise ValueError("Unsupported fixture method")
                    self.send(writer, {"id": message["id"], "result": result})
                except Exception as error:
                    self.send(writer, {"id": message["id"], "error": {"code": -32000, "message": str(error)}})
                await writer.drain()
        finally:
            self.clients.pop(writer, None)
            writer.close()
