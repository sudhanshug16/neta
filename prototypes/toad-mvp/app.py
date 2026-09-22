"""Toad conversation UI attached to an existing local Neta Node."""
import argparse
import asyncio
import hashlib
import json
import inspect
import os
from pathlib import Path
import shlex
import shutil
import sys
import tempfile

from textual import events, on
from textual._keyboard_protocol import MODIFIER_FUNCTIONAL_KEYS
from textual.binding import Binding
from textual.theme import Theme
from textual.content import Content
from textual.geometry import Offset
from toad.widgets.throbber import Throbber
from toad.widgets.session_tabs import SessionsTabs
from toad.widgets.flash import Flash
from toad.widgets.prompt import Prompt
from textual.css.query import NoMatches
from textual.containers import Vertical, VerticalScroll, Horizontal
from textual.widgets import Button, Static
from rich.text import Text
from node_client import NodeClient
from navigation import ReplyHelp, WorkspaceSwitcher, state_label
from prefix import COMMANDS, PrefixHelp, prefix_key
from machines import HostRegistry, MachinesScreen, RemoteConnection
from toad.slash_command import SlashCommand
from toad.app import ToadApp
from toad.acp.agent import Agent
from toad.messages import UserInputSubmitted
from toad.screens.main import MainScreen
from toad.widgets.conversation import Conversation, Window, ContentsGrid, CursorContainer, Cursor, Contents
from fixture import FixtureNode


class SpineLabel(Static):
    def get_selection(self, selection):
        return None


class SpineButton(Button):
    def get_selection(self, selection):
        return None


class AttachmentPrompt(Prompt):
    def update_prompt(self):
        super().update_prompt()
        self.prompt_text_area.placeholder = Content("Message this conversation · Enter send · Shift+Enter newline")


class TranscriptWindow(Window):
    @property
    def scroll_offset(self):
        # Textual anchoring produces a negative offset for short transcripts.
        # Keep short history at the top while long streaming history follows.
        offset = super().scroll_offset
        return Offset(offset.x, max(0, offset.y))


class AttachedConversation(Conversation):
    def update_title(self):
        if self.is_mounted:
            self.screen.title = self.app.workspace_name + " · " + self.app.snapshot["machine"]["name"]

    def _build_slash_commands(self):
        return [SlashCommand("/reset", "Reset this workspace leader with a fresh provider session")]


    def compose(self):
        yield Throbber(id="throbber")
        yield SessionsTabs()
        with TranscriptWindow():
            with ContentsGrid():
                with CursorContainer(id="cursor-container"):
                    yield Cursor()
                yield Contents(id="contents")
        yield Flash()
        yield AttachmentPrompt(complete_callback=self.shell_complete).data_bind(
            project_path=Conversation.project_path,
            working_directory=Conversation.working_directory,
            agent_info=Conversation.agent_info,
            agent_ready=Conversation.agent_ready,
            current_mode=Conversation.current_mode,
            modes=Conversation.modes,
            status=Conversation.status,
        )

    async def watch_agent_ready(self, ready):
        # Node conversations need no local filesystem watcher.
        # Toad otherwise creates another watcher on each reconnect.
        pass

    @on(UserInputSubmitted)
    async def on_user_input_submitted(self, event):
        event.prevent_default()
        if self.has_class("archived"):
            self.notify("Archived conversation: saved output only.")
            return
        if not event.shell and event.body.strip() == "/reset":
            event.stop()
            await self.app.screen.action_reset_leader()
            return
        if event.shell or event.body.lstrip().startswith("/"):
            self.notify("Send chat messages here; the Node owns tools and permissions.")
            return
        await super().on_user_input_submitted(event)

    async def check_prune(self):
        # Toad queues this callback after rendering; a reconnect can remove
        # its Contents before the queued callback runs.
        try:
            self.contents
        except NoMatches:
            return
        await super().check_prune()


