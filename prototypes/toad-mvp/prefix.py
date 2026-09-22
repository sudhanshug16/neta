"""Herdr-style one-shot command prefix for Neta's existing controls.

Behavior reference: herdr/src/app/input/navigate.rs, handle_prefix_key.
A second prefix passes through; Escape or an unmatched key exits the mode.
"""
import os
import re
from dataclasses import dataclass

from rich.text import Text
from textual import on
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Static


@dataclass(frozen=True)
class PrefixCommand:
    key: str
    action: str
    label: str


COMMANDS = (
    PrefixCommand("?", "help", "All commands"),
    PrefixCommand("w", "workspaces", "Switch workspace"),
    PrefixCommand("g", "navigation", "Toggle spine / chat focus"),
    PrefixCommand("h", "focus_spine", "Focus spine"),
    PrefixCommand("l", "focus_chat", "Focus chat"),
    PrefixCommand("o", "leader", "Jump to leader"),
    PrefixCommand("p", "session_previous", "Previous tab"),
    PrefixCommand("n", "session_next", "Next tab"),
    PrefixCommand("X", "close_tab", "Close tab (work continues)"),
    PrefixCommand("r", "reconnect", "Reconnect conversation"),
    PrefixCommand("a", "archives", "Show / hide archived missions"),
    PrefixCommand("f", "filter", "Toggle all / needs-you filter"),
    PrefixCommand("e", "export", "Export conversation"),
    PrefixCommand("c", "follow_up", "Prepare follow-up mission draft"),
    PrefixCommand("x", "cancel_reply", "Cancel current reply"),
    PrefixCommand("s", "settings", "Settings"),
    PrefixCommand("q", "quit", "Quit client (work continues)"),
    PrefixCommand("R", "reset_leader", "Reset workspace leader session"),
    PrefixCommand("M", "machines", "Machines · add / connect SSH host"),
)


def prefix_key():
    key = os.environ.get("NETA_TUI_PREFIX", "ctrl+b").strip().lower()
    if not re.fullmatch(r"ctrl\+[a-z]|f(?:[1-9]|1[0-9]|2[0-4])", key):
        raise ValueError("NETA_TUI_PREFIX must be ctrl+a through ctrl+z, or f1 through f24")
    return key


class PrefixHelp(ModalScreen):
    CSS = """
    PrefixHelp { align: center middle; background: #111315 75%; }
    #prefix-dialog { width: 68; max-width: 95%; height: auto; max-height: 90%; border: solid #E8B86D; background: #1B1E21; padding: 1 2; }
    #prefix-dialog Static { height: auto; color: #A5ADB3; margin-bottom: 1; }
    #prefix-commands { height: auto; max-height: 24; }
    #prefix-commands Button { width: 100%; height: 1; min-height: 1; border: none; padding: 0; background: transparent; content-align: left middle; text-style: none; }
    #prefix-commands Button:hover, #prefix-commands Button:focus { background: #30291E; color: #E8B86D; }
    """
    BINDINGS = [("escape", "dismiss", "Close")]

    def compose(self):
        with Vertical(id="prefix-dialog"):
            yield Static(f"Neta commands · {self.app.command_prefix} then a key")
            with VerticalScroll(id="prefix-commands"):
                for index, command in enumerate(COMMANDS):
                    yield Button(Text(f"{command.key:3} {command.label}"), id=f"prefix-command-{index}")
            yield Static("1–9 select tab · Tab / Enter select a command\nEsc cancels · double prefix sends the original key")

    @on(Button.Pressed)
    def choose(self, event):
        event.stop()
        self.dismiss(COMMANDS[int(event.button.id.removeprefix("prefix-command-"))].action)
