#!/bin/sh
set -eu
install -d -m 700 /root/.ssh
install -m 600 /keys/authorized_keys /root/.ssh/authorized_keys
exec /usr/sbin/sshd -D -e