class NetaScreen(MainScreen, inherit_bindings=False):
    COMMANDS = set()
    CSS_PATH = Path(inspect.getfile(MainScreen)).with_name("main.tcss")
    CSS = """
    NetaScreen { background: #111315; color: #ECEEEB; }
    NetaScreen SideBar, NetaScreen SessionsTabs, NetaScreen Footer { display: none; }
    AttachmentPrompt #info-container { display: none; }
    #session-footer { height: 2; padding: 0 1; background: #171717; }
    #session-folder { width: 1fr; color: #A5ADB3; }
    #session-provider { width: auto; color: #E8B86D; }
    NetaScreen Button { content-align: left middle; text-style: none; }
    #chat-shell > Center { height: 1fr; }
    NetaScreen AttachedConversation Window { layout: vertical; align: left top !important; }
    #neta-header { height: 3; border-bottom: solid #363B40; }
    #neta-brand { width: 8; color: #E8B86D; padding: 0 1; text-style: bold; }
    #workspace-control { width: 1fr; }
    #leader-control { width: 24; }
    #run-count { width: 28; color: #A5ADB3; }
    #neta-header Button { height: 1; min-height: 1; border: none; background: transparent; text-align: left; }
    #neta-footer { height: 2; border-top: solid #363B40; color: #A5ADB3; padding: 0 1; }
    #neta-body { height: 1fr; }
    #neta-spine { width: 25%; min-width: 32; max-width: 52; background: #111315; border-right: solid #363B40; padding: 0 1; }
    #spine-heading { width: 8; height: 1; color: #ECEEEB; }
    .spine-control-row { height: 1; margin-bottom: 1; }
    #neta-spine .spine-control-row Button { width: 1fr; height: 1; margin: 0; text-align: right; }
    #connection-state { width: 1fr; color: #A5ADB3; }
    #neta-spine #reply-help-control { height: 1; margin-bottom: 0; color: #A5ADB3; }
    #neta-spine .agent-row { margin-bottom: 0; }
    #neta-spine .mission { margin-top: 1; margin-bottom: 0; }
    AttachmentPrompt #prompt-container, AttachmentPrompt #prompt-container:focus-within { border: none !important; border-top: solid #595D60 !important; border-bottom: solid #595D60 !important; padding: 0 !important; margin: 0 1 !important; }
    AttachmentPrompt #prompt { display: none; }
    AttachmentPrompt PromptTextArea { padding: 0; }
    AttachedConversation { padding: 0 1; }
    #spine-rows { height: 1fr; }
    #spine-hints { height: 2; color: #A5ADB3; }
    #neta-spine Button { width: 100%; height: auto; min-height: 1; border: none; background: transparent; text-align: left; margin-bottom: 1; padding: 0; }
    #neta-spine Button:hover, #neta-spine Button:focus, #neta-spine Button.selected { background: #30291E; color: #E8B86D; }
    #neta-spine .mission { color: #A5ADB3; }
    #chat-shell { width: 1fr; height: 1fr; padding: 0 1; }
    #agent-tabs { height: 3; border-bottom: solid #363B40; overflow-x: auto; overflow-y: hidden; }
    #agent-tabs Button { width: auto; height: 1; min-height: 1; border: none; padding: 0 1; background: transparent; color: #A5ADB3; }
    #agent-tabs Button.selected { color: #E8B86D; background: #30291E; }
    #breadcrumb { height: 3; color: #A5ADB3; padding: 0 1; }
    AttachedConversation { background: #171717; }
    AttachedConversation.archived Prompt { display: none; }
    .hidden-archive { display: none; }
    #archive-actions { height: 3; }
    #archive-actions Button { height: 1; min-height: 1; border: none; background: #1B1E21; margin-right: 2; }
    #agent-tabs .close-tab { width: 3; min-width: 3; padding: 0; }
    #archive-note { height: 2; color: #E8B86D; padding: 0 1; }
    """
    BINDINGS = [
        Binding("ctrl+r", "reconnect", "Reconnect", priority=True),
        Binding("escape", "cancel_reply", "Cancel reply", priority=True),
        Binding("ctrl+k", "workspaces", "Workspaces", priority=True),
        Binding("ctrl+l", "leader", "Leader", priority=True),
        Binding("ctrl+w", "close_tab", "Close tab", priority=True),
        Binding("f1", "help", "Help", priority=True),
    ]

    def compose(self):
        app = self.app
        record = app.sessions[app.selected]
        with Horizontal(id="neta-header"):
            yield SpineLabel("neta", id="neta-brand")
            yield SpineButton(Text(app.workspace_name + " ▾  ^K"), id="workspace-control")
            yield SpineButton("Jump to leader  ^L", id="leader-control")
            yield SpineLabel(app.run_counts(), id="run-count")
        with Horizontal(id="neta-body"):
            with Vertical(id="neta-spine"):
                with Horizontal(classes="spine-control-row"):
                    yield SpineLabel("SPINE", id="spine-heading")
                    yield SpineButton(Text(app.snapshot["machine"]["name"] + " ▾"), id="machines-control")
                with Horizontal(classes="spine-control-row"):
                    yield SpineLabel("CONNECTED", id="connection-state")
                    yield SpineButton("All states ▾", id="state-filter")
                with VerticalScroll(id="spine-rows"):
                    yield from self.spine_rows()
                yield SpineButton("Reply help", id="reply-help-control")
                yield SpineLabel("Tab navigate · Enter open\nPrefix M machines · g chat", id="spine-hints")
            with Vertical(id="chat-shell"):
                with Horizontal(id="agent-tabs"):
                    yield from self.tab_buttons()
                yield SpineLabel(Text(app.workspace_name + " / " + app.snapshot["machine"]["name"] + " / " + record.get("mission", "Leader") + " / " + record["name"] + "\n" + state_label(record["state"]) + " · " + record.get("model", "")), id="breadcrumb")
                yield SpineLabel("ARCHIVED · saved output · input disabled", id="archive-note").set_class(not record.get("archived"), "hidden-archive")
                with Horizontal(id="archive-actions", classes="" if record.get("archived") else "hidden-archive"):
                    yield SpineButton("Follow-up mission…", id="follow-up")
                    yield SpineButton("Export run", id="export-run")
                for widget in super().compose():
                    if isinstance(widget, Conversation):
                        yield AttachedConversation(self.project_path, self._agent, self._agent_session_id).set_class(bool(record.get("archived")), "archived").data_bind(project_path=MainScreen.project_path, column=MainScreen.column)
                    else:
                        yield widget
                with Horizontal(id="session-footer"):
                    yield SpineLabel(Text(app.session_folder()), id="session-folder")
                    yield SpineLabel(Text(app.session_provider()), id="session-provider")
        yield SpineLabel(app.prefix_hint(), id="neta-footer")

    def tab_buttons(self):
        for index, session in enumerate(self.app.visible_tabs()):
            record = self.app.sessions[session]
            label = record["name"] + (" · LEADER" if record.get("leader") else " · " + record["mission"].split(" ")[0] + " · " + state_label(record["state"]))
            yield SpineButton(Text(label), id=f"tab-{index}", classes="selected" if session == self.app.selected else "")
            if not record.get("leader"):
                yield SpineButton("×", id=f"close-tab-{index}", classes="close-tab")

    def spine_rows(self):
        app = self.app
        yield SpineLabel("now   ●  Workspace leader")
        for session, record in app.sessions.items():
            if record["workspaceId"] == app.workspace_id and record.get("leader") and record["_host"] == app.host_id:
                yield SpineButton(Text("      " + record["name"] + " · " + state_label(record["state"])), id=app.button_id(session), classes="agent-row selected" if session == app.selected else "agent-row")
        for archived in (False, True):
            missions = [m for m in app.snapshot["missions"] if m["workspaceId"] == app.workspace_id and (m["state"] == "closed") == archived]
            if archived:
                yield SpineButton(f"{'▾' if app.show_archive else '▸'} Archived ({len(missions)})", id="archives")
                if not app.show_archive:
                    continue
            for mission in sorted(missions, key=lambda m: m["createdAt"], reverse=True):
                if app.state_filter == "needs you" and mission["state"] not in ("blocked", "failed"):
                    continue
                yield SpineButton(Text(mission["createdAt"][11:16] + " ├" + ("▸ " if mission["id"] in app.collapsed else "▾ ") + "#" + str(mission["number"]) + " " + mission["name"] + "\n        " + state_label(mission["state"]) + " · " + str(sum(agent["missionId"] == mission["id"] for agent in app.snapshot["agents"])) + (" agent" if sum(agent["missionId"] == mission["id"] for agent in app.snapshot["agents"]) == 1 else " agents")), id="mission-toggle-" + mission["id"], classes="mission")
                if mission["id"] in app.collapsed:
                    continue
                for session, record in app.sessions.items():
                    if record.get("missionId") == mission["id"] and record["_host"] == app.host_id:
                        yield SpineButton(Text("        └ " + record["name"] + " · " + state_label(record["state"])), id=app.button_id(session), classes="agent-row selected" if session == app.selected else "agent-row")

    @on(Button.Pressed)
    async def select_session(self, event):
        ident = event.button.id or ""
        if ident == "machines-control":
            self.action_machines()
        elif ident == "state-filter":
            await self.action_filter()
        elif ident.startswith("mission-toggle-"):
            mission = ident.removeprefix("mission-toggle-")
            self.app.collapsed.symmetric_difference_update({mission})
            await self.refresh_navigation()
        elif ident == "workspace-control":
            self.action_workspaces()
        elif ident == "reply-help-control":
            await self.action_reply_help()
        elif ident == "leader-control":
            await self.action_leader()
        elif ident == "archives":
            await self.action_archives()
        elif ident == "export-run":
            await self.action_export()
        elif ident == "follow-up":
            await self.action_follow_up()
        elif ident.startswith("close-tab-"):
            session = self.app.visible_tabs()[int(ident.removeprefix("close-tab-"))]
            self.app.closed_tabs.add(session)
            if session == self.app.selected:
                await self.action_leader()
            else:
                await self.refresh_navigation()
        elif ident.startswith("tab-"):
            await self.app.attach(self.app.visible_tabs()[int(ident[4:])])
        elif ident in self.app.buttons:
            await self.app.attach(self.app.buttons[ident])
        else:
            return
        event.stop()

    async def refresh_navigation(self):
        self.query_one("#session-folder").update(Text(self.app.session_folder()))
        self.query_one("#session-provider").update(Text(self.app.session_provider()))
        self.title = self.app.workspace_name + " · " + self.app.snapshot["machine"]["name"]
        rows = self.query_one("#spine-rows")
        await rows.remove_children()
        await rows.mount(*list(self.spine_rows()))
        tabs = self.query_one("#agent-tabs")
        await tabs.remove_children()
        await tabs.mount(*list(self.tab_buttons()))

    async def action_reply_help(self):
        app = self.app
        session, host_id = app.selected, app.host_id
        if app.node is None:
            app.notify("Reply help is available on connected machines.")
            return
        try:
            page = await app.node.request("conversation.tail", {"sessionId": app.sessions[session]["sessionId"], "limit": 200, "direction": "backward"})
        except (OSError, RuntimeError, TimeoutError) as error:
            app.notify("Could not fetch reply details: " + str(error), severity="error")
            return
        if app.selected != session or app.host_id != host_id:
            return
        blocks = page["blocks"]
        failure = next((block for block in reversed(blocks) if block["kind"] == "status" and any(word in block["text"].lower() for word in ("error", "failed", "unauthorized"))), None)
        text = failure["text"] if failure else "No failure was recorded in the recent conversation."
        if text.strip() == "Internal error":
            text = "The provider failed without a saved explanation. This older Node did not capture diagnostics; repeated retries may fail the same way."
        record = app.sessions[session]
        details = f"{record.get('provider', 'Provider')} on {app.snapshot['machine']['name']}\n\n{text}"
        message = next((block["text"] for block in reversed(blocks) if failure and block["role"] == "user" and block["turnId"] == failure["turnId"]), None)
        def restore(value):
            if value and app.selected == session and app.host_id == host_id:
                prompt = self.conversation.prompt.prompt_text_area
                if prompt.text:
                    app.notify("Your draft is still in the composer; clear it before restoring the failed message.")
                    return
                prompt.load_text(value)
                self.conversation.focus_prompt()
        app.push_screen(ReplyHelp(details, message), restore)

    async def action_reset_leader(self):
        app = self.app
        if getattr(app, "resetting_leader", False):
            return
        leader = next((record for record in app.snapshot["leaders"] if record["workspaceId"] == app.workspace_id), None)
        if app.node is None or leader is None:
            app.notify("Connect to a machine before resetting its leader.")
            return
        if leader["state"] not in ("idle", "failed", "interrupted"):
            app.notify("Cancel the leader's current reply before resetting.")
            return
        host_id, node = app.host_id, app.node
        app.resetting_leader = True
        app.notify("Starting a fresh leader session…")
        try:
            workspace = next(workspace for workspace in app.snapshot["workspaces"] if workspace["id"] == leader["workspaceId"])
            root = next((root["path"] for root in workspace.get("roots", []) if root["machineId"] == app.snapshot["machine"]["id"]), None)
            if root is None:
                raise RuntimeError("This workspace has no folder registered on the connected machine.")
            # A saved leader may not have a live provider after a Node restart.
            # workspace.open revives it and may assign a new session identity.
            opened = await node.request("workspace.open", {"path": root})
            live_leader = opened["leader"]
            result = await node.request("conversation.reset", {"sessionId": live_leader["sessionId"]})
            snapshot = await node.snapshot()
            if app.host_id != host_id:
                return
            app.snapshot = snapshot
            app.index_snapshot()
            app.closed_tabs.add(app.session_key(leader["sessionId"]))
            await app.attach(app.session_key(result["sessionId"]))
            app.notify("Leader reset. Previous transcript remains saved; missions are unchanged.")
        except (OSError, RuntimeError, TimeoutError, KeyError) as error:
            app.notify("Leader reset failed: " + str(error), severity="error", timeout=15)
        finally:
            app.resetting_leader = False

    def action_go_home(self):
        self.action_workspaces()

    def action_show_sidebar(self):
        self.action_navigation()

    async def action_session_previous(self):
        tabs = self.app.visible_tabs()
        await self.app.attach(tabs[(tabs.index(self.app.selected) - 1) % len(tabs)])

    async def action_session_next(self):
        tabs = self.app.visible_tabs()
        await self.app.attach(tabs[(tabs.index(self.app.selected) + 1) % len(tabs)])

    def action_workspaces(self):
        self.app.push_screen(WorkspaceSwitcher(), self.app.choose_workspace)

    async def action_close_tab(self):
        if self.app.sessions[self.app.selected].get("leader"):
            return
        self.app.closed_tabs.add(self.app.selected)
        await self.action_leader()

    async def action_leader(self):
        await self.app.attach(next(s for s, r in self.app.sessions.items() if r.get("leader") and r["workspaceId"] == self.app.workspace_id and r["_host"] == self.app.host_id))

    def action_navigation(self):
        if self.query_one("#neta-spine").has_focus_within:
            self.action_focus_chat()
        else:
            self.action_focus_spine()

    def action_machines(self):
        try:
            self.app.host_registry.load()
            self.app.push_screen(MachinesScreen(), self.app.choose_machine)
        except (OSError, ValueError) as error:
            self.notify(str(error), severity="error", timeout=12)

    def action_help(self):
        self.app.push_screen(PrefixHelp(), self.app.run_prefix_command)

    def action_focus_spine(self):
        self.query_one("#spine-rows Button").focus()

    def action_focus_chat(self):
        if self.conversation.has_class("archived"):
            self.conversation.window.focus()
        else:
            self.conversation.focus_prompt()

    async def action_archives(self):
        self.app.show_archive = not self.app.show_archive
        await self.refresh_navigation()

    async def action_filter(self):
        self.app.state_filter = "needs you" if self.app.state_filter == "all" else "all"
        self.query_one("#state-filter", Button).label = self.app.state_filter.title() + " ▾"
        await self.refresh_navigation()

    async def action_export(self):
        await self.app.export_run()

    async def action_follow_up(self):
        record = self.app.sessions[self.app.selected]
        await self.action_leader()
        composer = self.app.screen.conversation.prompt.prompt_text_area
        prefix = composer.text.rstrip() + "\n\n" if composer.text.strip() else ""
        composer.load_text(prefix + "Start a follow-up mission for " + record.get("mission", record["name"]) + ".\n\nObjective: ")
        self.app.screen.conversation.focus_prompt()

    async def action_reconnect(self):
        if self.app.node is not None and self.app.node.pump.done():
            if self.app.host_id != "local":
                try:
                    await self.app.prepare_machine(self.app.host_states[self.app.host_id]["profile"])
                    await self.app.choose_machine(self.app.host_id)
                except (OSError, RuntimeError, ValueError, TimeoutError) as error:
                    self.notify("Cannot reconnect: " + str(error), severity="error")
                return
            try:
                descriptor = json.loads((Path(os.environ.get("NETA_DIR", str(Path.home() / ".neta"))) / "node.json").read_text())
                replacement = NodeClient(descriptor["socket"], descriptor["token"])
                await replacement.connect()
                self.app.node = replacement
                self.app.socket = descriptor["socket"]
                Path(self.app.token_file).write_text(descriptor["token"])
                await self.app.refresh_state()
            except (OSError, RuntimeError, ConnectionError) as error:
                self.notify("Cannot reconnect: " + str(error), severity="error")
                return
        await self.app.attach(self.app.selected, reconnect=True)

    async def action_cancel_reply(self):
        if self.conversation.has_class("archived"):
            return
        if self.conversation.busy_count and self.conversation.agent is not None:
            await self.conversation.agent.cancel()


