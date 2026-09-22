#!/usr/bin/env python3
"""Local-only SSH stand-in for rmux multi-host integration tests."""
import os, socket, subprocess, sys, threading

args = sys.argv[1:]
if "-N" not in args:
    command = args[-1]
    raise SystemExit(subprocess.run(command, shell=True).returncode)

spec = args[args.index("-L") + 1]
local, remote = spec.split(":", 1)
try:
    os.unlink(local)
except FileNotFoundError:
    pass
listener = socket.socket(socket.AF_UNIX)
listener.bind(local)
listener.listen()

def bridge(left, right):
    def copy(source, target):
        try:
            while data := source.recv(65536): target.sendall(data)
        finally:
            try: target.shutdown(socket.SHUT_WR)
            except OSError: pass
    threading.Thread(target=copy, args=(left, right), daemon=True).start()
    threading.Thread(target=copy, args=(right, left), daemon=True).start()

while True:
    client, _ = listener.accept()
    upstream = socket.socket(socket.AF_UNIX)
    upstream.connect(remote)
    bridge(client, upstream)
