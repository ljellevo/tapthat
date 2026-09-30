# Changelog

## Unreleased

- **Root-owned files anywhere in the workspace are given back to `node` at boot.** The
  entrypoint only checked the top of `/workspace/repo` and `/workspace/state`, so a
  multi-repo workspace (`/workspace/repos`) — or a file a root shell such as `railway ssh`
  wrote deep in `node_modules` — stayed root-owned, and `npm ci` then failed with `EACCES`
  and the workspace would not start. The whole volume is checked now; the recursive
  `chown` still runs only when something needs it.
- **Start session and Discard reinstall what changed.** Either moves the checkouts to other
  commits, and a new lockfile used to wait for the next restart of the sidecar: the dev
  server ran the new code against the old `node_modules` and failed on the first import it
  added. Now a repository whose lockfile changed is reinstalled, its dev server stopped for
  the install and started again after it; the others keep running. With or without
  `session.clean`.
- **Start session can clear the workspace first** (`session.clean`). Ignored files go
  (build output, `.next` caches, files earlier sessions left behind), and so do leftover
  session branches. Kept: `node_modules`, `.env` files, the sidecar's state and the names
  you list in `keep`. A repository whose lockfile changed is reinstalled. Off unless
  configured. See [A clean slate](docs/playground.md#a-clean-slate).
- **The installer replaces a guessable Postgres password in the playground it creates.**
  Railway can store its `secret()` template as text in a copied environment even when
  dev's is fine. The first data copy then failed with "unexpected spaces found in
  `secret(32, …)`".
- **Behind a gateway, the gateway reaches the workspace.** The installer pointed the gateway
  at the workspace before creating it, and Railway resolves a reference when it's saved, so
  the gateway's upstreams stayed empty and it answered 502. Kept services are now pointed
  at the workspace after it exists.
- **A re-run retries a failed first data copy.** Before, the failed session stayed, and a
  re-run skipped the copy.
- **One version for the extension and the server.** Each release now also publishes
  `tapthat-server` to npm and ghcr with the extension's version, so the server jumps from
  0.2.0 to the next release's number. The `server-v*` tags are retired.
- **The installer works behind a gateway.** Pick a reverse proxy in front of your sites as
  the site, and it stays as it runs in dev, pointed at the workspace. Every repository
  service behind it runs as a dev server, so any of them can be changed, and a site on its
  own domain (an admin console) is served on the workspace's domain.
  See [Behind a gateway](docs/playground.md#behind-a-gateway).
- The workspace's proxy may front a dev server other than the primary repository's
  (`proxy.target`). This used to be reported as two dev servers sharing a port.
- `install --dry-run` on a project without the dev branch yet reads each repository's
  scripts from its default branch.

## tapthat-server 0.2.0

- **`npx tapthat-server install`** sets up a playground environment on Railway. It asks
  three things: the platform, the dev branch and the site. If the branch or an environment
  deploying it is missing, it offers to create them. It finds everything else and makes
  the changes after one confirmation:
  - a TCP proxy on dev's Postgres;
  - the playground as a copy of dev, without the services it doesn't need;
  - the `workspace` service, with its volume, health check, domain and variables;
  - the GitHub token, checked for push access;
  - a generated `tapthat.config.json`, unless the site's repository has one;
  - a deploy, and the first data copy.

  It also replaces a Postgres password that Railway stored as the literal text of its
  `secret()` template, and gives Redis the variables its template would have. Running it
  again changes nothing on a finished setup, and `--dry-run` shows the plan without
  changing anything.
- With a data copy configured (`session.snapshot`), a failing `prepare` at boot no longer
  stops the workspace. A fresh playground's database is empty until the first Start
  session, which runs `prepare` again after copying.
- Docs: the copy logs in as dev's superuser. A `pg_read_all_data` role reads password
  hashes, but it can't connect to databases whose `CONNECT` is revoked from `PUBLIC`.

## tapthat-server 0.1.2

- The image's Postgres client is 18 (was 17). Railway's Postgres template runs 18, and
  `pg_dump` refuses servers newer than itself, so Start session against a Railway `dev`
  failed. The 18 client still dumps 17 and older.

## tapthat-server 0.1.1

- Published with npm trusted publishing: no token, with provenance from this repository's
  `server-release.yml`.
- The image is published as its own job, so npm and ghcr no longer block each other.

## tapthat-server 0.1.0

The first npm release, published by hand to bootstrap trusted publishing. It is the same
code as `server-v0.1.0`.

## Unreleased: TapThat Full

The online half of TapThat. The extension gains an **Apply to dev** button once a
sidecar is configured. Light, the default, is unchanged: same Export, and no network
requests.

### Extension

- Options page: sidecar URL, token, allowed sites (filled from the sidecar), a
  connection test, credential save and disconnect, and a way back to Light.
- **Apply to dev** in the panel on allowlisted sites. Export stays as the fallback.
- Live status per comment (queued · editing · live · committed · build broken · failed ·
  undone), streamed over SSE with a polling fallback. A reload mid-run resumes.
- A batch card with the agent's progress, summary, changed files, and errors or compiler
  output verbatim with Copy. **Resolve N** and **Undo (best-effort)** once it lands.
- A branch line (`dev @ a1b2c3d`) before Apply, and a warning when the branch moved
  since the comments were made.
- First Apply without a credential asks for one in the page. Only the sidecar's handle
  is stored.
- A **?** button in the panel opens a built-in, plain-language help page: what TapThat
  does, what a reviewer needs from their developer, how to get a Claude key, setup, what
  each status means, safety and cost, and common problems. It is linked from the options
  page and the key prompt, and loads nothing from the network.

### `tapthat-server` 0.1.0

- `init`, `serve`, `doctor`, `run-file`, `audit-prod`.
- The job handler: runs Claude Code with file tools only, verifies with
  `verifyCommand`, and commits only the files the run touched. Recovery after a failure
  is scoped to those files; there is no hard reset.
- HTTP API with bearer auth, an origin allowlist, idempotent submission, per-branch
  serialization, SSE with replay, and undo.
- Credentials sealed with envelope encryption. Per-credential and global rate limits,
  a kill switch, and an audit log.
- Proxy mode for single-port hosts, clone-on-boot, supervised dev server, skip-install
  on unchanged lockfiles, optional push.
- Docker image `ghcr.io/ljellevo/tapthat-server` with git and the Claude Code CLI; drops
  root on start.

### Playground environments and changes across services

- **Workspaces:** one sidecar owns several repositories (`repos[]`), and one batch may
  change any of them. It lands in all or none:
  - verify runs per repo, and a break anywhere commits nothing;
  - Undo is all-or-nothing;
  - `mirrors` keep shared folders (Dealroom's contracts) in step.
- **Sessions** (`git.mode: "session"`):
  - Start session brings every repo, and with `session.snapshot` the data, up to date
    with `dev`.
  - Batches collect on a local session branch.
  - Commit to dev squashes per repo, replays onto the latest `dev`, checks every repo
    before pushing any, and pushes in `deployOrder`.
  - Discard puts the code and the data back.
- **Database copy:** roles (with passwords, via a read-only `pg_read_all_data` login),
  every database via pg_dump/pg_restore, and a Redis flush. The dumps are the session's
  restore point.
- **Extension:** a session strip with Start session, progress, pending changes with
  reviewer names, and two-click Commit to dev / Discard all. Per-repo commits and branch
  line, and an optional "Your name".
- **Fixed:**
  - The Full-mode footer clipped Export (the panel is now 364px).
  - Dev servers started through a shell weren't fully stopped.
  - The env-only first config pass on a PaaS was validated before the repo that completes
    it was cloned.

### Fixed during Railway validation

- The spawned dev server took the sidecar's `PORT`.
- Proxy mode shadowed the app's own `/api/*` routes.
- Next 16 refused the proxied HMR websocket.
- Undo failed in containers without a git identity.
