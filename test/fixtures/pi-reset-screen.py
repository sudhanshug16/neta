#!/usr/bin/env python3
import os, subprocess, sys, time

rmux=os.environ['NETA_RMUX']
socket=os.environ['NETA_RMUX_SOCKET']
session='reset-screen'
root=os.environ['NETA_PI_VERIFY_ROOT']
cmd=(f'exec node {root}/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js '
     f'--session-dir {os.environ["NETA_PI_VERIFY_SESSION_DIR"]} --session-id reset-screen '
     f'--tui-mode fullscreen --extension {root}/src/rmux/pi-acp-extension.ts '
     f'--provider neta-acp --model test-model')

def run(*args): return subprocess.check_output([rmux, '-S', socket, *args], text=True)
def screen(): return run('capture-pane','-p','-t',f'{session}:0.0')
def wait(marker, present=True, seconds=10):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        value=screen()
        if (marker in value)==present: return value
        time.sleep(.1)
    raise RuntimeError(f'marker {marker!r} present={present} screen={screen()!r}')
try:
    subprocess.check_call([rmux,'-S',socket,'new-session','-d','-s',session,cmd])
    wait(os.environ['NETA_PI_READY_MARKER'])
    subprocess.check_call([rmux,'-S',socket,'send-keys','-t',f'{session}:0.0','OLD_SCREEN_MARKER','Enter'])
    before=wait('REMOTE_OLD_OLD_SCREEN_MARKER')
    subprocess.check_call([rmux,'-S',socket,'send-keys','-t',f'{session}:0.0','/neta-reset','Enter'])
    wait('Conversation reset; attached the replacement session.')
    after_reset=wait('REMOTE_OLD_OLD_SCREEN_MARKER',False)
    time.sleep(.5)
    subprocess.check_call([rmux,'-S',socket,'send-keys','-t',f'{session}:0.0','-l','FRESH_SCREEN_MARKER'])
    subprocess.check_call([rmux,'-S',socket,'send-keys','-t',f'{session}:0.0','Enter'])
    after=wait('REMOTE_NEW_FRESH_SCREEN_MARKER')
    print('--- BEFORE ---\n'+before+'--- AFTER_RESET ---\n'+after_reset+'--- AFTER ---\n'+after)
finally:
    subprocess.run([rmux,'-S',socket,'kill-session','-t',session],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
