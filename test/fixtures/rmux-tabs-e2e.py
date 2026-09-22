#!/usr/bin/env python3
import atexit, fcntl, os, pty, re, select, struct, sys, termios, time

pid, fd = pty.fork()
if pid == 0:
    os.execvpe("bun", ["bun", "src/cli/main.ts", "rmux"], os.environ)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 50, 0, 0))
output = bytearray()
deadline = time.monotonic() + 25
opened_second = opened_overflow = selected_hidden = closed_view = reopened = sent_input = False
first_session = None
stage_at = time.monotonic()
input_log = os.environ["NETA_FAKE_PI_INPUT_LOG"]
start_log = os.environ["NETA_FAKE_PI_START_LOG"]
session_input_log = os.environ["NETA_FAKE_PI_SESSION_INPUT_LOG"]
cwd_log = os.environ["NETA_FAKE_PI_CWD_LOG"]

def cleanup():
    try:
        ended, _ = os.waitpid(pid, os.WNOHANG)
        if ended: return
        os.kill(pid, 15)
        for _ in range(10):
            ended, _ = os.waitpid(pid, os.WNOHANG)
            if ended: return
            time.sleep(.1)
        os.kill(pid, 9)
        os.waitpid(pid, 0)
    except (ChildProcessError, ProcessLookupError): pass

atexit.register(cleanup)

def read():
    ready, _, _ = select.select([fd], [], [], .1)
    if ready:
        try:
            output.extend(os.read(fd, 65536))
        except OSError:
            return False
    return True

while time.monotonic() < deadline:
    if not read():
        break
    sessions = []
    if os.path.exists(start_log):
        with open(start_log, "rb") as log:
            sessions = log.read().splitlines()
    if sessions and first_session is None:
        first_session = sessions[0]
    if first_session and not opened_second:
        os.write(fd, b"\x0f" + os.environ["NETA_RMUX_E2E_OTHER"].encode() + b"\r")
        opened_second = True
    elif opened_second and len(set(sessions)) >= 2 and not opened_overflow:
        # The narrow tab strip overflows. Navigation-mode t opens the menu;
        # an ordinary x must be captured by it, never forwarded to Pi.
        os.write(fd, b"\x00t")
        opened_overflow = True
        stage_at = time.monotonic()
    elif opened_overflow and b"TABS" in output and not selected_hidden:
        os.write(fd, b"x\x1b[B\r")
        selected_hidden = True
        stage_at = time.monotonic()
    elif selected_hidden and not closed_view and time.monotonic() - stage_at > .35:
        os.write(fd, b"x")
        closed_view = True
        stage_at = time.monotonic()
    elif closed_view and not reopened and time.monotonic() - stage_at > .35:
        os.write(fd, b"\x0f" + os.getcwd().encode() + b"\r")
        reopened = True
        stage_at = time.monotonic()
    elif reopened and not sent_input and time.monotonic() - stage_at > .7:
        os.write(fd, b"z")
        sent_input = True
        stage_at = time.monotonic()
    elif sent_input and first_session is not None and time.monotonic() - stage_at > 1:
        with open(start_log, "rb") as log:
            if len(log.read().splitlines()) != 2:
                raise AssertionError("closing/reopening started an extra Pi")
        with open(input_log, "rb") as log:
            forwarded = log.read()
            if forwarded != b"z":
                raise AssertionError(f"overflow or navigation input reached Pi: {forwarded!r}")
        with open(session_input_log, "rb") as log:
            if log.read() != first_session + b":7a\n":
                raise AssertionError("reopened view did not receive input on its exact session")
        with open(cwd_log, "rb") as log:
            cwd_entries = log.read().splitlines()
        if len(cwd_entries) != 2:
            raise AssertionError(f"unexpected Pi cwd starts: {cwd_entries!r}")
        parsed_cwds = [entry.split(b":", 1) for entry in cwd_entries]
        if any(len(entry) != 2 for entry in parsed_cwds):
            raise AssertionError(f"malformed Pi cwd starts: {cwd_entries!r}")
        if parsed_cwds[0][0] != first_session or os.path.realpath(parsed_cwds[0][1].decode()) != os.path.realpath(os.getcwd()):
            raise AssertionError(f"first Pi did not start in its workspace: {cwd_entries!r}")
        if not any(os.path.realpath(cwd.decode()) == os.path.realpath(os.environ["NETA_RMUX_E2E_OTHER"]) for _, cwd in parsed_cwds):
            raise AssertionError(f"second Pi did not start in its workspace: {cwd_entries!r}")
        os.write(fd, b"\x11")
        quit_deadline = time.monotonic() + 3
        while time.monotonic() < quit_deadline and read():
            ended, status = os.waitpid(pid, os.WNOHANG)
            if ended:
                if os.waitstatus_to_exitcode(status) != 0:
                    raise AssertionError("rmux exited after tab selection")
                print("rmux tab e2e: exact session tab selected")
                sys.exit(0)
        raise AssertionError("rmux did not exit after tab selection")
    ended, status = os.waitpid(pid, os.WNOHANG)
    if ended:
        raise AssertionError(f"rmux exited early {os.waitstatus_to_exitcode(status)} output={bytes(output[-4096:])!r}")

raise AssertionError(f"rmux tab e2e timed out; first={first_session!r} second={opened_second} overflow={opened_overflow} selected={selected_hidden} closed={closed_view} reopened={reopened} input={sent_input} output={bytes(output[-8192:])!r}")
