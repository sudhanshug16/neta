FROM node:24-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd
COPY entrypoint.sh /usr/local/bin/neta-remote-sshd
RUN chmod 755 /usr/local/bin/neta-remote-sshd
ENTRYPOINT ["/usr/local/bin/neta-remote-sshd"]
