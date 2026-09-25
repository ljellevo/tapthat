#!/bin/sh
# Drops to the unprivileged `node` user before starting the sidecar.
#
# PaaS volumes (Railway's among them) are mounted owned by root, and the image
# may be started as root to be able to use them. The agent must not run as root:
# every file it writes would come back root-owned, and Claude Code refuses some
# modes as root. So when started as root, take ownership of the workspace and
# step down. Started as any other user (Compose's `user: "${HOST_UID}:${HOST_GID}"`), this
# does nothing.
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /workspace/repo /workspace/state
  chown node:node /workspace /workspace/repo /workspace/state
  # Only walk the tree when it is not already ours; a large checkout makes a
  # recursive chown on every boot slow.
  if [ -n "$(find /workspace/repo /workspace/state -maxdepth 1 ! -user node -print -quit)" ]; then
    chown -R node:node /workspace/repo /workspace/state
  fi
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
