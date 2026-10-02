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
  # The whole volume, however deep: a multi-repo workspace lives in
  # /workspace/repos, not /workspace/repo, and a command run over the
  # platform's shell (`railway ssh` is root) leaves root-owned files deep in a
  # checkout — node_modules, generated code — that `npm ci`, running as node,
  # then cannot delete. The walk stops at the first such file; only then does
  # the recursive chown, the slow part, run.
  if [ -n "$(find /workspace ! -user node -print -quit)" ]; then
    chown -R node:node /workspace
  fi
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
