# Security

The sidecar accepts instructions that modify a repository and runs a coding agent over
it. Treat every part of this document as load-bearing. If a guard looks redundant, it is
redundant on purpose. Don't remove one without replacing what it protects.

## Never in production

The sidecar is a remote-code-execution primitive by design: it exists to let someone in
a browser change code. Five independent guards keep it out of production. Check each one
after installing:

| # | Guard | How it holds | Check |
|---|---|---|---|
| 1 | **A separate process** | Nothing imports `tapthat-server`; it is a CLI. No bundler can pull it into an app. | `grep -r "tapthat-server" src/` finds nothing |
| 2 | **devDependency only** | `npm i -D`. A production install (`--omit=dev`) never has it. | `npx tapthat-server audit-prod` |
| 3 | **Dev-only deploy files** | It appears only in `docker-compose.dev.yml` or a dedicated dev service, never in the production Dockerfile, compose file or manifest. | `npx tapthat-server audit-prod` |
| 4 | **Runtime refusal** | Exit 78 when `NODE_ENV=production`, with no override. Exit 78 unless `TAPTHAT_ENABLE=1`, which is env-only so a committed file can't set it. | Start it without `TAPTHAT_ENABLE` |
| 5 | **A CI check** | `audit-prod` fails the build if 2 or 3 regresses. | Add it to CI, below |

```yaml
# .github/workflows/ci.yml in the project that uses TapThat
- run: npx --yes tapthat-server audit-prod
```

`audit-prod` fails when `package.json` lists the sidecar outside `devDependencies`, when
`npm ls --omit=dev` finds it, or when a `Dockerfile`, `compose*.yml`, `fly.toml`,
`railway.json` or `render.yaml` that isn't a dev file names it.

## Access: the token and the origin gate

On `npx` and Compose the sidecar binds to loopback or an internal network. On a PaaS it
is **on the open internet**, and the bearer token is the only thing between a stranger and
a repo-write primitive. So:

- `serve` refuses to start without `TAPTHAT_TOKEN`. `auth.mode: "none"` is rejected
  unless the sidecar is bound to loopback.
- Tokens are compared in constant time.
- Generate the token with `init` or `openssl rand -base64 24`. Rotate it by changing the
  variable; every reviewer then updates the extension's options page.

### The origin gate

A second, independent gate. A request whose `Origin` isn't in `allowedOrigins` is
refused before its body is read, even with a valid token. A leaked token alone therefore
can't be used from an arbitrary web page.

