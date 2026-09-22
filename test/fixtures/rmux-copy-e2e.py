#!/usr/bin/env python3
import base64, fcntl, json, os, pty, select, struct, sys, termios, time

source = "copy α\ncopy β"
clipboard = b"\x1b]52;c;" + base64.b64encode(source.encode()) + b"\x07"
prompt_capture = os.environ["NETA_COPY_PROMPT_CAPTURE"]

pid, fd = pty.fork()
if pid == 0:
    os.execvpe("bun", ["bun", "src/cli/main.ts", "rmux"], os.environ)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
output = bytearray()
sent_source = copied = pasted = sent_quit = False
deadline = time.monotonic() + 25

def prompts():
    if not os.path.exists(prompt_capture):
        return []
    with open(prompt_capture, encoding="utf-8") as file:
        return [json.loads(line) for line in file if line.strip()]

try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], .1)
        if ready:
            try:
                output.extend(os.read(fd, 65536))
            except OSError:
                break
        if "fake · test-model".encode() in output and not sent_source:
            os.write(fd, b"COPY_MULTILINE\r")
            sent_source = True
        if sent_source and prompts() == ["COPY_MULTILINE"] and not copied:
            os.write(fd, b"/neta-copy\r")
            copied = True
        if copied and clipboard in output and not pasted:
            os.write(fd, b"\x1b[200~" + source.encode() + b"\x1b[201~\r")
            pasted = True
        if pasted and prompts() == ["COPY_MULTILINE", source] and not sent_quit:
            os.write(fd, b"\x11")
            sent_quit = True
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            code = os.waitstatus_to_exitcode(status)
            if code == 0 and sent_quit:
                print("rmux copy e2e: OSC 52 and bracketed paste preserved Unicode multiline text")
                sys.exit(0)
            raise RuntimeError(f"premature rmux exit {code}; source={sent_source} copied={copied} pasted={pasted} tail={bytes(output[-4096:])!r}")
    raise RuntimeError(f"timeout source={sent_source} copied={copied} pasted={pasted} prompts={prompts()} tail={bytes(output[-4096:])!r}")
finally:
    try:
        os.kill(pid, 15)
    except ProcessLookupError:
        pass
