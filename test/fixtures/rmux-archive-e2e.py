#!/usr/bin/env python3
import atexit, fcntl, json, os, pty, select, socket, struct, sys, termios, time

pid, fd = pty.fork()
if pid == 0:
    binary = os.environ.get("NETA_RMUX_BINARY")
    if binary:
        os.execvpe(binary, [binary], os.environ)
    os.execvpe("bun", ["bun", "src/cli/main.ts", "rmux"], os.environ)

def cleanup():
    try:
        ended, _ = os.waitpid(pid, os.WNOHANG)
        if ended:
            return
        os.kill(pid, 15)
        for _ in range(10):
            ended, _ = os.waitpid(pid, os.WNOHANG)
            if ended:
                return
            time.sleep(.1)
        os.kill(pid, 9)
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    except ProcessLookupError:
        pass

atexit.register(cleanup)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
output = bytearray()
deadline = time.monotonic() + 25
stage = 0
stage_at = 0.0
input_log = os.environ["NETA_FAKE_PI_INPUT_LOG"]
start_log = os.environ["NETA_FAKE_PI_START_LOG"]
input_offset = 0
followup_input_offset = 0
followup_preview_offset = 0

def read():
    ready, _, _ = select.select([fd], [], [], .1)
    if ready:
        try:
            output.extend(os.read(fd, 65536))
        except OSError:
            return False
    return True

def diagnostic():
    return bytes(output[-8192:]).decode("utf-8", "backslashreplace")

def rpc_diagnostic():
    try:
        with open(os.path.join(os.environ["NETA_DIR"], "node.json")) as descriptor_file:
            descriptor = json.load(descriptor_file)
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(1)
        connection.connect(descriptor["socket"])
        stream = connection.makefile("rwb")
        def request(request_id, method, params):
            stream.write((json.dumps({"jsonrpc":"2.0", "id":request_id, "method":method, "params":params}) + "\n").encode())
            stream.flush()
            return json.loads(stream.readline())
        request(1, "hello", {"token": descriptor["token"], "client":"desktop", "protocolVersion":3})
        missions = request(2, "missions.list", {"workspaceId":"git:github.com/sudhanshug16/neta", "limit":50})
        mission_id = missions.get("result", {}).get("missions", [{}])[0].get("id")
        return {"missions": missions, "detail": request(3, "missions.get", {"missionId": mission_id})}
    except Exception as error:
        return f"rpc diagnostic failed: {error!r}"

