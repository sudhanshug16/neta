#!/usr/bin/env python3
import fcntl, os, pty, select, struct, sys, termios, time

root = os.environ["NETA_PI_VERIFY_ROOT"]
argv = [
    "node", f"{root}/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    "--session-dir", os.environ["NETA_PI_VERIFY_SESSION_DIR"],
    "--session-id", os.environ.get("NETA_TARGET_SESSION_ID", "pi-acp-real"),
    "--tui-mode", "fullscreen",
    "--extension", f"{root}/src/rmux/pi-acp-extension.ts",
    "--provider", os.environ.get("NETA_PI_PROVIDER", "neta-acp"),
    "--model", os.environ.get("NETA_PI_MODEL", "test-model"),
]
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("node", argv, os.environ)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

output = bytearray()
def read_for(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], .1)
        if ready:
            try:
                output.extend(os.read(fd, 65536))
            except OSError:
                return False
    return True

ready_marker = os.environ.get("NETA_PI_READY_MARKER", "fake · test-model").encode()
reset_mode = os.environ.get("NETA_PI_RESET_MODE") == "1"
ready_deadline = time.monotonic() + 8
while ready_marker not in output and time.monotonic() < ready_deadline:
    if not read_for(.1):
        break
if ready_marker in output:
    switch_provider = os.environ.get("NETA_PI_SWITCH_PROVIDER")
    if switch_provider:
        os.write(fd, f"/neta-providers {switch_provider}".encode() + b"\r")
        switch_marker = os.environ.get("NETA_PI_SWITCH_MARKER", f"Provider changed to {switch_provider}.").encode()
        switch_deadline = time.monotonic() + 8
        while switch_marker not in output and time.monotonic() < switch_deadline:
            if not read_for(.1):
                break
    os.write(fd, os.environ.get("NETA_PI_PROMPT", "real Pi prompt").encode() + b"\r")
    if reset_mode:
        first_marker = os.environ.get("NETA_PI_RESET_FIRST_MARKER", "REMOTE_TEXT").encode()
        first_deadline = time.monotonic() + 8
        while first_marker not in output and time.monotonic() < first_deadline:
            read_for(.1)
        if first_marker not in output:
            raise RuntimeError("first reset prompt did not complete")
        os.write(fd, b"/neta-reset\r")
        reset_marker = os.environ.get("NETA_PI_RESET_MARKER", "Conversation reset; attached the replacement session.").encode()
        reset_deadline = time.monotonic() + 8
        while reset_marker not in output and time.monotonic() < reset_deadline:
            read_for(.1)
        if reset_marker not in output:
            raise RuntimeError("reset command did not complete")
        os.write(fd, os.environ.get("NETA_PI_RESET_PROMPT", "fresh reset prompt").encode() + b"\r")
read_for(3)
try:
    os.write(fd, b"\x11")
except OSError:
    pass
read_for(1)
exit_code = 0
try:
    ended, status = os.waitpid(pid, os.WNOHANG)
    if ended:
        exit_code = os.waitstatus_to_exitcode(status)
    else:
        os.kill(pid, 15)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            ended, status = os.waitpid(pid, os.WNOHANG)
            if ended:
                # Ctrl+Q is handled by the interactive shell, but a terminal
                # teardown may race it. The fixture has already captured the
                # observable result, so its own cleanup is successful.
                exit_code = 0
                break
            time.sleep(.05)
        else:
            os.kill(pid, 9)
            _, status = os.waitpid(pid, 0)
            exit_code = 0
except ProcessLookupError:
    pass
except ChildProcessError:
    pass
sys.stdout.buffer.write(output)
sys.exit(exit_code)
