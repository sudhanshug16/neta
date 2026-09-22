#!/usr/bin/env python3
import atexit, fcntl, os, pty, select, signal, struct, sys, termios, time

pid, fd = pty.fork()
if pid == 0:
    os.execvpe("bun", ["bun", "src/cli/main.ts", "rmux"], os.environ)

def resize(cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    try:
        os.killpg(pid, signal.SIGWINCH)
    except ProcessLookupError:
        # pty.fork returns before the child has established its process group.
        # The terminal size is already set; later resizes signal normally.
        pass

resize(40, 24)
output = bytearray()
deadline = time.monotonic() + 25
stage = 0
stage_at = time.monotonic()
navigation_output_at = 0
start_log = os.environ["NETA_FAKE_PI_START_LOG"]
session_log = os.environ["NETA_FAKE_PI_SESSION_INPUT_LOG"]
size_log = os.environ["NETA_FAKE_PI_SIZE_LOG"]

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
    except (ChildProcessError, ProcessLookupError):
        pass

atexit.register(cleanup)
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], .1)
    if ready:
        try:
            output.extend(os.read(fd, 65536))
        except OSError:
            break
    now = time.monotonic()
    sizes = open(size_log, "rb").read() if os.path.exists(size_log) else b""
    # The pane reserves one row for its scoped breadcrumb below the tabs.
    if stage == 0 and b"SIZE:38x16" in sizes:
        os.write(fd, b"a\x7fb")
        stage, stage_at = 1, now
    elif stage == 1 and now - stage_at > .3:
        os.write(fd, b"\x00")
        navigation_output_at = len(output)
        stage, stage_at = 2, now
    elif stage == 2 and b"SPINE" in output[navigation_output_at:] and b"NAVIGATION" in output[navigation_output_at:]:
        os.write(fd, b"\r")
        stage, stage_at = 3, now
    elif stage == 3 and now - stage_at > .3:
        os.write(fd, b"\x00c")
        stage, stage_at = 4, now
    elif stage == 4 and b"SIZE:40x24" in sizes:
        os.write(fd, b"\x00")
        stage, stage_at = 5, now
    elif stage == 5 and sizes.count(b"SIZE:38x16") >= 2:
        os.write(fd, b"\x00c")
        resize(80, 24)
        stage, stage_at = 6, now
    elif stage == 6 and b"SIZE:54x16" in sizes:
        resize(40, 24)
        stage, stage_at = 7, now
    elif stage == 7 and sizes.count(b"SIZE:38x16") >= 3:
        with open(start_log, "rb") as log: sessions = log.read().splitlines()
        with open(session_log, "rb") as log: audit = log.read()
        received = b"".join(bytes.fromhex(line.split(b":", 1)[1].decode()) for line in audit.splitlines() if line.startswith(sessions[0] + b":"))
        if len(sessions) != 1 or received != b"a\x7fbc":
            raise AssertionError(f"compact input/session audit failed: sessions={sessions!r} audit={audit!r}")
        stage, stage_at = 8, now
    elif stage == 8 and now - stage_at > .3:
        os.write(fd, b"\x11")
        stage, stage_at = 9, now
    ended, status = os.waitpid(pid, os.WNOHANG)
    if ended:
        if stage == 9 and os.waitstatus_to_exitcode(status) == 0:
            print("rmux compact e2e: copy view, navigation, resize, and quit passed")
            sys.exit(0)
        raise AssertionError(f"rmux exited early {os.waitstatus_to_exitcode(status)} stage={stage} output={bytes(output[-4096:] )!r}")

sizes = open(size_log, "rb").read() if os.path.exists(size_log) else b""
starts = open(start_log, "rb").read() if os.path.exists(start_log) else b""
audit = open(session_log, "rb").read() if os.path.exists(session_log) else b""
decoded = []
for line in audit.splitlines():
    try:
        session, encoded = line.split(b":", 1)
        decoded.append((session, bytes.fromhex(encoded.decode())))
    except (UnicodeDecodeError, ValueError):
        decoded.append((b"invalid", line))
raise AssertionError(
    f"rmux compact e2e timed out stage={stage} sizes={sizes!r} starts={starts!r} "
    f"decoded_input={decoded!r} output={bytes(output[-8192:])!r}"
)