Requests from `chrome-extension://…` origins (the extension's options page) are allowed
with a valid token. The gate exists to stop *web pages*. A browser extension can set any
header it likes, so blocking extension origins would add friction and no protection.

**The page the comments came from must also be allowlisted.** The `Origin` header says
where a request came from, not what it describes, so the sidecar separately rejects a batch
whose `page.url` is outside `allowedOrigins`.

## Prompt injection (R2)

Page content (HTML, text, attributes) goes into the agent's prompt, so a hostile page
could try to write instructions to an agent holding Edit and Write on your repository.
Five layers stand in the way:

1. **Allowlisted sites only.** The extension offers Apply only on `allowedOrigins`, and
   the sidecar enforces the same list on `page.url`. Keep the list to your own dev
   domains.
2. **A fence in the prompt.** Captured page content is wrapped as untrusted data: it is
   evidence about the DOM, never instructions, and anything instruction-shaped is to be
   ignored and reported.
3. **Sanitizing on the sidecar.** `<script>` and `<style>` bodies and HTML comments are
   stripped, and the HTML length cap is re-applied there. The client is not trusted to
   have done it.
4. **No shell, no network.** The agent's tools are `Read,Edit,Write,Glob,Grep`. It can't
   run commands, install packages or fetch URLs, so there is nothing to exfiltrate
   through.
5. **Pinned to the repository.** The agent's working directory is the repository root.
   The fixtures `injection.json` and `escape.json` in `packages/server/test/fixtures`
   check that an injected instruction and a `../../etc/` write are refused. Run them
   against a scratch checkout after upgrading the Claude Code CLI.

## Credentials

- **Per reviewer.** Each reviewer pastes their own Claude credential, so cost and rate
  limits land on their own account. A shared `ANTHROPIC_API_KEY` on the sidecar is the
  fallback.
- **Never in the browser.** The key is POSTed once. The extension stores only the
  sidecar's opaque handle and a four-character fingerprint, because
  `chrome.storage.local` is readable by anyone with the profile.
- **Envelope encryption at rest.** Each credential gets its own random data key
  (AES-256-GCM), and only that data key is encrypted with the master key
  `TAPTHAT_ENCRYPTION_KEY`. No two credentials share a key.
- **Losing or rotating the master key** makes stored credentials unreadable. They are
  dropped on first use, and each reviewer is asked to paste their key again. That is
  recoverable, not a disaster.
- **One-click revoke.** *Disconnect* in the options page deletes the sealed credential
  on the sidecar.
- **Scoped to one process.** The decrypted credential goes into the environment of that
  one agent run, never into the sidecar's own environment, and never into the verify
  command's.
- **Scrubbed.** Registered secrets and anything shaped like `sk-ant-…` are redacted from
  logs, agent output, error messages and the audit log.
- **Git tokens** (`TAPTHAT_GIT_TOKEN`) are sent as a per-command HTTP header, never
  written into the remote URL or `.git/config`.

## Your working tree (R1)

On the `npx` path the agent shares your real checkout. So:

- A batch refuses to start over uncommitted changes (`git.allowDirty: false`).
  Otherwise your edits and the agent's would be indistinguishable.
- A failed run is undone path by path. Only files the agent touched are restored, and
  only files it created are deleted. There is no `git reset --hard` anywhere in the
  sidecar, and CI fails if one appears.
- Commits stage only the files the run changed, never `git add -A`.
- The state directory (`.tapthat/`) holds sealed credentials. `init` gitignores it, and
  the sidecar also adds it to `.git/info/exclude`.

## R4: broken builds

The agent has no shell, so it can't know that a plausible edit breaks the build. Set
`verifyCommand` (for example `npm run typecheck`). The sidecar runs it after the agent,
without any credential in its environment. On failure the batch ends in
`applied-unverified`, shown amber in the panel with the compiler output, and nothing is
committed.

## A playground environment

[playground.md](playground.md) adds a few things to the threat model:

- **Commit to dev pushes code.** Anyone with the token can send a session to `dev`. It
  never touches `main`, and `dev` stays reviewable in git like any other branch, but treat
  the token accordingly. `TAPTHAT_GIT_TOKEN` should reach only the workspace's
  repositories, and only their `dev` branch if your host can scope it.
- **A public path into `dev`'s data.** The copy reads `dev`'s Postgres through a TCP proxy,
  as `dev`'s superuser. A `pg_read_all_data` role would be narrower, but it can't open
  databases whose `CONNECT` is revoked from `PUBLIC`. Keep that password long and random:
  `tapthat-server install` replaces one that Railway stored as the literal text of its
  `secret()` template. `dev` must never hold production data.
- **The dumps live on the workspace volume** until the next Start, including role password
  hashes. The volume is as sensitive as `dev`'s database.
- **Connection URLs are secrets.** They are registered for scrubbing, so a failed copy
  reports the Postgres client's message without the password.

## Limits and the kill switch

- `limits.batchesPerHourPerCredential` (default 20) stops a runaway client from burning
  one reviewer's budget. `limits.batchesPerHour` (default 60) is the global backstop.
- `TAPTHAT_KILL_SWITCH=1` refuses all new batches while health, status and undo keep
  working.

## The audit log

`<state dir>/audit.log` gets one JSON line per security-relevant event: `auth.rejected`,
`origin.rejected`, `credential.issued`, `credential.revoked`, `batch.accepted`,
`batch.rejected`, `batch.finished`, `batch.reverted`. The same lines go to stdout, so a
PaaS log view shows them too. Every line is scrubbed.

## What is not solved

- **Two reviewers on one environment share one tree.** Batches are serialized, so the
  tree is never corrupted. But reviewer B may be commenting on a page that reviewer A's
  batch is about to change. The panel warns when the branch has moved since a comment was
  captured. Real isolation needs a branch and a dev server per reviewer, which TapThat
  doesn't do.
- **Anyone with the token and an allowlisted page can apply changes.** There are no
  per-user accounts on the sidecar. Share the token as you would a deploy key.

## Operator checklist

- [ ] `TAPTHAT_TOKEN` is long and random, and shared only with reviewers
- [ ] `allowedOrigins` lists only your own dev sites
- [ ] The branch the agent commits to is not `main`, and `main` has branch protection
- [ ] On a PaaS, the service does not auto-deploy from the branch the agent pushes to
- [ ] `npx tapthat-server audit-prod` runs in CI
- [ ] `verifyCommand` is set
