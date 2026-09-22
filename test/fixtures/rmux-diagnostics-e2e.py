#!/usr/bin/env python3
import atexit, fcntl, json, os, pty, re, select, struct, sys, termios, time

pid, fd = pty.fork()
if pid == 0:
    binary = os.environ["NETA_RMUX_BINARY"]
    os.execvpe(binary, [binary], os.environ)

def stop():
    try:
        if os.waitpid(pid, os.WNOHANG)[0]: return
        os.kill(pid, 15)
        for _ in range(10):
            if os.waitpid(pid, os.WNOHANG)[0]: return
            time.sleep(.1)
        os.kill(pid, 9); os.waitpid(pid, 0)
    except (ChildProcessError, ProcessLookupError): pass
atexit.register(stop)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
output = bytearray()
input_log = os.environ["NETA_FAKE_PI_INPUT_LOG"]
destination = os.path.join(os.environ["NETA_DIR"], "diagnostics-export")
cancelled = os.path.join(os.environ["NETA_DIR"], "diagnostics-cancelled")
stage = 0; at = 0; input_offset = 0

def read():
    ready, _, _ = select.select([fd], [], [], .1)
    if ready:
        try: output.extend(os.read(fd, 65536))
        except OSError: return False
    return True
def text(): return bytes(output[-8192:]).decode("utf-8", "backslashreplace")
def visible(): return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", bytes(output).decode("utf-8", "backslashreplace"))
def paste(value):
    os.write(fd, b"\x1b[200~" + value.encode() + b"\x1b[201~")
def pi_input():
    if not os.path.exists(input_log): return b""
    with open(input_log, "rb") as source: return source.read()[input_offset:]

deadline = time.monotonic() + 25
while time.monotonic() < deadline:
    if not read(): break
    now = time.monotonic()
    if stage == 0 and b"FAKE_PI_READY" in output:
        input_offset = os.path.getsize(input_log) if os.path.exists(input_log) else 0
        os.write(fd, b"\x0f" + os.environ["NETA_RMUX_E2E_OTHER"].encode() + b"\r")
        stage = 1; at = now
    elif stage == 1 and output.count(b"FAKE_PI_READY") >= 2:
        # The active second tab is deliberately closed before export. Its Pi
        # root remains registered so the export carries durable client state.
        os.write(fd, b"\x00xE")
        stage = 2; at = now
    elif stage == 1 and now - at > 3:
        raise AssertionError(f"second Pi tab did not open: {text()!r}")
    elif stage == 2 and b"DIAGNOSTICS EXPORT" in output and b"Destination:" in output:
        os.write(fd, b"\x15"); paste(destination); os.write(fd, b"\r")
        stage = 3; at = now
    elif stage == 2 and now - at > 3:
        raise AssertionError(f"diagnostics dialog missing: {text()!r}")
    elif stage == 3 and os.path.isfile(os.path.join(destination, "manifest.json")):
        if pi_input() != b"": raise AssertionError(f"diagnostics keys reached Pi: {pi_input()!r}")
        manifest_path = os.path.join(destination, "manifest.json")
        if not os.path.isfile(manifest_path): raise AssertionError(f"missing diagnostics manifest: {text()!r}")
        with open(manifest_path) as source: manifest = json.load(source)
        if manifest.get("status") != "complete": raise AssertionError(f"unexpected export status: {manifest!r}")
        machine_roots = os.listdir(os.path.join(destination, "machines"))
        exported_machine = os.path.join(destination, "machines", machine_roots[0], "data", "machine.json")
        with open(os.path.join(os.environ["NETA_DIR"], "machine.json"), "rb") as source: original = source.read()
        with open(exported_machine, "rb") as source: copied = source.read()
        if copied != original: raise AssertionError("diagnostic machine source bytes changed during export")
        client_transcripts = []
        for root, _, files in os.walk(os.path.join(destination, "client")):
            if "fake-client-transcript.jsonl" in files: client_transcripts.append(os.path.join(root, "fake-client-transcript.jsonl"))
        if len(client_transcripts) != 2 or any(open(path, "rb").read() != b"FAKE_CLIENT_PI_TRANSCRIPT" for path in client_transcripts): raise AssertionError("open or closed client Pi transcript missing or changed")
        marker = b"ARCHIVE_OLD_EXACT_SESSION"
        source_marker = None
        for root, _, files in os.walk(os.path.join(os.environ["NETA_DIR"], "conversations")):
            for name in files:
                candidate = os.path.join(root, name)
                if marker in open(candidate, "rb").read(): source_marker = candidate; break
            if source_marker: break
        if source_marker is None: raise AssertionError("seeded conversation marker missing from Node state")
        relative = os.path.relpath(source_marker, os.environ["NETA_DIR"])
        copied_marker = os.path.join(destination, "machines", machine_roots[0], "data", relative)
        if open(copied_marker, "rb").read() != open(source_marker, "rb").read(): raise AssertionError("diagnostic transcript bytes changed during export")
        stage = 21; at = now
    elif stage == 21 and now - at > 3:
        if "Exported diagnostics to" not in visible(): raise AssertionError(f"success status missing: {text()!r}")
        os.write(fd, b"E")
        stage = 3; at = now
    elif stage == 3 and now - at > 8:
        raise AssertionError(f"diagnostics export did not finish: {text()!r}")
    elif stage == 3 and b"DIAGNOSTICS EXPORT" in output:
        os.write(fd, b"\x15"); paste(cancelled); os.write(fd, b"\x1b")
        stage = 4; at = now
    elif stage == 3 and now - at > 3:
        raise AssertionError(f"second diagnostics dialog missing: {text()!r}")
    elif stage == 4 and now - at > .3:
        if os.path.exists(cancelled): raise AssertionError("Escape created diagnostics destination")
        if pi_input() != b"": raise AssertionError(f"cancelled diagnostics input reached Pi: {pi_input()!r}")
        os.write(fd, b"\x11")
        stage = 5
    ended, status = os.waitpid(pid, os.WNOHANG)
    if ended:
        if os.waitstatus_to_exitcode(status) == 0 and stage == 5:
            print("rmux diagnostics e2e: modal, export, source bytes, and cancel passed")
            sys.exit(0)
        raise AssertionError(f"rmux exited early at stage {stage}: {text()!r}")
raise AssertionError(f"rmux diagnostics timed out at stage {stage}: {text()!r}")
