# Setup

The full reference for running TapThat Full. For the short version, see
[INSTALL.md](../INSTALL.md).

> ⚠️ **The sidecar must never run in production.** It accepts instructions that modify
> your repository. It is a development tool only. See [security.md](security.md).

---

## What you're installing

| Piece | What it does | Where it runs |
|---|---|---|
| **Sidecar** (`@tapthat/sidecar`) | HTTP API, job queue, credential vault, agent runner | Beside your dev server, in the same working tree |
| **Extension** (`tapthat.zip`) | Select an element, write a comment, Apply | Each reviewer's browser |

The sidecar and your dev server **must share one working tree**. When the agent edits a
file, the dev server's watcher sees it and HMR pushes the change to the reviewer's
browser. That shared filesystem is what the whole fast path depends on.

Pick the path that matches how your dev environment runs:

| Path | Use it when | The dev server is… |
|---|---|---|
| [1. npx](#path-1--npx) | You run the dev server on your own machine | started by you |
| [2. Docker Compose](#path-2--docker-compose) | The dev stack is a compose file | a neighbouring container |
| [3. Railway / single-container PaaS](#path-3--railway-and-other-single-container-hosts) | The dev environment is hosted, one port per service | started by the sidecar |

## Prerequisites

- **Node.js 20 or newer** (22 recommended) on whatever runs the sidecar.
- **Git**, and a checkout of the repository on the branch the agent should commit to.
- **The Claude Code CLI** (`npm i -g @anthropic-ai/claude-code`) for the npx path. The
  Docker image already contains it.
- **A Claude credential**: an API key (`sk-ant-…`) or an OAuth token from
  `claude setup-token` (`sk-ant-oat01-…`). Either each reviewer pastes their own in the
  extension, or the sidecar has one shared key in `ANTHROPIC_API_KEY`.

---

## Path 1 — npx

For a developer running the dev server locally.

```bash
# in the repository you want edited, on the branch the agent should commit to
git switch -c dev                    # or any branch — never main
npm i -D @tapthat/sidecar
npx tapthat-sidecar init
```

`init` writes three things and prints what to paste into the extension:

| File | Contents | Commit it? |
|---|---|---|
| `tapthat.config.json` | branch, dev server URL, allowed sites, verify command | yes |
| `.tapthat/secrets.env` | `TAPTHAT_TOKEN` and `TAPTHAT_ENCRYPTION_KEY` | **never** — `init` adds `.tapthat/` to `.gitignore` |
| `.gitignore` | `+ .tapthat/` | yes |

Then, with your dev server running:

```bash
TAPTHAT_ENABLE=1 npx tapthat-sidecar
```

`TAPTHAT_ENABLE=1` is a deliberate safety latch: the sidecar will not start without it,
and it can't be set from a file.

The sidecar reads its secrets from `.tapthat/secrets.env`, listens on
`http://localhost:7420`, and prints the values for the extension. Configure the
extension as in [INSTALL.md, part 2](../INSTALL.md#part-2--the-client-each-reviewers-browser).

**The tree must be clean when a batch runs.** On this path the agent shares your real
checkout, so the sidecar refuses to run over uncommitted changes. Otherwise your work and
the agent's would be indistinguishable. Commit or stash first.

---

## Path 2 — Docker Compose

For a dev stack that already runs in Compose. Copy
[`packages/sidecar/examples/docker-compose.dev.yml`](../packages/sidecar/examples/docker-compose.dev.yml)
into your repository and adjust the `web` service to match yours:

```yaml
# docker-compose.dev.yml — this file must never be referenced by production
services:
  web:
    build: .
    command: npm run dev -- --host 0.0.0.0
    volumes:
      - .:/app
      - /app/node_modules
    working_dir: /app
    ports:
      - "5173:5173"
    # environment:
    #   Uncomment if commits appear but the browser never updates: file watchers
    #   often miss writes made from another container on a bind mount.
    #   CHOKIDAR_USEPOLLING: "1"    # Vite/webpack; for Next use WATCHPACK_POLLING: "true"

  tapthat:
    image: ghcr.io/ljellevo/tapthat-sidecar:latest
    # Without this, files the agent edits come back owned by root on Linux.
    user: "${HOST_UID:-1000}:${HOST_GID:-1000}"
    depends_on:
      - web
    volumes:
      - .:/workspace/repo              # the same working tree as `web` — required
      - tapthat-state:/workspace/state
    ports:
      - "7420:7420"
    env_file:
      - .tapthat/secrets.env           # TAPTHAT_TOKEN, TAPTHAT_ENCRYPTION_KEY
    environment:
      TAPTHAT_ENABLE: "1"
      TAPTHAT_DEV_SERVER: "http://web:5173"
      TAPTHAT_ALLOWED_ORIGINS: "http://localhost:5173"

volumes:
  tapthat-state:
```

```bash
npx tapthat-sidecar init           # once: config + secrets
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f docker-compose.dev.yml up
```

Notes:

- `TAPTHAT_DEV_SERVER` is the address **the sidecar** uses to reach the dev server
  (`http://web:5173`). `TAPTHAT_ALLOWED_ORIGINS` is the address **the reviewer's browser**
  uses (`http://localhost:5173`, or your dev domain). They are usually different.
- `user:` matters on Linux. Without it, every file the agent edits comes back owned by
  root. Docker Desktop on macOS and Windows maps ownership for you.
- The polling line is the fix for the most common Compose symptom: a commit appears and
  `git log` shows it, but the browser never updates.

---

## Path 3 — Railway and other single-container hosts

Most PaaS give each service **one public port** and **no shared filesystem** between
services. Both change the shape:

- **One service, not two.** A Railway volume attaches to exactly one service, so the dev
  server can't be a neighbouring service. The sidecar starts and supervises it inside
  its own container (`TAPTHAT_START_DEV_SERVER=1`).
- **Proxy mode.** The sidecar fronts the dev server on the one public port
  (`TAPTHAT_PROXY=1`). Pages, assets and the HMR websocket go to the dev server. The
  sidecar answers only under `/__tapthat/`, so your app's own `/api/*` routes are
  untouched.
- **Clone on boot.** The container starts with an empty volume. The sidecar clones
  `TAPTHAT_REPO_URL` into it, installs dependencies, and starts the dev server. Later boots
  reuse the checkout: a clean tree is fast-forwarded (never reset), and the install is
  skipped when the lockfile hasn't changed.

The repository has to be reachable by git from the container. In practice that means it
is on GitHub or similar. A private repository needs a token in `TAPTHAT_GIT_TOKEN`: a
fine-grained token with **Contents: read**, or **read and write** if you enable push.

### Service settings

Create one service from the image `ghcr.io/ljellevo/tapthat-sidecar:latest`. Until that
image is published, deploy it from this repository instead, with the Dockerfile path
`packages/sidecar/Dockerfile`. Then:

| Setting | Value |
|---|---|
| Volume | mounted at `/workspace` |
| Health check path | `/__tapthat/healthz` |
| Health check timeout | `900` seconds. The first boot clones and installs before it can answer. |
| Public domain | generate one; reviewers open this URL |

Variables:

| Variable | Example | Why |
|---|---|---|
| `NODE_ENV` | `development` | Required. Railway defaults Node services to `production`, and the sidecar refuses to start there. |
| `TAPTHAT_ENABLE` | `1` | The safety latch. |
| `TAPTHAT_TOKEN` | `openssl rand -base64 24` | Reviewers paste this into the extension. On a PaaS it is the only thing between the internet and your repo. |
| `TAPTHAT_ENCRYPTION_KEY` | `openssl rand -base64 32` | Seals stored credentials. |
| `TAPTHAT_REPO_URL` | `https://github.com/acme/web.git` | What to clone. No credentials in the URL. |
| `TAPTHAT_GIT_TOKEN` | a GitHub token | For a private repository. |
| `TAPTHAT_BRANCH` | `dev` | The branch the agent commits to. |
| `TAPTHAT_PROXY` | `1` | One public port for the site and the sidecar. |
| `TAPTHAT_START_DEV_SERVER` | `1` | The sidecar runs the dev server. |
| `TAPTHAT_INSTALL_COMMAND` | `npm ci --no-audit --no-fund` | Run before the dev server, when dependencies changed. |
| `TAPTHAT_DEV_COMMAND` | `npm run dev` | How to start the dev server. |
| `TAPTHAT_DEV_SERVER` | `http://localhost:3000` | Where it listens inside the container. It gets this port as `PORT`, never Railway's. |
| `TAPTHAT_ALLOWED_ORIGINS` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | The public URL reviewers open. |
| `TAPTHAT_VERIFY_COMMAND` | `npm run typecheck` | Optional but recommended; see [security.md](security.md#r4--broken-builds). |
| `ANTHROPIC_API_KEY` | `sk-ant-…` | Optional shared key. Leave unset to make each reviewer paste their own. |
| *your app's own variables* | `DEALROOM_API_URL=…` | Passed through to the dev server. |

`PORT` is injected by Railway. The sidecar listens on it, and the dev server is given the
port from `TAPTHAT_DEV_SERVER` instead.

The extension's **Sidecar URL** on this path is `https://<your domain>/__tapthat`. The
sidecar prints it on boot.

> ### ⚠️ Railway redeploys on push
>
> If this service deploys from the branch the agent pushes to, every applied batch
> restarts the container. That kills the dev server, and the reviewer sees their change
> vanish mid-review. Push is **off** by default. To turn it on (`TAPTHAT_GIT_PUSH=1`),
> make sure the service does **not** auto-deploy from `TAPTHAT_BRANCH`. With an image
> source it doesn't, because nothing about the image changes on push.

### Example: the Dealroom project

Dealroom defines its Railway project as code in `resources/.railway/railway.ts`. This
service is typechecked against that file's `railway/iac` version. Add it beside `app`:

```ts
import { defineRailway, image, preserve, service, volume } from "railway/iac";

// …inside defineRailway, next to the other services:

// TapThat: the customer app in dev mode behind the sidecar, for design review.
// A dev environment by definition; it must never serve customers.
const appDev = service("app-dev", {
  source: image("ghcr.io/ljellevo/tapthat-sidecar:latest"),
  replicas: { [REGION]: 1 },
  healthcheck: "/__tapthat/healthz",
  // First boot clones and runs npm ci before the health check can pass.
  healthcheckTimeout: 900,
  volumeMounts: { "/workspace": volume("app-dev-workspace", { region: REGION }) },
  env: {
    NODE_ENV: "development",
    PORT: "8080",
    TAPTHAT_ENABLE: "1",
    TAPTHAT_TOKEN: preserve(),
    TAPTHAT_ENCRYPTION_KEY: preserve(),
    TAPTHAT_GIT_TOKEN: preserve(),
    TAPTHAT_REPO_URL: `https://github.com/${OWNER}/app.git`,
    TAPTHAT_BRANCH: "dev",
    TAPTHAT_PROXY: "1",
    TAPTHAT_START_DEV_SERVER: "1",
    TAPTHAT_INSTALL_COMMAND: "npm ci --no-audit --no-fund",
    TAPTHAT_DEV_COMMAND: "npm run dev",
    TAPTHAT_DEV_SERVER: "http://localhost:3000",
    TAPTHAT_ALLOWED_ORIGINS: `https://${ref("app-dev", "RAILWAY_PUBLIC_DOMAIN")}`,
    TAPTHAT_VERIFY_COMMAND: "npm run typecheck",
    DEALROOM_API_URL: internal("api", 3100),
  },
});
// …and add appDev to the project's resources.
```

Then `railway config apply`, set the three `preserve()` secrets in the dashboard, create
a `dev` branch in the `app` repository, and generate a domain for `app-dev`.

This configuration was tested end to end against the Dealroom app (Next 16, Turbopack)
in a container started exactly this way: an empty `/workspace` volume, clone, `npm ci`,
`next dev` behind the proxy, an applied batch that HMR pushed to the page, a push, a
restart that skipped the install, and an undo.

Two Dealroom-specific notes:

- `app-dev` talks to the same `api` as `app`, so it shows the same data. Links the API
  generates, such as those in sign-in mail, still point at `app`'s domain (`WEB_ORIGIN`).
- The `app` repository must be on GitHub (`OWNER` set) before `app-dev` can clone it.

### Fly.io, Render and others

The same image and variables work on any host that runs a container with a volume. Mount
the volume at `/workspace`, set the variables above, and point the health check at
`/__tapthat/healthz`. The sidecar recognizes Fly.io, Render and Heroku and applies the
same PaaS defaults as on Railway.

---

## Verify the install

```bash
curl http://localhost:7420/healthz              # npx / Compose
curl https://your-dev-app.example/__tapthat/healthz   # proxy mode
```

```json
{
  "status": "ok",
  "version": "0.1.0",
  "repo": { "branch": "dev", "head": "a1b2c3d", "clean": true },
  "devServer": { "reachable": true, "url": "http://localhost:5173" },
  "queue": { "depth": 0, "running": false },
  "agent": { "cliVersion": "2.1.0 (Claude Code)", "envCredential": false },
  "killSwitch": false
}
```

Check that `agent.cliVersion` isn't `null` (otherwise the CLI is missing) and that
`devServer.reachable` is `true`. Then run the end-to-end check. Open the dev site, select
an element, comment "make this text red", press **Apply to dev**, and confirm three
things **in order**:

1. The panel moves through queued → editing → live → committed.
2. The browser updates without a manual refresh.
3. `git log` on the branch shows a new commit, authored by TapThat.

If step 2 fails but step 3 succeeds, the problem is the shared working tree or the file
watcher, not the agent. See [troubleshooting.md](troubleshooting.md).

---

## Configuration reference

Settings come from, in order of precedence: environment variables, then
`tapthat.config.json` in the working directory (or, on the clone-on-boot path, in the
cloned repository), then defaults. Every problem is reported at once on boot.

| Field | Default | Environment | Notes |
|---|---|---|---|
| `port` | `7420` | `TAPTHAT_PORT`, then `PORT` | |
| `host` | `127.0.0.1` | `TAPTHAT_HOST` | `::` on a detected PaaS; `0.0.0.0` in the Docker image |
| `repoRoot` | working directory | `TAPTHAT_REPO_ROOT` | Must be a git checkout (or empty, with `repoUrl`) |
| `repoUrl` | `null` | `TAPTHAT_REPO_URL` | Clone-on-boot source. Credentials go in `TAPTHAT_GIT_TOKEN`, never here |
| `branch` | `dev` | `TAPTHAT_BRANCH` | Must equal the checked-out branch, or the sidecar refuses to start |
| `devServerUrl` | `http://localhost:5173` | `TAPTHAT_DEV_SERVER` | As seen from the sidecar |
| `allowedOrigins` | `[]` | `TAPTHAT_ALLOWED_ORIGINS` (comma-separated) | Pages that may send comments. Exact origins |
| `verifyCommand` | `null` | `TAPTHAT_VERIFY_COMMAND` | Run after the agent, before committing |
| `agent.command` | `claude` | `TAPTHAT_AGENT_COMMAND` | |
| `agent.model` | CLI default | `TAPTHAT_AGENT_MODEL` | |
| `agent.allowedTools` | `Read,Edit,Write,Glob,Grep` | | No Bash, no network: see security.md |
| `agent.timeoutMs` | `180000` | | Hard ceiling per batch |
| `agent.maxCommentsPerBatch` | `20` | | |
| `git.enabled` | `true` | | Off: edits apply but are never committed |
| `git.push` | `false` | `TAPTHAT_GIT_PUSH=1` | Pushes after each commit and undo |
| `git.remote` | `origin` | `TAPTHAT_GIT_REMOTE` | |
| `git.allowDirty` | `false` | | Leave it off; see security.md, R1 |
| `git.author` | `TapThat <tapthat@localhost>` | | Author of agent commits and undos |
| `proxy.enabled` | `false` | `TAPTHAT_PROXY=1` | |
| `proxy.target` | `devServerUrl` | | |
| `devServer.start` | `false` | `TAPTHAT_START_DEV_SERVER=1` | Restarted automatically if it dies |
| `devServer.command` | `null` | `TAPTHAT_DEV_COMMAND` | |
| `devServer.install` | `null` | `TAPTHAT_INSTALL_COMMAND` | Skipped when lockfiles are unchanged |
| `limits.batchesPerHour` | `60` | | Across everyone |
| `limits.batchesPerHourPerCredential` | `20` | | Per reviewer credential |
| `killSwitch` | `false` | `TAPTHAT_KILL_SWITCH=1` | Refuses new batches; everything else keeps working |
| `auth.mode` | `token` | `TAPTHAT_AUTH_MODE=none` | `none` is only allowed on loopback |

Environment only. These are secrets or safety switches and don't belong in a
committed file:

| Variable | Purpose |
|---|---|
| `TAPTHAT_ENABLE=1` | The safety latch. Required for `serve` and `run-file`. |
| `TAPTHAT_TOKEN` | Bearer token the extension sends. |
| `TAPTHAT_ENCRYPTION_KEY` | Master key for stored credentials. Losing it means reviewers paste their keys again. |
| `TAPTHAT_GIT_TOKEN` | HTTPS token for clone, fetch and push. Sent as a header, never written to `.git/config`. |
| `TAPTHAT_STATE_DIR` | Where state, sealed credentials and the audit log live. Default `<repo>/.tapthat`. |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | Optional shared credential, used when a reviewer has none. |

## Commands

| Command | Does |
|---|---|
| `tapthat-sidecar init` | Writes `tapthat.config.json` and `.tapthat/secrets.env`, updates `.gitignore`, prints the extension values |
| `tapthat-sidecar` / `serve` | Starts the sidecar |
| `tapthat-sidecar doctor` | Checks config, repo, agent CLI and secrets without starting anything |
| `tapthat-sidecar run-file batch.json` | Runs one batch from a file, no HTTP. For testing prompts against a scratch checkout |
| `tapthat-sidecar audit-prod` | Fails if the sidecar appears in a production dependency tree or deploy file. Run it in CI |

## Next

- [security.md](security.md): the threat model and what each guard is for
- [api.md](api.md): the HTTP surface, for anyone building another client
- [troubleshooting.md](troubleshooting.md): symptoms, causes and fixes
