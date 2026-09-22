"""Public Node RPC transport. Disconnecting never stops the owning Node."""
import asyncio
import json


class NodeClient:
    def __init__(self, socket, token):
        self.socket, self.token = socket, token
        self.pending = {}
        self.serial = 0
        self.listeners = []

    async def connect(self):
        self.reader, self.writer = await asyncio.open_unix_connection(self.socket, limit=8 * 1024 * 1024)
        self.pump = asyncio.create_task(self.read_node())
        await self.request("hello", {"token": self.token, "client": "cli", "protocolVersion": 3})

    async def read_node(self):
        try:
            while line := await self.reader.readline():
                message = json.loads(line)
                if "id" in message:
                    future = self.pending.get(message["id"])
                    if future and not future.done():
                        if "error" in message:
                            future.set_exception(RuntimeError(message["error"]["message"]))
                        else:
                            future.set_result(message.get("result", {}))
                else:
                    for listener in self.listeners:
                        listener(message)
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("Node disconnected; reconnect to reload history"))
            for listener in self.listeners:
                listener({"method": "disconnected"})

    async def request(self, method, params):
        self.serial += 1
        serial = self.serial
        future = asyncio.get_running_loop().create_future()
        self.pending[serial] = future
        try:
            self.writer.write((json.dumps({"jsonrpc": "2.0", "id": serial, "method": method, "params": params}) + "\n").encode())
            await self.writer.drain()
            return await asyncio.wait_for(future, 30)
        finally:
            self.pending.pop(serial, None)

    async def close(self):
        self.writer.close()
        await self.writer.wait_closed()
        await self.pump

    async def snapshot(self):
        snapshot = await self.request("snapshot", {})
        missions = {mission["id"]: mission for mission in snapshot["missions"]}
        for workspace in snapshot["workspaces"]:
            cursor = None
            while True:
                params = {"workspaceId": workspace["id"], "limit": 100}
                if cursor is not None:
                    params["cursor"] = cursor
                page = await self.request("missions.list", params)
                missions.update((mission["id"], mission) for mission in page["missions"])
                following = page.get("nextCursor")
                if following is None or following == cursor:
                    break
                cursor = following
        snapshot["missions"] = list(missions.values())
        agents = {agent["id"]: agent for agent in snapshot["agents"]}
        for mission in snapshot["missions"]:
            detail = await self.request("missions.get", {"missionId": mission["id"]})
            agents.update((agent["id"], agent) for agent in detail["agents"])
        snapshot["agents"] = list(agents.values())
        return snapshot
