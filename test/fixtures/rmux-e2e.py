#!/usr/bin/env python3
import fcntl, os, pty, select, struct, sys, termios, time

pid, fd = pty.fork()
if pid == 0:
    os.execvpe("bun", ["bun", "src/cli/main.ts", "rmux"], os.environ)

def resize(cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

resize(100, 30)
output = bytearray()

def diagnostic():
    # Keep failures actionable when the TUI restores the screen or exits before
    # the fixture reaches its ready marker. Limit the dump so Bun output stays
    # bounded even when a child loops.
    tail = bytes(output[-8192:]).decode("utf-8", "backslashreplace")
    return f" terminal-tail={tail!r}"

resized = sent_backspace = sent_quit = False
picker_opened = invalid_submitted = open_failed = existing_selected = focus_checked = False
existing_selected_at = 0.0
focus_stage = 0
focus_stage_at = 0.0
input_offset = 0
input_log = os.environ["NETA_FAKE_PI_INPUT_LOG"]
resized_at = 0.0
deadline = time.monotonic() + 25
clipboard = b"\x1b]52;c;Y2xpcGJvYXJkLW9r\x07"
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try: output.extend(os.read(fd, 65536))
        except OSError: break
    if b"FAKE_PI_READY" in output and not resized:
        resize(188, 51); resized = True; resized_at = time.monotonic()
    if resized and time.monotonic() - resized_at > 0.25 and not sent_backspace:
        os.write(fd, b"\x7f"); sent_backspace = True
    if b"BACKSPACE_OK" in output and clipboard in output and not sent_quit:
        if b"\x1b]0;must-not-escape\x07" in output: raise AssertionError("ordinary child OSC escaped")
        if not picker_opened:
            os.write(fd, b"\x0b")
            picker_opened = True
        elif picker_opened and b"OPEN PROJECT / WORKSPACES" in output and not invalid_submitted:
            os.write(fd, b"\x0f/definitely/not/a/neta/workspace\r")
            invalid_submitted = True
        elif invalid_submitted and b"OPEN PROJECT / WORKSPACES" in output and b"no such directory: /definitely/not/a/neta/workspace" in output and not open_failed:
            open_failed = True
            os.write(fd, b"\x0b")
        elif open_failed and not existing_selected:
            os.write(fd, b"neta\r")
            existing_selected = True; existing_selected_at = time.monotonic()
        elif existing_selected and time.monotonic() - existing_selected_at > 1 and focus_stage == 0:
            input_offset = os.path.getsize(input_log) if os.path.exists(input_log) else 0
            os.write(fd, b"\x00"); focus_stage = 1; focus_stage_at = time.monotonic()
        elif focus_stage == 1 and time.monotonic() - focus_stage_at > .2:
            os.write(fd, b"\x1b[A\x1b[B"); focus_stage = 2; focus_stage_at = time.monotonic()
        elif focus_stage == 2 and time.monotonic() - focus_stage_at > .2:
            os.write(fd, b"\x00"); focus_stage = 3; focus_stage_at = time.monotonic()
        elif focus_stage == 3 and time.monotonic() - focus_stage_at > .2:
            os.write(fd, b"x"); focus_stage = 4; focus_stage_at = time.monotonic()
        elif focus_stage == 4 and time.monotonic() - focus_stage_at > .2:
            with open(input_log, "rb") as log: forwarded = log.read()[input_offset:]
            if forwarded != b"x":
                raise AssertionError(f"navigation keys reached Pi: {forwarded!r}")
            focus_checked = True
            os.write(fd, b"\x11"); sent_quit = True
    ended, status = os.waitpid(pid, os.WNOHANG)
    if ended:
        code = os.waitstatus_to_exitcode(status)
        if code != 0 or not sent_quit: raise AssertionError(f"premature rmux exit {code}; ready={b'FAKE_PI_READY' in output} backspace={sent_backspace}" + diagnostic())
        print("rmux e2e: picker, tabs, navigation, resize, Backspace, OSC52, quit passed"); sys.exit(0)
try: os.kill(pid, 15); time.sleep(0.1); os.kill(pid, 9)
except ProcessLookupError: pass
import re
raise AssertionError(f"rmux e2e timed out; ready={b'FAKE_PI_READY' in output} picker={picker_opened} failed-open={open_failed} selected={existing_selected} focus={focus_checked} sizes={re.findall(rb'SIZE:[0-9]+x[0-9]+', output)} backspace={b'BACKSPACE_OK' in output} clipboard={clipboard in output}" + diagnostic())
