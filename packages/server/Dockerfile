# syntax=docker/dockerfile:1.7
#
# The TapThat sidecar image: node, git, the Claude Code CLI and the sidecar.
# Built from the repository root, because the sidecar bundles packages/shared:
#
#   docker build -f packages/server/Dockerfile -t tapthat-server .
#
# Two ways to run it:
#   - Compose, beside a dev server, sharing the working tree as a bind mount
#     (packages/server/examples/docker-compose.dev.yml).
#   - Standalone on a PaaS such as Railway: an empty volume at /workspace, the
#     sidecar clones TAPTHAT_REPO_URL, installs, starts the dev server and fronts
#     it on one port (docs/setup.md, "Railway").
#
# Development tool. It must never be part of a production deployment.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci --workspace tapthat-server --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN node packages/server/build.mjs


FROM node:${NODE_VERSION}-slim

ARG CLAUDE_CODE_VERSION=latest
# Start session copies the dev database with pg_dump, which refuses servers
# newer than itself, while a newer pg_dump reads older servers fine. So this
# tracks the newest Postgres a dev environment is likely to run (Railway's
# template is 18); build with an older value only to save a few MB.
ARG PG_MAJOR=18

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini openssh-client curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && . /etc/os-release \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}" \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 # The working tree is often owned by another uid (a host bind mount, a volume
 # a PaaS created as root). Inside this single-purpose container that is
 # expected, not suspicious.
 && git config --system safe.directory '*'

COPY --from=build /src/packages/server/dist/cli.js /opt/tapthat/cli.js
COPY packages/server/docker-entrypoint.sh /usr/local/bin/tapthat-entrypoint
RUN chmod 755 /opt/tapthat/cli.js /usr/local/bin/tapthat-entrypoint \
 && ln -s /opt/tapthat/cli.js /usr/local/bin/tapthat-server \
 && mkdir -p /workspace/repo /workspace/state \
 && chown -R node:node /workspace

# Containers are reached through their published port, never loopback.
ENV TAPTHAT_HOST=0.0.0.0 \
    TAPTHAT_REPO_ROOT=/workspace/repo \
    TAPTHAT_STATE_DIR=/workspace/state \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /workspace
EXPOSE 7420

ENTRYPOINT ["tini", "--", "tapthat-entrypoint"]
CMD ["tapthat-server", "serve"]