class NetaApp(ToadApp):
    ENABLE_COMMAND_PALETTE = False
    CSS_PATH = Path(inspect.getfile(ToadApp)).with_name("toad.tcss")
    CSS = "SessionsTabs { display: none !important; }"
    TITLE = "Neta"
    def __init__(self, socket, token_file, project, snapshot=None, node=None, state_file=None):
        self.state_file = Path(state_file) if state_file else None
        self.restoring_view = True
        self.saved_view = {}
        if self.state_file:
            try:
                saved = json.loads(self.state_file.read_text())
                if isinstance(saved, dict) and all(isinstance(value, str) for value in saved.values()):
                    self.saved_view = saved
            except (OSError, ValueError):
                pass
        self.host_id = "local"
        self.host_states = {}
        self.host_registry = HostRegistry(os.environ.get("NETA_DIR", str(Path.home() / ".neta")))
        self.command_prefix = prefix_key()
        self.prefix_active = False
        self.socket, self.token_file = socket, token_file
        self.snapshot = snapshot
        self.node = node
        self.workspace_id = None
        self.sessions = {}
        self.buttons = {}
        self.show_archive = False
        self.collapsed = set()
        self.closed_tabs = set()
        self.state_filter = "all"
        self.selected = "leader"
        self.attached = {}
        self.transports = {}
        super().__init__(project_dir=str(project))
        self.register_theme(Theme(name="neta", primary="#E8B86D", secondary="#A5ADB3", accent="#E8B86D", foreground="#ECEEEB", background="#111315", surface="#171717", panel="#1B1E21", dark=True))
        self.settings.set("ui.theme", "neta")
        self.theme = "neta"

    def prefix_hint(self):
        if self.prefix_active:
            return "PREFIX · M machines · w workspace · g navigation · n/p tabs · ? all commands · Esc cancel"
        return f"{self.command_prefix} then ? commands · M machines · g navigation · w workspace · Esc cancel reply"

    def clear_prefix(self):
        self.prefix_active = False
        if isinstance(self.screen, NetaScreen):
            self.screen.query_one("#neta-footer").update(self.prefix_hint())

    async def on_event(self, event):
        # Intercept before Textual forwards input to the composer or evaluates
        # priority bindings. Otherwise a prefix command can edit/send a draft.
        if isinstance(event, events.Key) and not event.is_forwarded and isinstance(self.screen, NetaScreen):
            if self.prefix_active:
                if event.key in MODIFIER_FUNCTIONAL_KEYS or event.key in ("shift", "ctrl", "alt", "meta", "super", "hyper"):
                    return
                self.clear_prefix()
                if event.key == self.command_prefix:
                    # Bypass app shortcuts, delivering the literal second key.
                    (self.focused or self.screen)._forward_event(event)
                    return
                if event.key != "escape":
                    key = event.character if event.is_printable else event.key
                    if key and key in "123456789" and len(key) == 1:
                        tabs = self.visible_tabs()
                        index = int(key) - 1
                        if index < len(tabs):
                            await self.attach(tabs[index])
                    else:
                        command = next((command for command in COMMANDS if (command.key == key or command.action == "machines" and key == "m")), None)
                        if command:
                            await self.run_prefix_command(command.action)
                return  # Unknown keys cancel; they never become prompt text.
            if event.key == self.command_prefix:
                self.prefix_active = True
                self.screen.query_one("#neta-footer").update(self.prefix_hint())
                return
        elif isinstance(event, (events.MouseDown, events.Paste, events.AppBlur)) and self.prefix_active:
            self.clear_prefix()
        await super().on_event(event)

    async def run_prefix_command(self, action):
        if action is None or not isinstance(self.screen, NetaScreen):
            return
        if action in ("quit", "settings"):
            await self.run_action("app." + action)
        else:
            await self.screen.run_action(action)

    def save_view(self):
        if self.state_file is None or self.restoring_view:
            return
        workspace = next((item for item in self.snapshot["workspaces"] if item["id"] == self.workspace_id), {})
        folder = next((root["path"] for root in workspace.get("roots", []) if root["machineId"] == self.snapshot["machine"]["id"]), "")
        view = {"host": self.host_id, "workspace": self.workspace_id, "session": self.sessions[self.selected]["sessionId"], "path": folder}
        temporary = None
        try:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", dir=self.state_file.parent, delete=False) as output:
                temporary = Path(output.name)
                json.dump(view, output)
            temporary.replace(self.state_file)
        except OSError:
            self.notify("Could not save your last workspace.", severity="warning")
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)

    def session_key(self, session):
        return session if self.host_id == "local" else self.host_id + "::" + session

    async def prepare_machine(self, host):
        key = "ssh:" + host["id"]
        state = self.host_states.get(key)
        if state and state["profile"] == host and not state["node"].pump.done():
            return
        connection = RemoteConnection(host)
        try:
            snapshot = await connection.connect()
        except BaseException:
            await connection.close()
            raise
        if state:
            for cursor in Path(state["token_file"]).parent.glob("*.cursor"):
                shutil.copyfile(cursor, Path(connection.token_file).parent / cursor.name)
            await state["connection"].close()
        self.host_states[key] = {"connection": connection, "node": connection.node, "socket": connection.socket, "token_file": connection.token_file, "snapshot": snapshot, "selected": state.get("selected") if state else None, "profile": host, "fresh": True}

    async def choose_machine(self, host_id):
        if host_id is None:
            return
        # Only client view state changes. Existing bridge processes and remote
        # Nodes continue working while another machine is selected.
        if self.host_id != host_id or host_id not in self.host_states:
            previous = self.host_states.get(self.host_id, {})
            self.host_states[self.host_id] = {**previous, "node": self.node, "socket": self.socket, "token_file": self.token_file, "snapshot": self.snapshot, "selected": self.selected}
        state = self.host_states[host_id]
        self.host_id = host_id
        self.node, self.socket, self.token_file, self.snapshot = state["node"], state["socket"], state["token_file"], state["snapshot"]
        self.index_snapshot()
        selected = state.get("selected")
        workspaces = {workspace["id"] for workspace in self.snapshot["workspaces"]}
        available = {self.session_key(record["sessionId"]) for record in [*self.snapshot["leaders"], *self.snapshot["agents"]] if record["workspaceId"] in workspaces}
        selected = selected if selected in available else next((self.session_key(leader["sessionId"]) for leader in self.snapshot["leaders"] if leader["workspaceId"] in workspaces), None)
        if selected is None:
            self.notify("This machine has no available workspace leader. Open a remote project from Machines.", severity="error")
            return
        await self.attach(selected)

    async def close_machines(self):
        for state in self.host_states.values():
            if connection := state.get("connection"):
                await connection.close()

    async def run_async(self, *args, **kwargs):
        try:
            return await super().run_async(*args, **kwargs)
        finally:
            await self.close_machines()

    def run_counts(self):
        missions = [m for m in self.snapshot["missions"] if m["workspaceId"] == self.workspace_id]
        running = sum(m["state"] == "running" for m in missions)
        needs = sum(m["state"] in ("blocked", "failed") for m in missions)
        return f"{running} running · {needs} needs you"

    @property
    def workspace_name(self):
        return next((w["name"] for w in self.snapshot["workspaces"] if w["id"] == self.workspace_id), "Unavailable workspace")

    def session_folder(self):
        record = self.sessions[self.selected]
        mission = next((mission for mission in self.snapshot["missions"] if mission["id"] == record.get("missionId")), None)
        folder = (mission.get("worktree") or {}).get("path") if mission else None
        workspace = next((workspace for workspace in self.snapshot["workspaces"] if workspace["id"] == record["workspaceId"]), {})
        if not folder:
            folder = next((root["path"] for root in workspace.get("roots", []) if root["machineId"] == self.snapshot["machine"]["id"]), None)
        return folder or workspace.get("name", "Workspace folder unavailable")

    def session_provider(self):
        record = self.sessions[self.selected]
        return "(" + record.get("provider", "unknown") + ") " + (record.get("model") or "default")

    def button_id(self, session):
        ident = session if session in ("leader", "mission-1", "mission-2") else "session-" + hashlib.sha256(session.encode()).hexdigest()[:16]
        self.buttons[ident] = session
        return ident

    def visible_tabs(self):
        return [s for s in self.sessions if not self.sessions[s].get("superseded") and self.sessions[s]["workspaceId"] == self.workspace_id and self.sessions[s]["_host"] == self.host_id and (s in self.attached and s not in self.closed_tabs or self.sessions[s].get("leader") or s == self.selected)]

    def index_snapshot(self):
        current_leaders = {leader["workspaceId"]: self.session_key(leader["sessionId"]) for leader in self.snapshot["leaders"]}
        for session, record in self.sessions.items():
            if record.get("leader") and record["_host"] == self.host_id and record["workspaceId"] in current_leaders and current_leaders[record["workspaceId"]] != session:
                record["leader"] = False
                record["superseded"] = True
                self.closed_tabs.add(session)
        for leader in self.snapshot["leaders"]:
            self.sessions[self.session_key(leader["sessionId"])] = {**leader, "leader": True, "_host": self.host_id}
        for agent in self.snapshot["agents"]:
            mission = next((m for m in self.snapshot["missions"] if m["id"] == agent["missionId"]), None)
            if mission:
                self.sessions[self.session_key(agent["sessionId"])] = {**agent, "_host": self.host_id, "mission": "#" + str(mission["number"]) + " " + mission["name"], "archived": agent["state"] == "archived" or mission["state"] == "closed"}

    async def choose_workspace(self, workspace):
        if workspace is not None:
            record = next((item for item in self.snapshot["workspaces"] if item["id"] == workspace), None)
            if record is None:
                self.notify("That workspace is no longer available.")
                return
            root = next((root["path"] for root in record.get("roots", []) if root["machineId"] == self.snapshot["machine"]["id"]), None)
            if self.node is not None and root:
                node, host_id = self.node, self.host_id
                await node.request("workspace.open", {"path": root})
                snapshot = await node.snapshot()
                if host_id != self.host_id:
                    return
                self.snapshot = snapshot
                self.index_snapshot()
            self.workspace_id = workspace
            await self.attach(next(s for s, r in self.sessions.items() if r.get("leader") and r["workspaceId"] == workspace and r["_host"] == self.host_id))

    async def action_sessions(self):
        if isinstance(self.screen, NetaScreen):
            self.screen.action_workspaces()

    def capture_event(self, event_name, **properties):
        return self.run_worker(self.no_telemetry())

    async def no_telemetry(self):
        return None

    def run_version_check(self):
        pass

    def data_for(self, session):
        arguments = [sys.executable, str(Path(__file__).with_name("bridge.py")), "--socket", str(self.socket), "--token-file", str(self.token_file), "--session", self.sessions[session]["sessionId"], "--cursor-file", str(Path(self.token_file).with_name(hashlib.sha256(session.encode()).hexdigest() + ".cursor"))]
        record = self.sessions[session]
        arguments.extend(["--context", json.dumps({"machine": self.snapshot["machine"]["name"], "provider": record.get("provider", "unknown"), "model": record.get("model", "")})])
        if self.sessions[session].get("archived"):
            arguments.append("--read-only")
        command = shlex.join(arguments)
        return {"identity": "neta-mvp", "name": "Neta", "short_name": "neta", "url": "", "protocol": "acp", "type": "chat", "author_name": "Neta", "author_url": "", "publisher_name": "Neta", "publisher_url": "", "description": "Existing Node conversation", "tags": [], "help": "", "run_command": {"*": command}, "actions": {}}

    async def on_mount(self, event):
        event.prevent_default()
        self.settings.set("shell.allow_commands", "")
        if self.snapshot is None:
            from_fixture = FixtureNode(self.socket)
            self.snapshot = from_fixture.snapshot()
        self.index_snapshot()
        self.workspace_id = self.snapshot["workspaces"][0]["id"]
        await self.choose_workspace(self.workspace_id)
        try:
            saved = self.saved_view
            if saved.get("host", "local") != "local":
                profile = next((host for host in self.host_registry.load() if "ssh:" + host["id"] == saved["host"]), None)
                if profile is None:
                    raise RuntimeError("Saved machine is no longer registered")
                await self.prepare_machine(profile)
                await self.choose_machine(saved["host"])
            if saved.get("workspace") in {workspace["id"] for workspace in self.snapshot["workspaces"]}:
                await self.choose_workspace(saved["workspace"])
                key = self.session_key(saved.get("session", ""))
                if key in self.sessions and not self.sessions[key].get("superseded"):
                    await self.attach(key)
        except (OSError, RuntimeError, ValueError, TimeoutError) as error:
            self.notify("Could not restore your last workspace: " + str(error), severity="warning", timeout=12)
        finally:
            self.restoring_view = False
        if not self.saved_view:
            self.save_view()
        self.terminal_title_icon = ""
        self.set_interval(3, self.refresh_state)

    async def export_run(self):
        client = NodeClient(self.socket, Path(self.token_file).read_text().strip())
        try:
            await client.connect()
            pages = []
            cursor = None
            while True:
                params = {"sessionId": self.sessions[self.selected]["sessionId"], "direction": "backward", "limit": 200}
                if cursor is not None:
                    params["cursor"] = cursor
                page = await client.request("conversation.tail", params)
                pages.append(page)
                following = page.get("prevCursor")
                if following is None or following == cursor:
                    break
                cursor = following
            blocks = [block for page in reversed(pages) for block in page["blocks"]]
            turns = {turn["id"]: turn for page in reversed(pages) for turn in page.get("turns", [])}
            with tempfile.NamedTemporaryFile(mode="w", prefix="neta-run-", suffix=".json", dir=self.project_dir, delete=False) as output:
                json.dump({"sessionId": self.sessions[self.selected]["sessionId"], "conversation": self.sessions[self.selected], "turns": list(turns.values()), "blocks": blocks}, output, indent=2)
            self.notify("Saved " + output.name, timeout=15)
        except (OSError, RuntimeError, ConnectionError) as error:
            self.notify("Export failed: " + str(error), severity="error")
        finally:
            if hasattr(client, "writer"):
                await client.close()

    async def refresh_state(self):
        node, host_id = self.node, self.host_id
        if node is None:
            return
        try:
            previous = json.dumps({key: self.snapshot[key] for key in ("missions", "agents", "leaders")}, sort_keys=True)
            snapshot = await node.snapshot()
            if host_id != self.host_id:
                return
            self.snapshot = snapshot
            self.index_snapshot()
            if self.sessions[self.selected].get("superseded"):
                await self.choose_workspace(self.workspace_id)
                return
            if isinstance(self.screen, NetaScreen):
                self.screen.query_one("#machines-control").label = Text(self.snapshot["machine"]["name"] + " ▾")
                self.screen.query_one("#connection-state").update("CONNECTED")
                archived = self.sessions[self.selected].get("archived", False)
                self.screen.conversation.set_class(archived, "archived")
                self.screen.query_one("#archive-note").set_class(not archived, "hidden-archive")
                self.screen.query_one("#archive-actions").set_class(not archived, "hidden-archive")
                self.screen.query_one("#run-count").update(self.run_counts())
                record = self.sessions[self.selected]
                self.screen.query_one("#breadcrumb").update(Text(self.workspace_name + " / " + self.snapshot["machine"]["name"] + " / " + record.get("mission", "Leader") + " / " + record["name"] + "\n" + state_label(record["state"]) + " · " + record.get("model", "")))
                if previous != json.dumps({key: self.snapshot[key] for key in ("missions", "agents", "leaders")}, sort_keys=True) and not self.screen.query_one("#neta-spine").has_focus_within:
                    await self.screen.refresh_navigation()
        except (OSError, ConnectionError, RuntimeError, TimeoutError):
            if isinstance(self.screen, NetaScreen):
                self.screen.query_one("#connection-state").update("DISCONNECTED · ^R")

    async def attach(self, session, reconnect=False):
        self.clear_prefix()
        record = self.sessions.get(session)
        if record is None or record.get("superseded") or record.get("_host") != self.host_id or not any(workspace["id"] == record["workspaceId"] for workspace in self.snapshot["workspaces"]):
            self.notify("That conversation's workspace is no longer available on this machine.", severity="error")
            return
        self.selected = session
        self.closed_tabs.discard(session)
        self.workspace_id = self.sessions[session]["workspaceId"]
        if reconnect and session in self.attached:
            conversation = self.screen.conversation
            if conversation.busy_count or not conversation.agent_ready:
                self.notify("Wait for the reply or cancel before reconnecting.")
                return
            conversation.agent_ready = False
            old_agent = conversation.agent
            # An intentional bridge shutdown must not render an AgentFail.
            old_agent._message_target = None
            await old_agent.stop()
            if old_agent._process is not None:
                await asyncio.wait_for(old_agent._process.wait(), 3)
            conversation.agent = Agent(self.project_dir, self.data_for(session), self.sessions[session]["sessionId"])
            conversation.agent.tool_calls = old_agent.tool_calls
            await conversation.agent.start(conversation)
            self.transports[session] = self.socket
            return
        if session in self.attached:
            await self.switch_mode(self.attached[session])
            archived = bool(self.sessions[session].get("archived"))
            self.screen.conversation.set_class(archived, "archived")
            self.screen.query_one("#archive-note").set_class(not archived, "hidden-archive")
            self.screen.query_one("#archive-actions").set_class(not archived, "hidden-archive")
            await self.screen.refresh_navigation()
            self.screen.conversation.focus_prompt()
            if self.transports.get(session) != self.socket:
                await self.attach(session, reconnect=True)
        else:
            await self.new_session_screen(lambda: NetaScreen(self.project_dir, self.data_for(session), agent_session_id=self.sessions[session]["sessionId"]))
            self.attached[session] = self.current_mode
            self.transports[session] = self.socket
        self.save_view()


