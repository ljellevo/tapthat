# Troubleshooting

Symptom → cause → fix. The first entries are failures actually hit while building and
testing TapThat Full against a real Next.js app on a Railway-shaped container.

## The sidecar won't start

| Symptom | Cause | Fix |
|---|---|---|
| `Refusing to start: NODE_ENV=production.` on Railway | Railway defaults Node services to production | Set `NODE_ENV=development` on the service |
| `Refusing to start: TAPTHAT_ENABLE is not set to 1.` | The safety latch | `TAPTHAT_ENABLE=1 npx tapthat-server` |
| `TAPTHAT_TOKEN is not set.` | No token and auth is on | `npx tapthat-server init`, or set the variable |
| `Branch mismatch: … targets "dev" but … has "main" checked out.` | The agent would edit a branch nobody is looking at | Check out the configured branch, or set `TAPTHAT_BRANCH` |
| `devServerUrl: … is the sidecar's own port` | The dev server and the sidecar were given the same port | Point `TAPTHAT_DEV_SERVER` at another port, e.g. `http://localhost:3000` |
| `… is not empty and not a git checkout, so it cannot be cloned into.` | The volume holds something other than a clone | Empty the volume, or point `TAPTHAT_REPO_ROOT` elsewhere |
| `Could not clone …` | Private repository, or wrong URL | Set `TAPTHAT_GIT_TOKEN`; keep credentials out of the URL |
| Railway health check fails on the first deploy | Clone and `npm ci` take longer than the timeout | Raise the health check timeout to 900 s; later boots are fast |

## Playground sessions

| Symptom | Cause | Fix |
|---|---|---|
| `Configuration problems: devServer.command required…` right after the first deploy | Before 0.1.0 the env-only first pass was validated before the repo supplying the rest was cloned | Fixed: the first pass is provisional, and the committed config completes it |
| Apply says "Start a session first" | The sidecar is in `git.mode: "session"` and no session is active | Press **Start session** in the panel |
| Start session fails: `pg_dump: error: aborting because of server version mismatch` | The image's client is older than `dev`'s Postgres | Rebuild with `--build-arg PG_MAJOR=<server major>` |
| "The source user cannot read role passwords" | The copy's login lacks `pg_read_all_data` | `GRANT pg_read_all_data TO <role>`; data rooms can't log in until then |
| Data rooms fail to open after a copy | The playground's `TENANCY_MASTER_KEY` or database passwords differ from `dev`'s | Set them to `dev`'s values; see playground.md, "Values that must match dev" |
| Commit to dev: "Someone changed the same lines on dev" | `dev` moved and conflicts with the session | Nothing was sent. A developer merges by hand, then Discard and start again |
| Commit to dev: "has changes that were never committed" | A batch's build broke and left edits | Undo it, or apply a fix, then Commit |
| The session shows "The sidecar restarted while…" | A restart landed mid-Start/Commit/Discard | Discard, then Start again |
| Previews of documents are missing in the playground | Files live on `storage`'s volume, which the copy doesn't include | Known limitation; metadata and lists are correct |

## The dev server

| Symptom | Cause | Fix |
|---|---|---|
| Sidecar waits for the dev server, then can't bind its port | The dev script read the platform's `PORT` (`next dev --port ${PORT:-3000}`) and took the sidecar's port | Fixed in 0.1.0: the dev server now gets the port from `TAPTHAT_DEV_SERVER`. Make sure that URL has an explicit port |
| Every restart takes minutes | `npm ci` on each boot | Fixed in 0.1.0: the install is skipped when lockfiles are unchanged |
| `/__tapthat/healthz` says `devServer.reachable: false` | Still compiling, or it crashed | The sidecar restarts a crashed dev server after 2 s. Check the service logs |

## Proxy mode (Railway, single-port hosts)

| Symptom | Cause | Fix |
|---|---|---|
| The app's own API calls fail with 401 once the sidecar fronts it | Before 0.1.0 the sidecar claimed `/api/*` | Fixed: in proxy mode the sidecar owns only `/__tapthat/*` |
| Extension: "answered, but not like a TapThat sidecar" | The Sidecar URL is missing `/__tapthat` | Use `https://<domain>/__tapthat` |
| Edits land, but the browser never updates (Next 16) | Next rejects HMR websockets from non-local origins with 403 | Fixed in 0.1.0: the proxy presents same-origin upgrades as the dev server's own |
| Same, with Vite | Vite's `server.allowedHosts` | The proxy rewrites `Host` to the dev server's own; if you set a custom `allowedHosts`, include `localhost` |

## Apply

| Symptom | Cause | Fix |
|---|---|---|
| No **Apply to dev** button | The site isn't in the extension's allowed sites, or no Sidecar URL is set | Options page → add the site's origin → Save & test |
| "Can't reach the sidecar — Export still works" | Wrong URL, sidecar down, or a proxy in between | Options page → Test connection |
| "The sidecar rejected the token" | The extension's token differs from `TAPTHAT_TOKEN` | Paste the token again |
| `page_not_allowed` | The page's origin isn't in the sidecar's `allowedOrigins` | Add it to `TAPTHAT_ALLOWED_ORIGINS` (the browser's address, not the container's) |
| "Your saved key no longer works" | The master key changed, or the sidecar's state was lost | Paste the key again; this is expected after rotating `TAPTHAT_ENCRYPTION_KEY` |
| Batch fails: "Working tree has uncommitted changes" | The sidecar won't run over your work (R1) | Commit or stash, then Apply again |
| Batch fails: "Could not run claude" | Claude Code CLI missing on the sidecar's host | `npm i -g @anthropic-ai/claude-code`, or use the Docker image |
| Batch fails with an authentication error from the agent | The pasted credential is wrong or revoked; keys are checked on first use | Options page → Disconnect → paste a working key |
| "Applied, but the build is broken" (amber) | `verifyCommand` failed after the edit | The output is in the panel. Comment again to fix it, or fix it by hand |
| Status stuck on "Queued — 1 job ahead" | Expected: batches run one at a time per branch | Wait, or check `/healthz` → `queue` |
| "The page changed since you commented" | Someone else's batch moved the branch after you commented | Look at the element again before applying |

## After Apply

| Symptom | Cause | Fix |
|---|---|---|
| `git log` has the commit, the browser didn't update (Compose) | File watcher misses writes from another container | Uncomment the polling line in `docker-compose.dev.yml` |
| Files the agent edited are owned by root (Linux, Compose) | The sidecar container ran as root | Keep `user: "${HOST_UID}:${HOST_GID}"` on the service |
| Undo: "A later change touched the same lines" | A later batch or commit edited the same lines | Undo the later batch first, or fix by hand |
| Undo: "git could not revert this batch: …" | git refused for another reason; the message is git's own | Usually a dirty tree or a missing commit |
| Undo failed only inside Docker | The container had no git identity (before 0.1.0) | Fixed: reverts now use the configured `git.author` |
| Push failed | Token lacks write access, or branch protection | Give `TAPTHAT_GIT_TOKEN` *Contents: read and write* on that branch |
| The service restarts after every Apply (Railway) | It auto-deploys from the branch the agent pushes to | Turn push off, or deploy the service from the image rather than that branch |
