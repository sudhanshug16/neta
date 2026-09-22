#!/usr/bin/env python3
import atexit, fcntl, glob, os, pty, re, select, shutil, struct, subprocess, sys, termios, time

pid, fd = pty.fork()
if pid == 0: os.execvpe("bun", ["bun", "src/cli/main.ts", "rmux"], os.environ)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
audit = os.environ["NETA_FAKE_PI_AUDIT_LOG"]
remote_dir = os.environ["NETA_RMUX_REMOTE_DIR"]
expected_remote_agent_session = os.environ.get("NETA_RMUX_REMOTE_AGENT_SESSION", "remote-agent-session")
failed_legacy = os.environ.get("NETA_RMUX_STALE_FAILURE_DIR")
failed_scoped_backup = None
output = bytearray(); stage = 0; at = time.monotonic()
def screen(): return re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", bytes(output))
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
        if starts[0].split(":", 2)[1] == starts[1].split(":", 2)[1]: raise AssertionError("remote Pi used local descriptor")
        local_descriptor = starts[0].split(":", 2)[1]
        remote_descriptor = starts[1].split(":", 2)[1]
        local_session = starts[0].rsplit(":", 1)[1]
        remote_leader_session = starts[1].rsplit(":", 1)[1]
        os.write(fd, b"\x00\x1b[B\x1b[C\x1b[B\r"); stage = 2; at = time.monotonic()
    elif stage == 2 and len(starts) >= 3:
        remote_agent_session = starts[2].rsplit(":", 1)[1]
        if remote_agent_session != expected_remote_agent_session: raise AssertionError(f"selected wrong remote target: {remote_agent_session}")
        os.write(fd, b"r"); stage = 3; at = time.monotonic()
    elif stage == 3 and time.monotonic() - at > .7:
        inputs = open(audit).read().splitlines()
        if f"input:{remote_descriptor}:{remote_agent_session}:72" not in inputs: raise AssertionError("selected remote agent missed input")
        if f"input:{remote_descriptor}:{remote_leader_session}:72" in inputs: raise AssertionError("selected remote leader received agent input")
        if f"input:{local_descriptor}:{local_session}:72" in inputs: raise AssertionError("remote agent input crossed descriptor")
        subprocess.run(["bun", "src/cli/main.ts", "node", "stop"], env={**os.environ, "NETA_DIR": remote_dir}, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.write(fd, b"z"); time.sleep(.7)
        inputs = open(audit).read().splitlines()
        if f"input:{remote_descriptor}:{remote_agent_session}:7a" in inputs: raise AssertionError("offline input reached stale remote agent")
        if failed_legacy:
            legacy_name = os.path.basename(failed_legacy)
            host_component, session_component = legacy_name.rsplit("-s", 1)
            scoped = glob.glob(os.path.join(os.path.dirname(failed_legacy), f"{host_component}-w*-s{session_component}"))
            if len(scoped) != 1: raise AssertionError(f"expected one scoped Pi root, found {scoped}")
            failed_scoped_backup = f"{failed_legacy}.scoped-backup"
            if os.path.exists(failed_scoped_backup): raise AssertionError("test scoped Pi backup already exists")
            os.rename(scoped[0], failed_scoped_backup)
            os.makedirs(failed_legacy)
            with open(os.path.join(failed_legacy, "history.jsonl"), "w") as history: history.write("not a Pi session header\n")
        subprocess.run(["bun", "src/cli/main.ts", "node", "start", "--detach"], env={**os.environ, "NETA_DIR": remote_dir}, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.write(fd, b"\x00m\x1b[B\r")
        stage = 5; at = time.monotonic()
    elif stage == 5 and failed_legacy and b"Pi pane unavailable" in screen():
        if len(starts) != 3: raise AssertionError("failed stale replacement started Pi")
        output.clear()
        os.write(fd, b"z"); time.sleep(.7)
        inputs = open(audit).read().splitlines()
        if f"input:{remote_descriptor}:{remote_agent_session}:7a" in inputs: raise AssertionError("unavailable pane forwarded input")
        shutil.rmtree(failed_legacy)
        os.rename(failed_scoped_backup, scoped[0])
        os.write(fd, b"\x00[")
        stage = 6; at = time.monotonic()
    elif stage == 5 and not failed_legacy and len(starts) >= 4:
        new_remote_descriptor = starts[3].split(":", 2)[1]
        if starts[3].rsplit(":", 1)[1] != remote_agent_session: raise AssertionError(f"remote reconnect changed selected agent session id: {starts}")
        if new_remote_descriptor == remote_descriptor: raise AssertionError("remote reconnect reused stale descriptor")
        os.write(fd, b"z"); stage = 7; at = time.monotonic()
    elif stage == 6 and len(starts) >= 4:
        if starts[3].rsplit(":", 1)[1] != remote_leader_session: raise AssertionError(f"tab switch selected wrong session: {starts}")
        os.write(fd, b"[")
        stage = 7; at = time.monotonic()
    elif stage == 7 and time.monotonic() - at > .3:
        os.write(fd, b"\x00l"); stage = 8; at = time.monotonic()
    elif stage == 8 and time.monotonic() - at > .7:
        inputs = open(audit).read().splitlines()
        if f"input:{local_descriptor}:{local_session}:6c" not in inputs: raise AssertionError(f"healthy local pane did not receive input: {inputs}")
        if b"Pi pane unavailable" in screen(): raise AssertionError("healthy pane still showed unavailable status")
        os.write(fd, b"\x00]")
        stage = 9; at = time.monotonic()
    elif stage == 9 and time.monotonic() - at > .3:
        os.write(fd, b"]")
        stage = 10; at = time.monotonic()
    elif stage == 10 and len(starts) >= 5:
        new_remote_descriptor = starts[4].split(":", 2)[1]
        if starts[4].rsplit(":", 1)[1] != remote_agent_session: raise AssertionError(f"remote reconnect changed selected agent session id: {starts}")
        if new_remote_descriptor == remote_descriptor: raise AssertionError("remote reconnect reused stale descriptor")
        os.write(fd, b"\x00z"); stage = 11; at = time.monotonic()
    elif stage == 11 and time.monotonic() - at > .7:
        inputs = open(audit).read().splitlines()
        if f"input:{new_remote_descriptor}:{remote_agent_session}:7a" not in inputs: raise AssertionError("reconnected selected agent missed new descriptor")
        if f"input:{new_remote_descriptor}:{remote_leader_session}:7a" in inputs: raise AssertionError("reconnect jumped to remote leader")
        if f"input:{remote_descriptor}:{remote_agent_session}:7a" in inputs: raise AssertionError("reconnected remote input crossed stale descriptor")
        if len([line for line in inputs if line.startswith("start:")]) != 5: raise AssertionError("unexpected Pi restart count")
        os.write(fd, b"\x11")
        stage = 12
    ended, status = os.waitpid(pid, os.WNOHANG)
    if ended:
        if stage != 12 or os.waitstatus_to_exitcode(status) != 0: raise AssertionError(bytes(output[-4096:]))
        print("rmux multi-host e2e passed"); sys.exit(0)
raise AssertionError(f"stage={stage} starts={starts} tail={bytes(output[-4096:])!r}")
