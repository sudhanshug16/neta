#!/usr/bin/env python3
import atexit, fcntl, json, os, pty, select, struct, sys, termios, time

pid, fd = pty.fork()
if pid == 0: os.execvpe(os.environ["NETA_RMUX_BINARY"], [os.environ["NETA_RMUX_BINARY"]], os.environ)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
output = bytearray(); stage = 0; stage_at = time.monotonic(); deadline = time.monotonic() + 25
capture = os.environ["NETA_FOLLOWUP_PROMPT_CAPTURE"]; gate = os.environ["NETA_PI_GATE_FILE"]; started = os.environ["NETA_PI_GATE_STARTED_FILE"]
after_release = 0

def prompts():
    if not os.path.exists(capture): return []
    with open(capture, encoding="utf-8") as f: return [json.loads(line) for line in f if line.strip()]
def read():
    ready, _, _ = select.select([fd], [], [], .1)
    if ready:
        try: output.extend(os.read(fd, 65536))
        except OSError: return False
    return True
def fail(reason): raise AssertionError(f"{reason}; prompts={prompts()!r}; terminal={bytes(output[-4096:])!r}")
def cleanup():
    try: os.kill(pid, 15)
    except ProcessLookupError: pass
atexit.register(cleanup)

while time.monotonic() < deadline:
    if not read(): break
    now = time.monotonic()
    if stage == 0 and os.path.exists(started) and b"Saved archive" in output:
        os.write(fd, b"\x1b[<0;10;12M"); stage = 1; stage_at = now
    elif stage == 1 and b"Saved Ada" in output:
        os.write(fd, b"\x1b[<0;10;14M"); stage = 2; stage_at = now
    elif stage == 2 and b"agent: archive block 2" in output:
        os.write(fd, b"f"); stage = 3; stage_at = now
    elif stage == 3 and b"Keep the completed transcript." in output:
        os.write(fd, b"\r"); stage = 4; stage_at = now
    elif stage == 4:
        if prompts(): fail("follow-up submitted while Pi launch was gated")
        with open(gate, "w", encoding="utf-8") as f: f.write("release")
        after_release = len(output)
        stage = 5; stage_at = now
    elif stage == 5 and b"archived" in output[after_release:]:
        if prompts(): fail("follow-up submitted before Enter")
        os.write(fd, b"\r"); stage = 6; stage_at = now
    elif stage == 6 and len(prompts()) == 1:
        source = os.environ["NETA_FOLLOWUP_SOURCE_MISSION_ID"]
        expected = f"Create a new mission with neta_mission. Choose a meaningful name and set its `continues` parameter to `{source}`. Use this original objective as context:\n\n> Keep the completed transcript.\n\nDo not resume the archived session."
        if prompts()[0] != expected: fail("cold Pi draft was altered")
        os.write(fd, b"\x11")
        print("rmux cold real Pi follow-up: gated launch kept draft pending until editor ready")
        sys.exit(0)
    elif now - stage_at > 5: fail(f"timed out at stage {stage}")
fail(f"overall timeout at stage {stage}")
