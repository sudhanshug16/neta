import os,subprocess,time
rmux=os.environ['NETA_RMUX'];sock=os.environ['NETA_RMUX_SOCKET'];session='history-screen';root=os.environ['NETA_PI_VERIFY_ROOT'];cmd=f'exec node {root}/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --session-dir {os.environ["NETA_PI_VERIFY_SESSION_DIR"]} --session-id history-screen --tui-mode fullscreen --extension {root}/src/rmux/pi-acp-extension.ts --provider neta-acp --model test-model'
def run(*a):return subprocess.check_output([rmux,'-S',sock,*a],text=True)
def screen():return run('capture-pane','-p','-t',f'{session}:0.0')
def wait(m,p=True):
 d=time.monotonic()+10
 while time.monotonic()<d:
  s=screen()
  if (m in s)==p:return s
  time.sleep(.1)
 raise RuntimeError(m)
try:
 subprocess.check_call([rmux,'-S',sock,'new-session','-d','-s',session,cmd]);wait(os.environ['NETA_PI_READY_MARKER']);wait('REMOTE_NEWER_HISTORY');subprocess.check_call([rmux,'-S',sock,'send-keys','-t',f'{session}:0.0','/neta-history','Enter']);older=wait('REMOTE_OLDER_HISTORY');subprocess.check_call([rmux,'-S',sock,'send-keys','-t',f'{session}:0.0','/neta-history','Enter']);wait('No earlier remote history');subprocess.check_call([rmux,'-S',sock,'send-keys','-t',f'{session}:0.0','-l','FRESH_HISTORY_MARKER']);subprocess.check_call([rmux,'-S',sock,'send-keys','-t',f'{session}:0.0','Enter']);after=wait('REMOTE_FRESH_HISTORY_MARKER');print('--- OLDER ---\n'+older+'--- AFTER ---\n'+after)
finally:subprocess.run([rmux,'-S',sock,'kill-session','-t',session],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
