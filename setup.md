# Setup

> **Status: draft.** This is the target shape of the setup doc, written before the
> package exists. Placeholders are marked `TODO:`. As you implement, replace them with
> what's actually true — and if reality differs from what's described here, change the
> doc rather than bending the implementation to match it.

> ⚠️ **This tool must never run in production.** It accepts instructions that modify
> your repository. It is a development tool only. See [Production isolation](#production-isolation).

---

## What you're installing

Three pieces, installed separately:

| Piece | What it does | Where it runs |
|---|---|---|
| **Sidecar** | HTTP API, job queue, credential vault, agent runner | Beside your dev server |
| **Source-map plugin** | Stamps `data-src="file:line"` onto DOM elements | Your build config |
| **Chrome extension** | Select element, write comment, submit | Reviewer's browser |

The sidecar and your dev server must share the same working tree. When the agent edits
a file, your dev server's watcher sees the change and HMR pushes it to the browser.
That shared filesystem is the mechanism the whole fast path depends on.

---

## Prerequisites

- Node.js `TODO: minimum version`
- Git, with push access to the target branch (deploy key or token)
- Docker + Docker Compose (for the container path)
- Claude Code CLI — bundled in the Docker image; required on the host for the `npx` path
- A Claude credential per user: either a Console API key (`sk-ant-…`) or an OAuth token
  from `claude setup-token` (`sk-ant-oat01-…`)

---

## Path 1 — Docker Compose (recommended)

This is the primary path. Use it for any shared or hosted dev environment.

### 1. Install and initialise

```bash
npm i -D @yourorg/comment-agent
npx comment-agent init
```

`init` writes `comment-agent.config.json` to the repo root and prints a compose fragment
to paste into your dev compose file.

### 2. Add the service

```yaml
# docker-compose.dev.yml — this file must never be referenced by production
services:
  web:
    build: .
    command: npm run dev
    volumes:
      - .:/workspace/repo
    ports:
      - "5173:5173"
    environment:
      COMMENT_AGENT_SOURCE_MAP: "1"      # enables the source-map plugin

  comment-agent:
    image: ghcr.io/yourorg/comment-agent:latest   # TODO: confirm registry + tag policy
    depends_on:
      - web
    volumes:
      - .:/workspace/repo                 # same working tree as `web` — required
      - agent-state:/var/lib/comment-agent
    ports:
      - "7420:7420"
    environment:
      COMMENT_AGENT_ENABLE: "1"           # required; the sidecar refuses to boot without it
      COMMENT_AGENT_DEV_SERVER: "http://web:5173"
      COMMENT_AGENT_BRANCH: "dev"
      COMMENT_AGENT_ALLOWED_ORIGINS: "https://dev.example.com"
      COMMENT_AGENT_ENCRYPTION_KEY: "${COMMENT_AGENT_ENCRYPTION_KEY}"
      GIT_SSH_COMMAND: "ssh -i /run/secrets/deploy_key -o StrictHostKeyChecking=no"
    secrets:
      - deploy_key

volumes:
  agent-state:

secrets:
  deploy_key:
    file: ./.secrets/deploy_key           # gitignored
```

### 3. Generate an encryption key

```bash
# TODO: confirm expected format and length
openssl rand -base64 32
```

Put it in your environment or secret store as `COMMENT_AGENT_ENCRYPTION_KEY`. Losing it
means every stored credential becomes unreadable and users must re-enter theirs — which
is a recoverable failure, not a disaster. Rotating it is the same operation.

### 4. Start

```bash
docker compose -f docker-compose.dev.yml up
```

---

## Path 2 — npx, no Docker

For a developer running the dev server locally.

```bash
npm run dev &
npx @yourorg/comment-agent
```

Reads `comment-agent.config.json` from the repo root. Every field is overridable by
environment variable, so:

```bash
COMMENT_AGENT_BRANCH=feature/nav npx @yourorg/comment-agent
```

Requires node, git, and the Claude Code CLI on the host. Fine for your own machine;
too much setup to ask of a non-developer, which is why Docker is the primary path.

---

## Path 3 — Standalone machine

When the dev environment is its own box rather than a compose stack, the sidecar starts
the dev server itself instead of talking to a neighbouring container.

```bash
# TODO: verify against the actual Fly config once the image exists
fly launch --image ghcr.io/yourorg/comment-agent:latest --no-deploy
fly volumes create agent_state --size 10
fly secrets set \
  COMMENT_AGENT_ENCRYPTION_KEY=... \
  GITHUB_TOKEN=...
fly deploy
```

Set `COMMENT_AGENT_START_DEV_SERVER=1` and `COMMENT_AGENT_DEV_COMMAND="npm run dev"` so
the sidecar manages the dev server's lifecycle and can restart it when it dies.

---

## Source-map plugin

Installed separately because it touches your build. Without it the agent has to grep for
elements and results get noticeably worse — treat it as required, not optional.

```ts
// vite.config.ts
import { commentAgentSourceMap } from '@yourorg/comment-agent/vite';

export default defineConfig({
  plugins: [
    react(),
    process.env.COMMENT_AGENT_SOURCE_MAP && commentAgentSourceMap(),
  ].filter(Boolean),
});
```

The env gate is what keeps `data-src` attributes out of production builds. Do not replace
it with a `NODE_ENV` check alone — preview and staging builds are not production but do
want the attributes.

> TODO: document the Webpack and Next.js equivalents.
> TODO: document the non-React path (Vue SFC / Svelte), or state plainly that it's unsupported.

Verify it's working: open the dev site, inspect any element, confirm a `data-src`
attribute pointing at a real file and line.

---

## Chrome extension

1. Install the extension. `TODO: store listing or unpacked-load instructions.`
2. Open its options page and set the sidecar URL (`http://localhost:7420` locally, or
   your dev environment's internal URL).
3. Add your dev site's origin to the allowlist. The extension only activates on
   allowlisted origins — this is a security boundary, not a convenience feature.
4. On first submission, paste your Claude credential. It's sent to the sidecar, encrypted
   at rest, and never returned to the browser. Afterwards you'll only ever see a
   fingerprint (last four characters).

Each user supplies their own credential, so token cost and rate limits land on their own
account rather than a shared one.

---

## Verifying the install

```bash
curl http://localhost:7420/healthz
```

Expected:

```json
{
  "status": "ok",
  "repo": { "branch": "dev", "head": "a1b2c3d", "clean": true },
  "devServer": { "reachable": true, "url": "http://web:5173" },
  "queue": { "depth": 0, "running": false }
}
```

Then run the end-to-end check: open the dev site, select an element, submit a trivial
comment ("make this text red"), and confirm three things in order —

1. The extension shows status moving through queued → editing → live
2. The browser updates without a manual refresh
3. `git log` on the branch shows a new commit

If step 2 fails but step 3 succeeds, the shared volume mount or the file watcher is the
problem, not the agent.

---

## Production isolation

Five independent guards. Verify each after install — they are deliberately redundant
because this is the failure mode with the worst consequences.

- [ ] Package appears in `devDependencies` only
- [ ] Service defined in `docker-compose.dev.yml` only, never the production compose file,
      Dockerfile, or deployment manifest
- [ ] No application code imports the package — it is a separate process, so there is no
      path by which a bundler could pull it into your app bundle
- [ ] Sidecar refuses to boot when `NODE_ENV=production` or `COMMENT_AGENT_ENABLE` is unset
- [ ] CI check fails the build if the package appears in a production dependency tree
      `TODO: document the check once written`

The sidecar should also sit behind whatever authentication already protects your dev
environment. Do not expose port 7420 publicly.

---

## Common problems

| Symptom | Likely cause |
|---|---|
| Health check fine, comments never apply | Sidecar and dev server aren't mounting the same path |
| Commit appears but browser doesn't update | File watcher not seeing container writes — try polling mode |
| Agent edits the wrong file | `COMMENT_AGENT_SOURCE_MAP` not set on the **web** container |
| Credential rejected on submit | API key vs OAuth token mismatch; check the prefix |
| Push rejected | Deploy key lacks write access, or branch protection covers the target branch |
| Second submission hangs | Expected — jobs serialize per branch. Check queue depth in `/healthz` |

See [troubleshooting.md](./troubleshooting.md) for the full list. `TODO: write it, populated
from failures actually encountered during development rather than guessed at.`

---

## Next steps

- [configuration.md](./configuration.md) — every config field and env var
- [security.md](./security.md) — credential handling and threat model
- [api.md](./api.md) — HTTP surface, for anyone building another client
