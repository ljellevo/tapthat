# HTTP API

The contract between the extension and the sidecar. The types live in
[`packages/shared/src/protocol.ts`](../packages/shared/src/protocol.ts), which both sides
compile against, so a shape change breaks the typecheck on both at once.

## Base URL and routing

Every route is served under the prefix `/__tapthat`. Without proxy mode, the same routes
are also served bare:

| Mode | Base URL the extension uses | `GET /healthz` is at |
|---|---|---|
| Normal (npx, Compose) | `http://localhost:7420` | `/healthz` and `/__tapthat/healthz` |
| Proxy (`TAPTHAT_PROXY=1`) | `https://dev.example.com/__tapthat` | `/__tapthat/healthz` only |

In proxy mode everything outside `/__tapthat/` belongs to the app and is forwarded to the
dev server, including the HMR websocket. An app with its own `/api/*` or `/healthz`
keeps them. See [ADR 0003](adr/0003-proxy-prefix.md).

## Authentication

- `Authorization: Bearer <TAPTHAT_TOKEN>` on every route except `GET /healthz`,
  `OPTIONS`, and the SSE stream. A missing or wrong token gets `401 unauthorized`.
- **Origin.** A request whose `Origin` is not in `allowedOrigins` gets `403` before its
  body is read, even with a valid token. The exception is `chrome-extension://…` origins
  (the extension's options page); see [security.md](security.md#the-origin-gate).
- **CORS.** `Access-Control-Allow-Origin` is echoed only for exact `allowedOrigins`
  matches.
- **The SSE stream** can't carry a header (`EventSource` has no way to set one), so it is
  gated by the `eventsToken` returned when the batch was accepted. The token is scoped to
  that one batch and expires after 24 hours.

## Errors

Every error body has the same shape:

```json
{ "error": "rate_limited", "message": "Limit of 20 batches per hour for this credential reached." }
```

| `error` | Status | Meaning |
|---|---|---|
| `unauthorized` | 401 | Missing or wrong bearer token (or events token) |
| `origin_not_allowed` | 403 | The request's `Origin` is not allowlisted |
| `page_not_allowed` | 403 | The comments were captured on a page outside `allowedOrigins` |
| `no_credential` | 401 | No `credentialHandle`, and the sidecar has no shared key |
| `credential_invalid` | 401 | Unknown handle, or it can no longer be decrypted: paste the key again |
| `duplicate` | 409 | This `batchId` was already submitted; it is not run twice |
| `rate_limited` | 429 | Per-credential or global hourly cap |
| `kill_switch` | 503 | The operator paused new work |
| `bad_request` | 400 | Malformed body |
| `nothing_to_revert` · `dirty` · `conflict` · `revert_failed` | 409 | See [undo](#post-apibatchesidrevert) |
| `no_session` · `session_busy` | 409 | Playground only: no active session, or one mid-step |
| `session_active` · `session_failed` · `nothing_to_commit` · `push_failed` | 409 / 502 | See [sessions](#sessions-playground-mode) |

---

## `GET /healthz`

Unauthenticated liveness and state.

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

`status` is `degraded` while the kill switch is on. `agent.envCredential` tells the
extension whether it has to collect a credential before the first Apply.

Two more fields matter with several repositories and in a playground:
- **`repos` and `devServers`** list every repository and dev server. `repo` and
  `devServer` describe the primary one, which is what single-repo clients read.
- **`mode`** is `commit` or `session`. In `session` mode, **`session`** is
  `{ id, state, pending }` or `null`.

## `GET /api/config`

What the extension needs to configure itself from a URL and a token.

```json
{ "version": "0.1.0", "branch": "dev", "allowedOrigins": ["https://dev.example.com"], "proxy": true, "push": false }
```

## `POST /api/credentials`

```json
{ "credential": "sk-ant-api03-…" }
```

→ `200`

```json
{ "handle": "cred_3f0c…", "fingerprint": "4f2a", "kind": "api_key", "validated": false }
```

The type is detected by prefix: `sk-ant-oat01-` means `oauth_token`, and any other
`sk-ant-` means `api_key`. The credential is sealed with envelope encryption and never
returned. `validated` is always `false`. There is no free no-op call to check a key, so it
is checked on first use, and a rejected key fails that batch with the agent's own
message. `400` for an unrecognized prefix, `503` if the sidecar has no encryption key.

## `DELETE /api/credentials/:handle`

→ `204`. A hard delete on the sidecar.

## `POST /api/batches`

```json
{
  "batchId": "5e92aa94-c178-4c1c-ac65-ed51c8d6f375",
  "credentialHandle": "cred_3f0c…",
  "page": { "url": "https://dev.example.com/login", "title": "Sign in", "viewport": { "w": 1280, "h": 800 }, "capturedAt": "…" },
  "comments": [ { "id": "…", "n": 1, "comment": "Make this friendlier", "selector": "…", "…": "…" } ],
  "client": { "name": "tapthat-extension", "version": "0.1.0" }
}
```

`reviewer` (optional, free text) is shown to teammates in a playground's pending changes.
`batchId` is generated by the client and is the idempotency key. A retry after a dropped
response gets `409 duplicate` and does not run the agent a second time. `comments` are
`CommentRecord`s exactly as the extension captures them.

→ `202`

```json
{ "batchId": "5e92…", "state": "queued", "queueDepth": 0, "baseSha": "a1b2c3d", "branch": "dev", "eventsToken": "ev_…" }
```

`queueDepth` is the number of jobs ahead of this one. Batches run one at a time per
branch, because two agents editing one working tree corrupt each other.

Batches are scoped to one page, like comments: comments on three routes make three
batches, three commits and three queue slots. The comment store ignores the query string
and hash, so comments made on `?tab=billing` and `?tab=profile` batch together under one
`page.url`.

## `GET /api/batches/:id`

The whole state of a batch, including its full event log. Polling this is a complete
client on its own; the SSE stream is an optimization.

```json
{
  "batchId": "5e92…",
  "state": "committed",
  "createdAt": "…",
  "baseSha": "a1b2c3d",
  "branch": "dev",
  "pageUrl": "https://dev.example.com/login",
  "commentIds": ["…"],
  "events": [ { "seq": 0, "type": "accepted", "at": "…" }, "…" ],
  "queueDepth": 0,
  "result": { "summary": "…", "filesChanged": ["src/app/login/page.tsx"], "sha": "ee6e656", "durationMs": 14210 },
  "error": null
}
```

### States

| `state` | Meaning | Terminal |
|---|---|---|
| `queued` | Waiting for the branch's slot | |
| `running` | The agent is working | |
| `applied` | Edits are on disk (and live via HMR), not committed: git disabled, or the commit failed | ✓ |
| `applied-unverified` | Edits are on disk, but `verifyCommand` failed. Nothing committed; `error.message` has the compiler output | ✓ |
| `committed` | Edits committed (and pushed, if enabled) | ✓ |
| `failed` | Nothing changed; the tree was restored to exactly what it was. `error.message` is the agent's own text | ✓ |
| `reverted` | Undone by a revert commit | ✓ |

### Events

`{ seq, batchId, at, type, message?, files?, sha?, commits?, output? }`, with `seq`
increasing by one from 0.

**Several repositories:** paths in `files` and `result.filesChanged` are prefixed with the
repo name (`api/src/routes/deals.ts`). `commits` (and `result.commits`) list one
`{ repo, sha }` per repository; `sha` is the first. A single-repo workspace keeps
unprefixed paths.

| `type` | Carries |
|---|---|
| `accepted`, `queued` | `message`, e.g. "1 job ahead" |
| `started` | `message` with the base sha |
| `prompt-rendered` | prompt size |
| `agent-message` | the agent's own text, scrubbed of credentials, up to 500 chars |
| `files-changed` | `files`, from git (never the agent's own claim) |
| `verify-passed` / `verify-failed` | `output` on failure |
| `committed` | `sha`, `files` |
| `pushed` / `push-failed` | `message` |
| `failed` | `message`; also used for non-terminal failures such as a failed cleanup |
| `reverted` | `sha` of the revert commit |

## `GET /api/batches/:id/events?t=<eventsToken>`

Server-Sent Events. Every event is a default `message` with `id: <seq>` and the event
JSON as `data`. When the batch reaches a terminal state, one final `event: done` carries
the full batch status (as `GET /api/batches/:id`), and the stream closes.

- Reconnect with `Last-Event-ID` to resume after that seq; `EventSource` does this
  itself.
- Connecting to a batch that has already finished replays its events and ends with
  `done` immediately.
- `: ping` comments every 15 seconds keep idle connections open through PaaS edges.

The extension uses SSE when it can and falls back to polling `GET /api/batches/:id` when
the stream fails, for example on an expired token or a proxy that buffers.

## `POST /api/batches/:id/revert`

Undo, **best effort**: `git revert --no-edit <sha>`, pushed if push is enabled. It takes
the same queue slot as a batch, so it can't race one.

→ `202 { "revertSha": "89868e1", "commits": [{ "repo": "api", "sha": "…" }, …] }`, and the
batch becomes `reverted`. With several repositories, undo is all-or-nothing: each revert
is staged, and a conflict in any repository abandons all of them.

| `error` (409) | When |
|---|---|
| `nothing_to_revert` | The batch made no commit (failed, unverified, applied-only) or was already undone |
| `dirty` | The working tree has uncommitted changes |
| `conflict` | A later commit touched the same lines. `conflicts` lists the paths; the revert was aborted and the tree is clean |
| `revert_failed` | git refused for another reason; `message` has git's own words |

Why it's only best effort: a later batch may have built on this one, so undoing it alone
can leave an intermediate state that never existed. And the browser shows whatever HMR
last pushed, which is not necessarily what one sha describes.

---

## Sessions (playground mode)

With `git.mode: "session"` (see [playground.md](playground.md)), batches need an active
session and collect on a local session branch; they reach `dev` only on Commit. All three
actions take an optional `{ "reviewer": "Ana" }` body.

### `GET /api/session`

```json
{
  "mode": "session",
  "session": {
    "id": "202609251758-6789", "state": "active", "startedAt": "…", "startedBy": "Ana",
    "branch": "tapthat/session-202609251758-6789",
    "base": [{ "repo": "app", "sha": "e01e08b…" }, { "repo": "api", "sha": "02a24b0…" }],
    "pending": [{ "batchId": "…", "summary": "…", "files": ["api/src/routes/health.ts"], "comments": ["…"], "pageUrl": "…", "reviewer": "Ana", "at": "…" }],
    "repos": [{ "name": "app", "files": ["src/app/(auth)/login/page.tsx"] }, { "name": "api", "files": ["src/routes/health.ts"] }],
    "events": [{ "at": "…", "message": "Loading into the playground… dealroom_platform", "step": 1, "steps": 1 }],
    "error": null
  },
  "last": { "id": "…", "outcome": "committed", "at": "…", "by": "Ana", "commits": [{ "repo": "api", "sha": "6947e73" }], "notices": [] }
}
```

`state` is `starting` → `active` → `committing` | `discarding`, or `failed` with `error`.
`repos` is what Commit would send; `events` is the progress log.

### `POST /api/session/start`

→ `202` with the session, `starting`. It runs in the background; poll `GET /api/session`.
Every repo fast-forwards to its remote branch, the snapshot (if configured) copies `dev`'s
databases, `prepare` runs, and a session branch is created.

- `409 session_active`: a session is running. Commit or discard it first.
- `409 session_failed`: the last one failed. Cancel it first (`POST /api/session/discard`).

### `POST /api/session/commit`

→ `200` with the outcome (`commits` are the new heads of `dev`, in push order, plus
`notices`). Per repo in `git.deployOrder`: squash onto the session's base, replay onto
the latest `dev` if it moved, then push. Every repository is prepared before any is pushed.

| `error` | Status | Meaning |
|---|---|---|
| `conflict` | 409 | `dev` changed the same lines; `conflicts` lists them. Nothing was pushed; the session is unchanged |
| `dirty` | 409 | A batch left edits uncommitted (a broken build). Undo or fix it first |
| `nothing_to_commit` | 409 | No changes in the session |
| `push_failed` | 502 | A push was refused; `pushed` lists repos already sent |

### `POST /api/session/discard`

→ `200` with the outcome. Edits are restored, every repo returns to `dev`, the session
branch is deleted, and the data is restored from the copy taken at Start. Also the way
out of a `failed` session.
