"""Saved machine connections, compatible with Neta's existing host registry."""
import asyncio
import fcntl
import json
import os
from pathlib import Path
import shlex
import tempfile
import uuid

from rich.text import Text
from textual import on, work
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, Static
from node_client import NodeClient


def validate_host(host):
    allowed = {"id", "displayName", "sshDestination", "sshConfig", "remoteNetaDir", "remoteLauncher", "lastRemoteWorkspacePath"}
    if not isinstance(host, dict) or set(host) - allowed:
        raise ValueError("Invalid saved machine fields")
    for field in ("sshConfig", "lastRemoteWorkspacePath"):
        if host.get(field) is not None and not isinstance(host[field], str):
            raise ValueError(f"Machine {field} must be a path string")
    for field in ("id", "displayName", "sshDestination", "remoteNetaDir"):
        if not isinstance(host.get(field), str) or not host[field].strip():
            raise ValueError(f"Machine {field} must not be empty")
    destination = host["sshDestination"]
    if destination.startswith("-") or any(c.isspace() or ord(c) < 32 for c in destination):
        raise ValueError("Use an SSH destination such as runner@noscrubsblr")
    if any(c in host["remoteNetaDir"] for c in ("\0", "\n", "\r")):
        raise ValueError("Invalid remote Neta directory")
    launcher = host.get("remoteLauncher")
    if launcher is not None and (not isinstance(launcher, dict) or not isinstance(launcher.get("executable"), str) or not launcher["executable"] or not isinstance(launcher.get("args", []), list) or not all(isinstance(arg, str) for arg in launcher.get("args", []))):
        raise ValueError("Invalid saved remote launcher")


class HostRegistry:
    def __init__(self, directory):
        self.path = Path(directory) / "client-hosts.json"

    def load(self):
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text())
            hosts = data["hosts"]
            if not isinstance(hosts, list):
                raise ValueError("hosts must be a list")
            ids, endpoints = set(), set()
            for host in hosts:
                validate_host(host)
                endpoint = (host["sshDestination"], host.get("sshConfig"), host["remoteNetaDir"])
                if host["id"] in ids or endpoint in endpoints:
                    raise ValueError("Duplicate saved machine")
                ids.add(host["id"])
                endpoints.add(endpoint)
            return hosts
        except (ValueError, TypeError, KeyError) as error:
            raise ValueError(f"Invalid machine registry {self.path}: {error}") from error

    def save(self, host):
        validate_host(host)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (self.path.parent / "client-hosts.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            hosts = self.load()  # Never replace a malformed file or stale list.
            endpoint = (host["sshDestination"], host.get("sshConfig"), host["remoteNetaDir"])
            for existing in hosts:
                if existing["id"] != host["id"] and (existing["sshDestination"], existing.get("sshConfig"), existing["remoteNetaDir"]) == endpoint:
                    raise ValueError("This SSH machine is already saved")
            hosts = [host if existing["id"] == host["id"] else existing for existing in hosts] if any(existing["id"] == host["id"] for existing in hosts) else [*hosts, host]
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", dir=self.path.parent, delete=False) as output:
                    temporary = Path(output.name)
                    json.dump({"hosts": hosts}, output, indent=2)
                    output.flush()
                    os.fsync(output.fileno())
                temporary.replace(self.path)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)


def remote_path(path):
    if path.startswith("~/"):
        return '"$HOME"/' + shlex.quote(path[2:])
    return shlex.quote(path)


class RemoteConnection:
    def __init__(self, host):
        validate_host(host)
        self.host = host
        self.directory = tempfile.TemporaryDirectory(prefix="neta-ssh-", dir="/tmp")
        self.root = Path(self.directory.name)
        self.node = None
        self.tunnel = None
        self.log = None

    def ssh_args(self):
        args = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ForwardAgent=no"]
        if self.host.get("sshConfig"):
            args.extend(["-F", str(Path(self.host["sshConfig"]).expanduser())])
        return args

    async def command(self, command):
        process = await asyncio.create_subprocess_exec(*self.ssh_args(), "--", self.host["sshDestination"], command, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), 25)
        except BaseException:
            if process.returncode is None:
                process.kill()
            await process.wait()
            raise
        if process.returncode:
            raise RuntimeError(stderr.decode(errors="replace").strip() or "SSH command failed")
        return stdout

    async def connect(self):
        descriptor_path = remote_path(self.host["remoteNetaDir"].rstrip("/") + "/node.json")
        # Reading is separate from startup: an SSH/authentication failure must
        # not be mistaken for a missing Node or cause an installation attempt.
        raw = await self.command(f"if test -f {descriptor_path}; then head -c 65536 {descriptor_path}; else printf MISSING; fi")
        if raw == b"MISSING":
            launcher = self.host.get("remoteLauncher") or {"executable": "neta", "args": []}
            command = shlex.join([launcher["executable"], *launcher.get("args", []), "node", "start", "--detach"])
            await self.command("NETA_DIR=" + remote_path(self.host["remoteNetaDir"]) + " " + command)
            raw = await self.command(f"head -c 65536 {descriptor_path}")
        descriptor = json.loads(raw)
        if descriptor.get("protocolVersion") != 3 or not isinstance(descriptor.get("token"), str) or not isinstance(descriptor.get("socket"), str):
            raise ValueError("Remote Node descriptor is invalid or incompatible")
        if ":" in descriptor["socket"] or "\n" in descriptor["socket"]:
            raise ValueError("Unsupported remote socket path")
        self.socket = str(self.root / "node.sock")
        self.token_file = self.root / "token"
        self.token_file.write_text(descriptor["token"])
        self.token_file.chmod(0o600)
        self.log = (self.root / "ssh.log").open("wb")
        self.tunnel = await asyncio.create_subprocess_exec(*self.ssh_args(), "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-N", "-L", self.socket + ":" + descriptor["socket"], "--", self.host["sshDestination"], stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL, stderr=self.log)
        for _ in range(200):
            if self.tunnel.returncode is not None:
                raise RuntimeError((self.root / "ssh.log").read_text().strip() or "SSH tunnel exited")
            if Path(self.socket).exists():
                self.node = NodeClient(self.socket, descriptor["token"])
                await self.node.connect()
                snapshot = await self.node.snapshot()
                path = self.host.get("lastRemoteWorkspacePath")
                if path:
                    opened = await self.node.request("workspace.open", {"path": path})
                    snapshot = await self.node.snapshot()
                    snapshot["leaders"].sort(key=lambda leader: leader["sessionId"] != opened["leader"]["sessionId"])
                if not any(leader["workspaceId"] == workspace["id"] for leader in snapshot["leaders"] for workspace in snapshot["workspaces"]):
                    raise ValueError("This machine has no workspaces. Enter a remote project path, then connect again.")
                return snapshot
            await asyncio.sleep(0.05)
        raise TimeoutError("SSH tunnel did not become ready")

    async def close(self):
        if self.node and hasattr(self.node, "writer"):
            try:
                await self.node.close()
            except (OSError, RuntimeError):
                pass
        if self.tunnel and self.tunnel.returncode is None:
            self.tunnel.terminate()
            await self.tunnel.wait()
        if self.log:
            self.log.close()
        self.directory.cleanup()