while time.monotonic() < deadline:
    if not read():
        break
    now = time.monotonic()
    if stage == 0 and b"FAKE_PI_READY" in output:
        # The date group adds one non-selectable display line before the
        # archive group. Click it to exercise
        # the same selection path a person uses and avoid timing a focus flip.
        os.write(fd, b"\x1b[<0;10;12M")
        stage = 1
        stage_at = now
    elif stage == 1 and b"Saved Ada" in output:
        # The saved agent is directly below the expanded archive group.
        os.write(fd, b"\x1b[<0;10;14M")
        stage = 2
        stage_at = now
    elif stage == 1 and now - stage_at > 3:
        raise AssertionError(f"archive row missing; rpc={rpc_diagnostic()!r}; terminal={diagnostic()!r}")
    elif stage == 2 and b"agent: archive block 2" in output:
        # Archive first renders its latest persisted page. End exposes that
        # page's newest marker before PageUp asks for the older page.
        os.write(fd, b"\x1b[F")
        stage = 3
        stage_at = now
    elif stage == 2 and now - stage_at > 3:
        raise AssertionError(f"initial archive page missing; terminal={diagnostic()!r}")
    elif stage == 3 and b"ARCHIVE_NEW_EXACT_SESSION" in output:
        os.write(fd, b"\x1b[5~")
        stage = 4
        stage_at = now
    elif stage == 3 and now - stage_at > 3:
        raise AssertionError(f"newest archive marker missing; terminal={diagnostic()!r}")
    elif stage == 4 and b"ARCHIVE_OLD_EXACT_SESSION" in output:
        input_offset = os.path.getsize(input_log) if os.path.exists(input_log) else 0
        # Neither ordinary key input nor a pane click may leave read-only view.
        os.write(fd, b"x\x1b[200~archive-paste\x1b[201~\x1b[<0;60;10M")
        stage = 5
        stage_at = now
    elif stage == 4 and now - stage_at > 3:
        raise AssertionError(f"older archive marker missing; terminal={diagnostic()!r}")
    elif stage == 5 and now - stage_at > .35:
        forwarded = b""
        if os.path.exists(input_log):
            with open(input_log, "rb") as log:
                forwarded = log.read()[input_offset:]
        with open(start_log, "rb") as log:
            starts = log.read().splitlines()
        if forwarded != b"":
            raise AssertionError(f"archive input reached Pi: {forwarded!r}; terminal={diagnostic()!r}")
        if len(starts) != 1:
            raise AssertionError(f"archive selection started Pi sessions {starts!r}; terminal={diagnostic()!r}")
        os.write(fd, b"e")
        stage = 6
        stage_at = now
    elif stage == 6 and now - stage_at > .5 and b"Enter saves" in output:
        export_path = os.path.join(os.environ["NETA_DIR"], "archive-export.json")
        os.write(fd, b"\x15")
        time.sleep(.2)
        os.write(fd, export_path.encode() + b"\r")
        stage = 7
        stage_at = now
    elif stage == 6 and now - stage_at > 3:
        raise AssertionError(f"archive export prompt missing; terminal={diagnostic()!r}")
    elif stage == 7 and b"Exported archived session" in output:
        export_path = os.path.join(os.environ["NETA_DIR"], "archive-export.json")
        if not os.path.isfile(export_path):
            raise AssertionError(f"expected archive export at {export_path!r}; terminal={diagnostic()!r}")
        with open(export_path) as exported_file:
            exported = json.load(exported_file)
        pages = exported.get("pages", [])
        if exported.get("scope") != "archived session" or not pages or pages[0].get("blocks", [{}])[0].get("text") != "ARCHIVE_OLD_EXACT_SESSION":
            raise AssertionError(f"archive export omitted saved transcript: {exported!r}")
        os.write(fd, b"e\x1b")
        stage = 8
        stage_at = now
    elif stage == 7 and now - stage_at > 3:
        raise AssertionError(f"archive export did not complete; terminal={diagnostic()!r}")
    elif stage == 8 and now - stage_at > .35:
        # The archive has no live Pi pane. Follow-up first previews the
        # original mission objective; cancelling must leave this saved view.
        os.write(fd, b"f")
        stage = 9
        stage_at = now
    elif stage == 9 and b"Start follow-up" in output and b"Keep the completed transcript." in output:
        os.write(fd, b"\x1b")
        stage = 10
        stage_at = now
    elif stage == 9 and now - stage_at > 3:
        raise AssertionError(f"follow-up preview/objective missing; terminal={diagnostic()!r}")
    elif stage == 10 and now - stage_at > .25:
        # Reopening after Esc proves the archive remained in place.  Capture
        # Pi input only from the confirmed insertion onward.
        if b"ARCHIVE_OLD_EXACT_SESSION" not in output:
            raise AssertionError(f"Esc left the archived transcript: {diagnostic()!r}")
        followup_input_offset = os.path.getsize(input_log) if os.path.exists(input_log) else 0
        followup_preview_offset = len(output)
        os.write(fd, b"f")
        stage = 11
        stage_at = now
    elif stage == 11 and b"Keep the completed transcript." in output[followup_preview_offset:]:
        os.write(fd, b"\r")
        stage = 12
        stage_at = now
    elif stage == 11 and now - stage_at > 3:
        raise AssertionError(f"follow-up preview did not reopen after Esc; terminal={diagnostic()!r}")
    elif stage == 12 and now - stage_at > .5:
        with open(input_log, "rb") as log:
            inserted = log.read()[followup_input_offset:]
        expected = b"Create a new mission with neta_mission. Choose a meaningful name"
        continues = b"`continues` parameter to `"
        if not inserted.startswith(b"\x1b[200~") or expected not in inserted or continues not in inserted or b"Do not resume the archived session." not in inserted:
            raise AssertionError(f"follow-up draft was not bracketed leader input: {inserted!r}; terminal={diagnostic()!r}")
        if not inserted.endswith(b"\x1b[201~") or b"\r" in inserted or b"\x15" in inserted:
            raise AssertionError(f"follow-up draft cleared or submitted the leader editor: {inserted!r}")
        with open(start_log, "rb") as log:
            starts = log.read().splitlines()
        if len(starts) != 1:
            raise AssertionError(f"follow-up started archived/new Pi instead of workspace leader: {starts!r}")
        os.write(fd, b"\x11")
        stage = 13
    ended, status = os.waitpid(pid, os.WNOHANG)
    if ended:
        code = os.waitstatus_to_exitcode(status)
        if code == 0 and stage == 13:
            print("rmux archive e2e: history, follow-up preview/draft routing, and export passed")
            sys.exit(0)
        raise AssertionError(f"rmux exited early {code}; stage={stage}; terminal={diagnostic()!r}")

try:
    os.kill(pid, 15)
except ProcessLookupError:
    pass
for _ in range(10):
    ended, _ = os.waitpid(pid, os.WNOHANG)
    if ended:
        break
    time.sleep(.1)
else:
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
raise AssertionError(f"rmux archive e2e timed out; stage={stage}; terminal={diagnostic()!r}")
