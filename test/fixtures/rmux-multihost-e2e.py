#!/usr/bin/env python3
import atexit, fcntl, os, pty, select, struct, subprocess, sys, termios, time
pid, fd = pty.fork()
if pid == 0: os.execvpe("bun", ["bun", "src/cli/main.ts", "rmux"], os.environ)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
audit=os.environ["NETA_FAKE_PI_AUDIT_LOG"]; remote_dir=os.environ["NETA_RMUX_REMOTE_DIR"]
output=bytearray(); stage=0; at=time.monotonic()
def cleanup():
 try:
  os.kill(pid,15)
  for _ in range(10):
   if os.waitpid(pid,os.WNOHANG)[0]: return
   time.sleep(.1)
  os.kill(pid,9);os.waitpid(pid,0)
 except (ChildProcessError,ProcessLookupError): pass
atexit.register(cleanup)
while time.monotonic()<at+25:
 ready,_,_=select.select([fd],[],[],.1)
 if ready:
  try: output.extend(os.read(fd,65536))
  except OSError: break
 lines=open(audit).read().splitlines() if os.path.exists(audit) else []; starts=[x for x in lines if x.startswith("start:")]
 if stage==0 and starts: os.write(fd,b"\x00m\x1b[B\r");stage=1;at=time.monotonic()
 elif stage==1 and len(starts)>=2:
  if starts[0].rsplit(":",1)[1]!=starts[1].rsplit(":",1)[1]: raise AssertionError("fixture did not reuse session id")
  if starts[0].split(":",2)[1]==starts[1].split(":",2)[1]: raise AssertionError("remote Pi used local descriptor")
  local_descriptor=starts[0].split(":",2)[1];remote_descriptor=starts[1].split(":",2)[1];shared_session=starts[0].rsplit(":",1)[1]
  os.write(fd,b"r\x00m\r");stage=2;at=time.monotonic()
 elif stage==2 and time.monotonic()-at>.7:
  inputs=open(audit).read().splitlines()
  if f"input:{remote_descriptor}:{shared_session}:72" not in inputs or f"input:{local_descriptor}:{shared_session}:72" in inputs: raise AssertionError("remote input crossed descriptor")
  subprocess.run(["bun","src/cli/main.ts","node","stop"],env={**os.environ,"NETA_DIR":remote_dir},check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  os.write(fd,b"z");time.sleep(.7);inputs=open(audit).read().splitlines()
  if f"input:{remote_descriptor}:{shared_session}:7a" in inputs: raise AssertionError("offline input reached stale remote descriptor")
  subprocess.run(["bun","src/cli/main.ts","node","start","--detach"],env={**os.environ,"NETA_DIR":remote_dir},check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  os.write(fd,b"l");stage=3;at=time.monotonic()
 elif stage==3 and time.monotonic()-at>.7:
  inputs=open(audit).read().splitlines()
  if f"input:{local_descriptor}:{shared_session}:6c" not in inputs or f"input:{remote_descriptor}:{shared_session}:6c" in inputs: raise AssertionError("local input crossed descriptor")
  if len([x for x in inputs if x.startswith("start:")])!=2: raise AssertionError("cached host return restarted Pi")
  os.write(fd,b"\x00");time.sleep(.2);os.write(fd,b"m");time.sleep(.2);os.write(fd,b"\x1b[B\r");stage=4;at=time.monotonic()
 elif stage==4 and len(starts)>=3:
  new_remote_descriptor=starts[2].split(":",2)[1]
  if starts[2].rsplit(":",1)[1]!=shared_session or new_remote_descriptor==remote_descriptor: raise AssertionError("remote reconnect changed session")
  os.write(fd,b"z");stage=5;at=time.monotonic()
 elif stage==5 and time.monotonic()-at>.7:
  inputs=open(audit).read().splitlines()
  if f"input:{new_remote_descriptor}:{shared_session}:7a" not in inputs or f"input:{remote_descriptor}:{shared_session}:7a" in inputs: raise AssertionError("reconnected remote input crossed descriptor")
  os.write(fd,b"\x11");stage=6
 ended,status=os.waitpid(pid,os.WNOHANG)
 if ended:
  if stage!=6 or os.waitstatus_to_exitcode(status)!=0: raise AssertionError(bytes(output[-4096:]))
  print("rmux multi-host e2e passed");sys.exit(0)
raise AssertionError(bytes(output[-4096:]))