class MachinesScreen(ModalScreen):
    CSS = """
    MachinesScreen { align: center middle; background: #111315 75%; }
    #machines-dialog { width: 78; max-width: 95%; height: auto; max-height: 95%; background: #1B1E21; border: solid #E8B86D; padding: 1 2; overflow-y: auto; }
    #machine-list { height: auto; max-height: 8; }
    #machines-dialog Button { height: 1; min-height: 1; border: none; margin-bottom: 1; width: 100%; content-align: left middle; background: #30291E; text-style: none; }
    #machines-dialog Input { height: 3; margin: 0; }
    #machines-dialog Label { height: 1; color: #A5ADB3; }
    #machine-status { height: auto; color: #E8B86D; }
    """
    BINDINGS = [("escape", "dismiss", "Close")]

    def compose(self):
        self.editing = None
        self.saved = self.app.host_registry.load()
        with Vertical(id="machines-dialog"):
            yield Static("Machines · select a connection or add one · Esc close")
            with VerticalScroll(id="machine-list"):
                yield Button("Local machine", id="machine-local")
                for index, host in enumerate(self.saved):
                    yield Button(Text(host["displayName"] + " · " + host["sshDestination"]), id=f"machine-{index}")
            yield Label("Add / edit machine · name")
            yield Input(placeholder="Mac mini", id="machine-name")
            yield Label("SSH destination (from your SSH config, or user@host)")
            yield Input(placeholder="runner@noscrubsblr", id="machine-destination")
            yield Label("Remote Neta directory")
            yield Input(value="~/.neta", id="machine-directory")
            yield Label("Remote project path (needed if no workspace is registered)")
            yield Input(placeholder="/Users/runner/workspace/neta", id="machine-project")
            yield Button("Save and connect", id="machine-save")
            yield Static("Uses your SSH keys/config. For first-time SSH authentication, connect in a terminal first.", id="machine-status")

    @on(Button.Pressed)
    async def choose(self, event):
        event.stop()
        if event.button.id == "machine-local":
            self.dismiss("local")
            return
        if event.button.id == "machine-save":
            host = {**(self.editing or {}), "id": (self.editing or {}).get("id", uuid.uuid4().hex), "displayName": self.query_one("#machine-name", Input).value.strip(), "sshDestination": self.query_one("#machine-destination", Input).value.strip(), "remoteNetaDir": self.query_one("#machine-directory", Input).value.strip(), "lastRemoteWorkspacePath": self.query_one("#machine-project", Input).value.strip() or None}
            try:
                self.app.host_registry.save(host)
                self.editing = host
            except (OSError, ValueError) as error:
                self.query_one("#machine-status", Static).update(Text(str(error)))
                return
        else:
            host = self.saved[int(event.button.id.removeprefix("machine-"))]
            self.editing = host
            for selector, field in (("name", "displayName"), ("destination", "sshDestination"), ("directory", "remoteNetaDir"), ("project", "lastRemoteWorkspacePath")):
                self.query_one("#machine-" + selector, Input).value = host.get(field) or ""
        self.query_one("#machine-status", Static).update("Connecting…")
        for button in self.query(Button):
            button.disabled = True
        self.connect_host(host)

    @work(exclusive=True)
    async def connect_host(self, host):
        try:
            await self.app.prepare_machine(host)
        except (OSError, RuntimeError, ValueError, TimeoutError) as error:
            self.query_one("#machine-status", Static).update(Text("Connection failed: " + str(error)))
            for button in self.query(Button):
                button.disabled = False
            return
        self.dismiss("ssh:" + host["id"])
