#!/usr/bin/env python3
import atexit, fcntl, json, os, pty, select, struct, termios, time
pid, fd = pty.fork()
if pid == 0: os.execvpe("bun", ["bun", "src/cli/main.ts", "rmux"], os.environ)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
state=os.environ["NETA_DIR"]; deadline=time.monotonic()+20; stage=0; output=bytearray()
def cleanup():
 try:
  os.kill(pid,15)
  for _ in range(10):
   if os.waitpid(pid,os.WNOHANG)[0]: return
   time.sleep(.1)
  os.kill(pid,9); os.waitpid(pid,0)
 except (ChildProcessError,ProcessLookupError): pass
atexit.register(cleanup)
def paste(value): os.write(fd, b"\x1b[200~"+value.encode()+b"\x1b[201~")
while time.monotonic()<deadline:
 ready,_,_=select.select([fd],[],[],.1)
 if ready:
  try: output.extend(os.read(fd,65536))
  except OSError: break
 if stage==0 and b"FAKE_PI_READY" in output:
  os.write(fd,b"\x00m\x1b[B\r"); stage=1
 elif stage==1:
  paste("user@fake"); os.write(fd,b"\t"); paste("Fake"); os.write(fd,b"\t"); paste("/remote/neta"); os.write(fd,b"\t"); paste("/remote/repo"); os.write(fd,b"\r"); stage=2; time.sleep(.3)
 elif stage==2:
  if not os.path.exists(os.path.join(state,"client-hosts.json")): continue
  data=json.load(open(os.path.join(state,"client-hosts.json")))
  host=data["hosts"][0]
  if len(data["hosts"])!=1 or (host["sshDestination"],host["displayName"],host["remoteNetaDir"],host["lastRemoteWorkspacePath"]) != ("user@fake","Fake","/remote/neta","/remote/repo"): raise AssertionError("form save missing")
  before=open(os.path.join(state,"client-hosts.json"),"rb").read()
  output.clear(); os.write(fd,b"\x1b[B\r"); stage=3; time.sleep(.3)
 elif stage==3:
  if b"Add SSH machine" not in output: continue
  paste("changed"); stage=4; time.sleep(.2)
 elif stage==4:
  if b"changed" not in output: continue
  output.clear(); os.write(fd,b"\x1b"); stage=5; time.sleep(.2)
 elif stage==5:
  if b"+ Add SSH machine" not in output: continue
  if open(os.path.join(state,"client-hosts.json"),"rb").read()!=before: raise AssertionError("cancel mutated registry")
  os.write(fd,b"\x11"); stage=6
 ended,status=os.waitpid(pid,os.WNOHANG)
 if ended:
  if stage!=6 or os.waitstatus_to_exitcode(status)!=0: raise AssertionError("rmux failed")
  print("rmux add host e2e passed"); raise SystemExit
raise AssertionError("timeout")
