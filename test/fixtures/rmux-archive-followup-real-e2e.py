#!/usr/bin/env python3
import atexit, fcntl, json, os, pty, select, struct, sys, termios, time

pid, fd = pty.fork()
if pid == 0:
    os.execvpe(os.environ["NETA_RMUX_BINARY"], [os.environ["NETA_RMUX_BINARY"]], os.environ)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
output = bytearray(); stage = 0; stage_at = time.monotonic(); deadline = time.monotonic() + 25
capture = os.environ["NETA_FOLLOWUP_PROMPT_CAPTURE"]
old = b"EXISTING_EDITOR_MARKER"
after_insert = 0

def prompts():
    if not os.path.exists(capture): return []
    with open(capture, encoding="utf-8") as f: return [json.loads(line) for line in f if line.strip()]
def read():
    ready, _, _ = select.select([fd], [], [], .1)
    if ready:
        try: output.extend(os.read(fd, 65536))
        except OSError: return False
    return True
def fail(reason): raise AssertionError(f"{reason}; prompts={prompts()!r}; terminal={bytes(output[-8192:])!r}")
def cleanup():
    try: os.kill(pid, 15)
    except ProcessLookupError: pass
atexit.register(cleanup)

while time.monotonic() < deadline:
    if not read(): break
    now = time.monotonic()
    if stage == 0 and b"fake \xc2\xb7 test-model" in output:
        os.write(fd, old)
        # Navigation is explicit; typing above must remain in Pi's editor.
        os.write(fd, b"\x00")
        os.write(fd, b"\x1b[<0;10;12M")
        stage = 1; stage_at = now
    elif stage == 1 and b"Saved Ada" in output:
        os.write(fd, b"\x1b[<0;10;14M")
        stage = 2; stage_at = now
    elif stage == 2 and b"agent: archive block 2" in output:
        os.write(fd, b"f"); stage = 3; stage_at = now
    elif stage == 3 and b"Keep the completed transcript." in output:
        after_insert = len(output)
        os.write(fd, b"\r"); stage = 4; stage_at = now
    elif stage == 4 and b"Do not resume the archived" in output[after_insert:]:
        if prompts(): fail("follow-up submitted before Enter")
        os.write(fd, b"\r"); stage = 5; stage_at = now
    elif stage == 5 and len(prompts()) == 1:
        prompt = prompts()[0]
        source = os.environ["NETA_FOLLOWUP_SOURCE_MISSION_ID"]
        expected = f"EXISTING_EDITOR_MARKERCreate a new mission with neta_mission. Choose a meaningful name and set its `continues` parameter to `{source}`. Use this original objective as context:\n\n> Keep the completed transcript.\n\nDo not resume the archived session."
        if prompt != expected:
            fail("leader editor text or follow-up draft was not preserved")
        os.write(fd, b"\x11")
        print("rmux real Pi follow-up: preserved editor, no autosubmit, exact prompt passed")
        sys.exit(0)
    elif now - stage_at > 5: fail(f"timed out at stage {stage}")

fail(f"overall timeout at stage {stage}")
