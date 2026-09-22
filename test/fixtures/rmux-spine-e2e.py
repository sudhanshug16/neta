#!/usr/bin/env python3
import atexit, fcntl, os, pty, select, struct, sys, termios, time

pid, fd = pty.fork()
if pid == 0:
    os.execvpe("bun", ["bun", "src/cli/main.ts", "rmux"], os.environ)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
output = bytearray()
deadline = time.monotonic() + 25
stage = "wait-ready"
stage_at = time.monotonic()
input_log = os.environ["NETA_FAKE_PI_INPUT_LOG"]
start_log = os.environ["NETA_FAKE_PI_START_LOG"]
session_log = os.environ["NETA_FAKE_PI_SESSION_INPUT_LOG"]
page_target = b"spine-session-5"
page_input = page_target + b":7a\n"

def cleanup():
    try:
        ended, _ = os.waitpid(pid, os.WNOHANG)
        if ended:
            return
        os.kill(pid, 15)
        time.sleep(.1)
        os.kill(pid, 9)
    except (ChildProcessError, ProcessLookupError):
        pass

atexit.register(cleanup)

def read():
    ready, _, _ = select.select([fd], [], [], .1)
    if ready:
        try:
            output.extend(os.read(fd, 65536))
        except OSError:
            return False
    return True

def starts():
    if not os.path.exists(start_log):
        return []
    with open(start_log, "rb") as log:
        return log.read().splitlines()

while time.monotonic() < deadline:
    if not read():
        break
    now = time.monotonic()
    if stage == "wait-ready" and b"FAKE_PI_READY" in output:
        # End and Enter prove the oldest row is reachable as an exact agent
        # session. Home then returns to NOW before page navigation selects a
        # deterministic newest-first mission.
        # End lands on the archive control after the oldest mission; one Up
        # selects the actual oldest mission row.
        os.write(fd, b"\x00\x1b[F\x1b[A\r")
        stage, stage_at = "end", now
    elif stage == "end" and b"spine-session-1" in starts():
        # Mission activation focuses Pi, so Ctrl+Space restores navigation.
        # First wait for Home's rendered frame before paging: PageDown uses the
        # current frame's visible selectable-row count, never a stale scroll
        # position from the End selection.
        os.write(fd, b"\x00\x1b[H")
        stage, stage_at = "home", now
    elif stage == "home" and now - stage_at > .25:
        # Home and PageDown select the deterministic newest-first row. At this
        # PTY's 100×30 geometry, the sidebar has ten visible selectable labels
        # after its two-line machine header. PageDown moves ten visible rows
        # from Now to mission 5 (missions are rendered newest first).
        os.write(fd, b"\x1b[6~")
        stage, stage_at = "page", now
    elif stage == "page" and now - stage_at > .25:
        # Separate Enter from PageDown so the navigation frame consumes the
        # page move before activation. Ratatui's diff renderer need not emit
        # unchanged text bytes, so the exact started session below is the
        # fixture's observable selection assertion.
        os.write(fd, b"\r")
        stage, stage_at = "select", now
    elif stage == "select" and page_target in starts():
        os.write(fd, b"z")
        stage, stage_at = "typed", now
    elif stage == "typed" and now - stage_at > .3:
        if not os.path.exists(session_log):
            continue
        with open(session_log, "rb") as log:
            if page_input not in log.read():
                continue
        # These keys, including a second paging pass, must be consumed by the
        # navigator.  0 returns to the already-running leader session.
        os.write(fd, b"\x00\x1b[A\x1b[B\x1b[5~\x1b[6~0")
        stage, stage_at = "leader", now
    elif stage == "leader" and now - stage_at > .5:
        # Give the event loop one frame to install the already-running leader
        # pane after 0, then prove ordinary input reaches that exact session.
        os.write(fd, b"l")
        stage, stage_at = "audit", now
    elif stage == "audit" and now - stage_at > .3:
        if starts().count(b"spine-session-1") != 1 or starts().count(page_target) != 1:
            raise AssertionError("selected mission did not keep one exact Pi session")
        initial_leader = starts()[0]
        if not os.path.exists(session_log):
            continue
        with open(session_log, "rb") as log:
            if initial_leader + b":6c\n" not in log.read():
                raise AssertionError("0 did not return ordinary input to the original leader session")
        with open(input_log, "rb") as log:
            if log.read() != b"zl":
                raise AssertionError("navigation keys leaked to Pi")
        os.write(fd, b"\x11")
        stage, stage_at = "quit", now
    elif stage == "quit":
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            if os.waitstatus_to_exitcode(status) != 0:
                raise AssertionError("rmux exited with an error")
            print("rmux spine e2e: newest/oldest paging, exact mission session, and input audit passed")
            sys.exit(0)
    ended, status = os.waitpid(pid, os.WNOHANG)
    if ended:
        raise AssertionError(f"rmux exited early {os.waitstatus_to_exitcode(status)} output={bytes(output[-4096:])!r}")

raise AssertionError(f"rmux spine e2e timed out in {stage}; starts={starts()!r} output={bytes(output[-8192:])!r}")
