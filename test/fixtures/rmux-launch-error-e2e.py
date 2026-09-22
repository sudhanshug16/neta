#!/usr/bin/env python3
import atexit, fcntl, os, pty, re, select, struct, sys, termios, time

pid, fd = pty.fork()
if pid == 0:
    os.execvpe("bun", ["bun", "src/cli/main.ts", "rmux"], os.environ)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
output = bytearray()
deadline = time.monotonic() + 25
stage = "wait-ready"
stage_at = time.monotonic()
start_log = os.environ["NETA_FAKE_PI_START_LOG"]
input_log = os.environ["NETA_FAKE_PI_SESSION_INPUT_LOG"]
failed_session = os.environ["NETA_RMUX_FAILURE_SESSION"].encode()
debug_output = os.environ.get("NETA_RMUX_FAILURE_DEBUG")

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

def capture_debug():
    if debug_output:
        with open(debug_output, "wb") as log:
            log.write(output)

def rendered_launch_error():
    # Ratatui updates adjacent status cells with separate cursor-positioning
    # sequences, so ANSI stripping joins words that have visible spaces.
    text = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", output)
    return b"cannot open" in text and b"Pi target" in text

while time.monotonic() < deadline:
    if not read():
        break
    now = time.monotonic()
    if stage == "wait-ready" and b"FAKE_PI_READY" in output:
        # End then Up selects the oldest seeded mission, whose legacy cache is
        # deliberately malformed. Enter must leave this TUI alive.
        os.write(fd, b"\x00\x1b[F")
        stage, stage_at = "end", now
    elif stage == "end" and now - stage_at > .25:
        os.write(fd, b"\x1b[A")
        stage, stage_at = "up", now
    elif stage == "up" and now - stage_at > .25:
        os.write(fd, b"\r")
        stage, stage_at = "open-failing", now
    elif stage == "open-failing" and rendered_launch_error():
        if starts().count(failed_session) != 0 or len(starts()) != 1:
            raise AssertionError(f"failed target created a Pi session: {starts()!r}")
        os.write(fd, b"\x00" + b"0")
        stage, stage_at = "reselect-leader", now
    elif stage == "reselect-leader" and now - stage_at > .35:
        first_session = starts()[0]
        os.write(fd, b"x")
        stage, stage_at = "input", now
    elif stage == "input" and now - stage_at > .35:
        first_session = starts()[0]
        if not os.path.exists(input_log):
            continue
        with open(input_log, "rb") as log:
            if first_session + b":78\n" not in log.read():
                raise AssertionError("previous Pi pane did not receive input after failed launch")
        os.write(fd, b"\x11")
        stage = "quit"
    ended, status = os.waitpid(pid, os.WNOHANG)
    if ended:
        if stage == "quit" and os.waitstatus_to_exitcode(status) == 0:
            print("rmux launch-error e2e: failed Pi target preserves the active pane")
            sys.exit(0)
        raise AssertionError(f"rmux exited early {os.waitstatus_to_exitcode(status)} output={bytes(output[-4096:])!r}")

capture_debug()
raise AssertionError(f"rmux launch-error e2e timed out in {stage}; starts={starts()!r} output={bytes(output[-8192:])!r}")
