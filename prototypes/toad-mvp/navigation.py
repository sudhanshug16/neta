"""Paper's compact spine and workspace switcher, driven by Node snapshots."""
from rich.text import Text
from textual import on
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, Static


def state_label(state):
    return {"blocked": "NEEDS YOU", "readyToClose": "READY TO CLOSE", "mergedNotClosed": "MERGED", "closed": "ARCHIVED"}.get(state, state.upper())


class WorkspaceSwitcher(ModalScreen):
    CSS = """
    WorkspaceSwitcher { align: center middle; background: #111315 75%; }
    #workspace-dialog { width: 72; max-height: 80%; height: auto; border: solid #E8B86D; background: #1B1E21; padding: 1 2; }
    #workspace-dialog Label { height: 2; color: #ECEEEB; }
    #workspace-dialog Input { border: none; background: #111315; margin-bottom: 1; }
    #workspace-list { height: auto; max-height: 18; }
    #workspace-list Button { width: 100%; height: 2; min-height: 1; border: none; text-align: left; content-align: left middle; text-style: none; background: transparent; }
    #workspace-list Button:focus, #workspace-list Button:hover { background: #30291E; color: #E8B86D; }
    #workspace-dialog Static { color: #A5ADB3; margin-top: 1; }
    """
    BINDINGS = [("escape", "dismiss", "Close")]

    def compose(self):
        with Vertical(id="workspace-dialog"):
            yield Label("Switch workspace                                      esc")
            yield Input(placeholder="Search workspaces…", id="workspace-search")
            with VerticalScroll(id="workspace-list"):
                for index, workspace in enumerate(self.app.snapshot["workspaces"]):
                    missions = [m for m in self.app.snapshot["missions"] if m["workspaceId"] == workspace["id"]]
                    running = sum(m["state"] == "running" for m in missions)
                    needs = sum(m["state"] in ("blocked", "failed") for m in missions)
                    label = workspace["name"].ljust(30) + f"{running} running · {needs} needs you"
                    yield Button(Text(label), id=f"workspace-{index}")
            yield Static("Runs continue when you switch. Enter opens the selected workspace.")

    @on(Input.Changed)
    def filter(self, event):
        for button in self.query(Button):
            button.display = event.value.casefold() in str(button.label).casefold()

    @on(Input.Submitted)
    def first_result(self):
        for button in self.query(Button):
            if button.display:
                button.press()
                break

    @on(Button.Pressed)
    def choose(self, event):
        index = int(event.button.id.split("-")[-1])
        self.dismiss(self.app.snapshot["workspaces"][index]["id"])


class ReplyHelp(ModalScreen):
    CSS = """
    ReplyHelp { align: center middle; background: #111315 75%; }
    #reply-help { width: 90; max-width: 95%; height: auto; max-height: 90%; border: solid #E8B86D; background: #1B1E21; padding: 1 2; }
    #reply-details { height: auto; max-height: 22; margin: 1 0; }
    #reply-help Button { width: 100%; min-height: 3; }
    """
    BINDINGS = [("escape", "dismiss", "Close")]

    def __init__(self, details, message):
        super().__init__()
        self.details, self.message = details, message

    def compose(self):
        with Vertical(id="reply-help"):
            yield Label("Reply help")
            with VerticalScroll(id="reply-details"):
                yield Static(self.details, markup=False)
            yield Button("Copy error details", id="copy-error")
            yield Button("Restore failed message to composer", id="restore-message", disabled=not self.message)
            yield Static("Restoring does not send anything. Review the message, then press Enter to retry.")
            yield Button("Close", id="close-help")

    @on(Button.Pressed)
    def choose(self, event):
        event.stop()
        if event.button.id == "copy-error":
            self.app.copy_to_clipboard(self.details)
            self.notify("Error details copied")
        elif event.button.id == "restore-message":
            self.dismiss(self.message)
        else:
            self.dismiss()