async def main():
    parser = argparse.ArgumentParser(description="Neta Toad client — attach to locally owned conversations")
    parser.add_argument("--demo", action="store_true", help="use an isolated fixture without real providers")
    parser.add_argument("--project", type=Path, default=Path.cwd())
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="neta-toad-") as directory:
        root = Path(directory)
        for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
            os.environ[key] = str(root / key.lower())
        token = root / "token"
        fixture = None
        node = None
        try:
            if args.demo:
                fixture = FixtureNode(str(root / "node.sock"))
                await fixture.start()
                socket, secret = fixture.socket, "demo"
                snapshot = fixture.snapshot()
            else:
                descriptor = Path(os.environ.get("NETA_DIR", str(Path.home() / ".neta"))) / "node.json"
                if not descriptor.exists():
                    raise RuntimeError("Start the local Node first: bun src/cli/main.ts node start --detach")
                data = json.loads(descriptor.read_text())
                socket, secret = data["socket"], data["token"]
                node = NodeClient(socket, secret)
                await node.connect()
                project = str(args.project.resolve())
                state_file = descriptor.parent / "tui-view.json"
                try:
                    saved = json.loads(state_file.read_text())
                    if isinstance(saved, dict) and saved.get("host") == "local" and isinstance(saved.get("path"), str) and Path(saved["path"]).is_dir():
                        project = saved["path"]
                except (OSError, ValueError):
                    pass
                opened = await node.request("workspace.open", {"path": project})
                snapshot = await node.snapshot()
                snapshot["workspaces"].sort(key=lambda w: w["id"] != opened["workspace"]["id"])
            token.write_text(secret)
            token.chmod(0o600)
            await NetaApp(socket, token, args.project, snapshot, node, None if args.demo else state_file).run_async()
        finally:
            if node:
                await node.close()
            if fixture:
                await fixture.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (RuntimeError, OSError, ValueError) as error:
        print("neta: " + str(error), file=sys.stderr)
        sys.exit(1)
