#!/usr/bin/env python3
import atexit, fcntl, os, pty, select, struct, sys, termios, time

pid, fd = pty.fork()
if pid == 0: os.execvpe("bun", ["bun", "src/cli/main.ts", "rmux"], os.environ)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
audit = os.environ["NETA_FAKE_PI_AUDIT_LOG"]
output = bytearray(); stage = 0; at = time.monotonic()

def cleanup():
    try:
        os.kill(pid, 15)
        for _ in range(10):
            if os.waitpid(pid, os.WNOHANG)[0]: return
            time.sleep(.1)
        os.kill(pid, 9); os.waitpid(pid, 0)
    except (ChildProcessError, ProcessLookupError): pass

atexit.register(cleanup)
while time.monotonic() < at + 25:
    ready, _, _ = select.select([fd], [], [], .1)
    if ready:
        try: output.extend(os.read(fd, 65536))
        except OSError: break
    lines = open(audit).read().splitlines() if os.path.exists(audit) else []
    starts = [line for line in lines if line.startswith("start:")]
    if stage == 0 and starts:
        os.write(fd, b"\x00m\x1b[B\r"); stage = 1; at = time.monotonic()
    elif stage == 1 and len(starts) >= 2:
        local_descriptor = starts[0].split(":", 2)[1]
        remote_descriptor = starts[1].split(":", 2)[1]
        shared_session = starts[0].rsplit(":", 1)[1]
        if remote_descriptor == local_descriptor: raise AssertionError("remote Pi used local descriptor")
        if starts[1].rsplit(":", 1)[1] != shared_session: raise AssertionError("fixture needs identical workspace session ids")
        # The two nodes intentionally expose the same workspace id and name.
        # Host-label search must select the already-open local tab.
        os.write(fd, b"\x0b"); stage = 2; at = time.monotonic()
    elif stage == 2 and time.monotonic() - at > .2:
        os.write(fd, b"Local machine"); stage = 3; at = time.monotonic()
    elif stage == 3 and time.monotonic() - at > .2:
        os.write(fd, b"\r"); stage = 4; at = time.monotonic()
    elif stage == 4 and time.monotonic() - at > .4:
        os.write(fd, b"l"); stage = 5; at = time.monotonic()
    elif stage == 5 and time.monotonic() - at > .7:
        inputs = open(audit).read().splitlines()
        if f"input:{local_descriptor}:{shared_session}:6c" not in inputs or f"input:{remote_descriptor}:{shared_session}:6c" in inputs:
            raise AssertionError("Ctrl+K local duplicate routed input to the wrong host")
        # The same workspace id/name on the second row must route back remotely.
        os.write(fd, b"\x0b"); stage = 6; at = time.monotonic()
    elif stage == 6 and time.monotonic() - at > .2:
        os.write(fd, b"Fake remote"); stage = 7; at = time.monotonic()
    elif stage == 7 and time.monotonic() - at > .2:
        os.write(fd, b"\r"); stage = 8; at = time.monotonic()
    elif stage == 8 and time.monotonic() - at > .4:
        os.write(fd, b"r"); stage = 9; at = time.monotonic()
    elif stage == 9 and time.monotonic() - at > .7:
        inputs = open(audit).read().splitlines()
        if f"input:{remote_descriptor}:{shared_session}:72" not in inputs or f"input:{local_descriptor}:{shared_session}:72" in inputs:
            raise AssertionError("Ctrl+K remote duplicate routed input to the wrong host")
        os.write(fd, b"\x11"); stage = 10
    ended, status = os.waitpid(pid, os.WNOHANG)
    if ended:
        if stage != 10 or os.waitstatus_to_exitcode(status) != 0: raise AssertionError(bytes(output[-4096:]))
        print("rmux workspace picker e2e passed"); sys.exit(0)
raise AssertionError(bytes(output[-4096:]))
