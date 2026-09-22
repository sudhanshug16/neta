#!/usr/bin/env python3
import atexit, fcntl, json, os, pty, select, struct, sys, termios, time

pid, fd = pty.fork()
if pid == 0: os.execvpe("node", ["node", os.environ["NETA_PACKAGED_CLI"], "rmux"], os.environ)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
output = bytearray(); stage = 0; deadline = time.monotonic() + 25
capture = os.environ["NETA_PACKAGED_PROMPTS"]
def cleanup():
    try: os.kill(pid, 15)
    except ProcessLookupError: pass
atexit.register(cleanup)
def prompts():
    if not os.path.exists(capture): return []
    with open(capture, encoding="utf8") as file: return [json.loads(line) for line in file if line.strip()]
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], .1)
    if ready:
        try: output.extend(os.read(fd, 65536))
        except OSError: break
    if stage == 0 and b"fake \xc2\xb7 test-model" in output:
        os.write(fd, b"PACKAGED_SMOKE\r"); stage = 1
    elif stage == 1 and prompts() == ["PACKAGED_SMOKE"]:
        os.write(fd, b"\x11"); stage = 2
    ended, status = os.waitpid(pid, os.WNOHANG)
    if ended:
        if stage == 2 and os.waitstatus_to_exitcode(status) == 0:
            print("packaged rmux real Pi e2e passed"); sys.exit(0)
        raise AssertionError(f"packaged rmux exited early {os.waitstatus_to_exitcode(status)} stage={stage} tail={bytes(output[-8192:])!r}")
raise AssertionError(f"packaged rmux timed out stage={stage} prompts={prompts()!r} tail={bytes(output[-8192:])!r}")
