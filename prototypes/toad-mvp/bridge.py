"""Text-only ACP attachment adapter for an existing Neta Node session."""
import argparse
import asyncio
import json
from pathlib import Path
from node_client import NodeClient
import sys


class Bridge:
    def __init__(self, socket, token, session, emit, cursor_file=None, context=None):
        self.socket, self.token, self.session, self.emit = socket, token, session, emit
        self.context = context or {}
        self.seen = {}
        self.tools = set()
        self.busy = False
        self.loaded = False
        self.read_only = False
        self.waiters = asyncio.Event()
        self.turns = {}
        self.inbox = {}
        self.buffer = []
        self.own_text = None
        self.own_echo_seq = None
        self.cursor_file = Path(cursor_file) if cursor_file else None
        if self.cursor_file and self.cursor_file.exists():
            stored = json.loads(self.cursor_file.read_text())
            if isinstance(stored, dict):
                self.seen = stored
        self.tools = {block["turnId"] + ":" + str((block.get("data") or {}).get("toolCallId") or key) for key, block in self.seen.items() if block["kind"] in ("tool", "diff")}
        self.last_seq = max((int(seq) for seq in self.seen), default=0)

    def error_details(self, message):
        context = self.context
        details = [message, "", "Machine: " + context.get("machine", "unknown"),
                   "Provider: " + context.get("provider", "unknown") + " · Model: " + (context.get("model") or "default"),
                   "Session: " + self.session]
        if any(term in message.lower() for term in ("oauth", "authenticate", "authentication", "unauthorized")):
            details += ["", "Provider authentication failed. The Node connection is separate from the provider login.",
                        "Sign in again with the provider's CLI on the machine above, using the account that runs Neta.",
                        "Then reconnect this conversation and retry your message. Signing in only on your local machine will not repair a remote login."]
        else:
            details += ["", "Open Reply help in the sidebar to view the captured failure and restore your message for retry."]
        return "\n\n".join(details)

    async def connect(self):
        self.node = NodeClient(self.socket, self.token)
        self.node.listeners.append(self.notification)
        await self.node.connect()

    async def request(self, method, params):
        return await self.node.request(method, params)

    def notification(self, message):
        if message.get("method") == "disconnected":
            self.disconnected = True
            self.waiters.set()
            return
        if message.get("method") != "turn":
            return
        event = message["params"]
        if event.get("sessionId") != self.session:
            return
        if turn := event.get("turn"):
            self.turns[turn["id"]] = turn
        if inbox := event.get("inbox"):
            self.inbox[inbox["id"]] = inbox
        if block := event.get("block"):
            if self.loaded:
                self.block(block, replay=True)
            else:
                self.buffer.append(block)
        self.waiters.set()

    def block(self, block, replay=False):
        key = str(block["seq"])
        prior = self.seen.get(key)
        if prior == block:
            return
        if prior and block["kind"] in ("text", "thought") and prior["text"].startswith(block["text"]):
            return  # A buffered notification predates the history snapshot.
        if prior and block["kind"] == "tool" and (prior.get("data") or {}).get("status") in ("completed", "failed") and (block.get("data") or {}).get("status") in ("pending", "in_progress"):
            return
        self.seen[key] = block.copy()
        self.last_seq = max(self.last_seq, block["seq"])
        text = block["text"]
        if prior and block["kind"] in ("text", "thought"):
            # Node notifications are cumulative replacements at the same seq.
            if text.startswith(prior["text"]):
                text = text[len(prior["text"]):]
            else:
                text = "\n[Updated output]\n" + text
        if self.cursor_file:
            temporary = self.cursor_file.with_suffix(".tmp")
            temporary.write_text(json.dumps(self.seen))
            temporary.replace(self.cursor_file)
        if block["role"] == "user" and self.busy and block["text"] == self.own_text and self.own_echo_seq in (None, key):
            self.own_echo_seq = key
            return
        kind = block["kind"]
        if kind not in ("text", "thought", "status", "tool", "diff", "plan", "usage"):
            return
        data = block.get("data") or {}
        if kind in ("tool", "diff"):
            tool_id = block["turnId"] + ":" + str(data.get("toolCallId") or key)
            update = {"sessionUpdate": "tool_call_update" if tool_id in self.tools else "tool_call", "toolCallId": tool_id, "title": text, "status": data.get("status", "completed"), "kind": data.get("toolKind", "edit" if kind == "diff" else "other")}
            if kind == "diff" and "newText" in data:
                update["content"] = [{"type": "diff", "path": data.get("path", "file"), "oldText": data.get("oldText", ""), "newText": data["newText"]}]
            self.tools.add(tool_id)
            self.emit({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": self.session, "update": update}})
            return
        update = "user_message_chunk" if block["role"] == "user" else "agent_thought_chunk" if kind == "thought" else "agent_message_chunk"
        if kind == "status" and any(term in text.lower() for term in ("error", "failed", "unauthorized")):
            text = self.error_details(text)
        if kind not in ("text", "thought"):
            text = f"\n\n[{kind}] {text}\n\n"
        self.emit({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": self.session, "update": {"sessionUpdate": update, "content": {"type": "text", "text": text}}}})

    async def dispatch(self, method, params):
        if method == "initialize":
            return {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}, "agentInfo": {"name": "neta-attachment", "version": "0.1.0"}, "authMethods": []}
        if method == "session/new":
            raise ValueError("This client attaches existing sessions only")
        if params.get("sessionId") != self.session:
            raise ValueError("Wrong session: attachment identity is fixed")
        if method == "session/load":
            if self.loaded:
                raise ValueError("Reconnect with a fresh bridge to reload")
            # Fetch every page before replay so chronological order is stable.
            pages = []
            cursor = None
            while True:
                params = {"sessionId": self.session, "limit": 200, "direction": "backward"}
                if cursor is not None:
                    params["cursor"] = cursor
                page = await self.request("conversation.tail", params)
                pages.append(page)
                previous = page.get("prevCursor")
                if previous is None or previous == cursor:
                    break
                cursor = previous
            for page in reversed(pages):
                for turn in page.get("turns", []):
                    self.turns[turn["id"]] = turn
                for block in page["blocks"]:
                    self.block(block, replay=True)
            self.loaded = True
            for block in self.buffer:
                self.block(block, replay=True)
            self.buffer.clear()
            return {}
        if self.read_only:
            raise ValueError("Archived conversation: saved output only")
        if method == "session/cancel":
            await self.request("conversation.cancel", {"sessionId": self.session})
            return {}
        if method != "session/prompt":
            raise ValueError(f"Unsupported attachment method: {method}")
        if not self.loaded or self.busy:
            raise ValueError("Session must be loaded and idle")
        if any(part.get("type") != "text" for part in params["prompt"]):
            raise ValueError("This client accepts text prompts only")
        self.busy = True
        self.own_echo_seq = None
        self.own_text = "\n".join(part["text"] for part in params["prompt"])
        try:
            result = await self.request("conversation.prompt", {"sessionId": self.session, "text": self.own_text})
            turn_id = result.get("turnId")
            while True:
                self.waiters.clear()
                if getattr(self, "disconnected", False):
                    raise ConnectionError("Node disconnected; message may have been delivered. Reconnect before sending again.")
                inbox = self.inbox.get(result.get("messageId"), {})
                if inbox.get("status") in ("uncertain", "discarded"):
                    raise RuntimeError("Message is " + inbox["status"] + "; inspect the Node inbox before retrying")
                turn_id = turn_id or inbox.get("turnId")
                turn = self.turns.get(turn_id, {})
                if turn.get("endedAt"):
                    return {"stopReason": "cancelled" if turn.get("cancelled") else "end_turn"}
                await self.waiters.wait()
        finally:
            self.busy = False
            self.own_text = None

    async def close(self):
        await self.node.close()


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--session", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--cursor-file")
    parser.add_argument("--context", default="{}")
    parser.add_argument("--read-only", action="store_true")
    args = parser.parse_args()
    with open(args.token_file) as file:
        token = file.read().strip()
    def emit(message):
        print(json.dumps(message), flush=True)
    bridge = Bridge(args.socket, token, args.session, emit, args.cursor_file, json.loads(args.context))
    bridge.read_only = args.read_only
    await bridge.connect()
    async def handle(message):
        try:
            result = await bridge.dispatch(message["method"], message.get("params", {}))
            response = {"result": result}
        except Exception as error:
            response = {"error": {"code": -32000, "message": bridge.error_details(str(error))}}
        if "id" in message:
            emit({"jsonrpc": "2.0", "id": message["id"], **response})
    tasks = set()
    try:
        while line := await asyncio.to_thread(sys.stdin.buffer.readline):
            task = asyncio.create_task(handle(json.loads(line)))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await bridge.close()


if __name__ == "__main__":
    asyncio.run(main())
