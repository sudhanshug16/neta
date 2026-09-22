"""Headless framework checks; no ACP/provider, no production code."""
import asyncio
import base64
from textual.app import App, ComposeResult
from textual.containers import Horizontal, VerticalScroll
from textual.widgets import Static, Markdown, TextArea

class Probe(App):
    CSS = '''
    Horizontal { height: 1fr; }
    #spine, #chat { width: 1fr; }
    Static { height: auto; }
    TextArea { height: 5; }
    '''
    def compose(self) -> ComposeResult:
        with Horizontal():
            with VerticalScroll(id="spine"):
                yield Static("SPINE PRIVATE\nMISSION TWO\nMISSION THREE", id="spine_text")
            with VerticalScroll(id="chat"):
                yield Static("CHAT FIRST\nCHAT SECOND\nCHAT THIRD", id="chat_text")
        yield TextArea(id="input")

async def main():
    app = Probe()
    async with app.run_test(size=(80,24)) as pilot:
        await pilot.mouse_down("#chat_text", offset=(2,0))
        await pilot.hover("#spine_text", offset=(8,2))
        await pilot.mouse_up("#spine_text", offset=(8,2))
        selected = app.screen.get_selected_text()
        print("cross-pane selected:", repr(selected))
        assert selected and "MISSION" in selected and "CHAT" in selected
        # Disable selection on the actual non-chat content widget.
        app.query_one("#spine_text").ALLOW_SELECT = False
        await pilot.mouse_down("#chat_text", offset=(2,0))
        await pilot.hover("#spine_text", offset=(8,2))
        await pilot.mouse_up("#spine_text", offset=(8,2))
        selected = app.screen.get_selected_text()
        print("spine content disabled:", repr(selected))
        assert selected and "MISSION" in selected  # Endpoint reintroduced despite ALLOW_SELECT=False.
        spine = app.query_one("#spine_text")
        spine.get_selection = lambda selection: None
        selected = app.screen.get_selected_text()
        assert selected and "SPINE" not in selected and "MISSION" not in selected
        assert spine in app.screen.selections
        print("public get_selection override excludes text; spine selection state remains:", repr(selected))
        driver = app._driver
        writes = []
        original_write = driver.write
        driver.write = writes.append
        app.copy_to_clipboard("SSH clipboard ✓")
        driver.write = original_write
        expected = "\x1b]52;c;" + base64.b64encode("SSH clipboard ✓".encode()).decode() + "\a"
        assert writes == [expected]
        print("OSC52 exact bytes:", repr(writes[0]))
        chat = app.query_one("#chat", VerticalScroll)
        markdown = Markdown()
        await chat.mount(markdown)
        chat.anchor()
        stream = Markdown.get_stream(markdown)
        await stream.write("\n\n".join(f"Paragraph {i}" for i in range(60)))
        await stream.stop()
        await pilot.pause()
        assert chat.max_scroll_y > 0 and chat.scroll_y == chat.max_scroll_y
        print("markdown stream followed bottom:", chat.scroll_y)
        chat.release_anchor()
        chat.scroll_home(animate=False)
        await pilot.pause()
        await markdown.append("\n\nMore streaming text")
        await pilot.pause()
        assert chat.scroll_y == 0
        print("released anchor preserves reading position:", chat.scroll_y)
        editor = app.query_one(TextArea)
        editor.focus()
        await pilot.press("h", "i", "enter", "x")
        assert editor.text == "hi\nx"
        print("multiline editor:", repr(editor.text))

asyncio.run(main())
