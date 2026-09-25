# Plan: Browser-comment → agent → live dev environment

> **Status (2026-09-25): built, as TapThat Full.** This is the original design brief. What
> shipped differs in these places. Each is recorded where it was decided:
>
> - Names: `@yourorg/comment-agent` → `@tapthat/sidecar`, `COMMENT_AGENT_*` → `TAPTHAT_*`.
> - State is a JSON file, not SQLite ([ADR 0002](docs/adr/0002-json-store.md)).
> - The source-map plugin (Phase 0) is deferred; the extension's capture payload carries
>   the load instead.
> - A single-container shape (Railway) exists alongside Compose: the sidecar starts the dev
>   server, clones on boot, and fronts everything on one port under `/__tapthat`
>   ([ADR 0003](docs/adr/0003-proxy-prefix.md)).
> - Failure recovery restores only the paths the agent touched; there is no
>   `git reset --hard` (see docs/security.md, R1).
> - The `repository_dispatch` CI fallback was dropped; Export covers "sidecar down".
>
> Install: [INSTALL.md](INSTALL.md). Reference: [docs/setup.md](docs/setup.md).

## Goal

Extend an existing Chrome extension (select DOM element → attach comment) so that
submitting one or more comments causes an agent to apply the change to a real repo
and have the result visible on a hosted dev/test environment within seconds.
No local checkout required by the person giving feedback.

Target audience for the *commenting* side: designers, PMs, QA — people who should
not have to install a CLI or run `npm install`.

---

## How to use this document

**Ask me questions. Do not guess.**

This plan was written before anyone looked at the actual repo, so parts of it are
assumptions rather than facts. Where reality disagrees with this document, reality
wins — tell me, and we'll amend the plan.

Stop and ask when:

- An assumption in "Open decisions" doesn't match the repo (framework, build tool,
  branch layout, existing CI).
- A step is ambiguous enough that two reasonable implementations would differ in a way
  that's expensive to undo later.
- You're about to pick a library, host, or pattern the plan doesn't name.
- Something in the plan looks wrong, over-engineered, or out of order. Say so.
  I would rather redesign now than discover it in Phase 4.
- A task turns out to be much bigger than its one-line description suggests.

Batch related questions into one message where you can, rather than blocking on each
one separately. If a question has an obvious default and the cost of being wrong is
low, take the default, note the choice inline, and keep moving — flag it for review
rather than stopping.

Before starting a phase, read the repo and confirm the phase's assumptions actually
hold. Report back what you found before writing code.

---

## Architecture

```
Chrome extension
  │  POST /api/batches   (comments + user credential ref)
  ▼
Sidecar  — npm package / Docker service, runs inside the dev environment
  │  HTTP API + queue + credential vault + agent runner, one process
  │  repo checked out, dev server running alongside it
  │
  │  claude -p "<batch prompt>"  → edits files
  ├─ HMR pushes change to browser        ← fast path (~1-3s)
  └─ git commit + push (async)           ← persistence
       │
       ▼
   GitHub  →  Actions  →  deploy (promote path, not on critical path)
```

Two paths on purpose:

- **Fast path** — agent edits files in the worker's working tree, the running dev
  server hot-reloads, the reviewer sees the change almost immediately.
- **Promote path** — the same edits are committed and pushed in the background.
  GitHub Actions builds/deploys as normal. This is durability and review, not latency.

---

## Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Agent runtime | Claude Code headless (`claude -p --output-format json`) or Agent SDK | Repo-aware, tool use, structured output |
| Auth model | Per-user credential submitted via the extension | Cost + rate limits land on each user's own account |
| Credential storage | Server-side, envelope-encrypted, never returned to client | Extension storage is inspectable |
| Agent location | Sidecar inside the dev env, NOT GitHub Actions | Removes runner cold start + install from the latency budget |
| Packaging | One npm package, also published as a Docker image | Drop-in for a hosted dev env or a laptop; no bespoke deploy |
| Prod isolation | Separate process, devDependency, dev-only compose file, runtime guard | Must never reach production |
| State store | SQLite on a volume | Keeps the dependency count near zero so setup stays trivial |
| Git role | Persistence layer, not critical path | Commit/push happens after the user already sees the change |

## Open decisions — resolve before Phase 2

- [ ] **Where the sidecar runs.** Default assumption: as a service in the hosted dev
      environment's `docker-compose.dev.yml`, beside the dev server. If the dev
      environment is a standalone machine instead, **Fly.io Machine** with a persistent
      volume is the default. Swap points are marked `HOST:` below. Alternatives:
      Vercel Sandbox (+ Drive), Hetzner VPS, Railway, E2B/Daytona.
- [ ] **Frontend framework of the target repo.** Phase 0 assumes React + Vite.
      If it's Vue/Svelte/Next, the source-mapping approach changes shape but not intent.
- [ ] **Single shared branch vs. branch-per-user.** This plan assumes one shared
      `dev` branch and one warm worker. Branch-per-user is a Phase 6 extension.
- [ ] **Credential type accepted.** Plan supports both `sk-ant-` (API key) and
      `sk-ant-oat01-` (OAuth token from `claude setup-token`). Detect by prefix.
      NOTE: verify Anthropic's current terms before shipping OAuth-token collection
      to third-party users — API-key mode has no ambiguity.

---

## Phase 0 — Source mapping (do this first)

This is the single biggest quality lever. A CSS selector alone forces the agent to
grep and guess. Stamping source locations into the DOM makes the edit trivial.

- [ ] Add a Babel/SWC plugin (dev + preview builds only) that writes
      `data-src="src/components/Card.tsx:42:8"` onto every JSX element.
      React dev builds already carry `__source` (file/line/column) on the fiber —
      this just surfaces it in the DOM.
- [ ] Gate it behind an env flag so it never ships to production.
- [ ] Verify in the browser: every meaningful element has a `data-src`.
- [ ] Add a fallback for elements without `data-src` (portals, third-party widgets):
      the extension falls back to selector + outerHTML and the agent greps.

**Acceptance:** right-clicking any element in the dev environment yields a file path
and line number that points at real source.

---

## Phase 1 — Extension payload

- [ ] Extend the comment model to capture, per comment:
  - `data_src` (file:line:col) if present
  - CSS selector and/or XPath
  - `outerHTML`, truncated to ~2KB
  - visible `textContent`
  - page URL + route
  - viewport width/height
  - optional cropped screenshot (upload separately, pass a URL — do not inline base64)
- [ ] Batch submission UI: select N comments → "Apply to dev".
- [ ] Onboarding screen: paste credential, validate it server-side with a cheap
      no-op call, show connected state as fingerprint only (last 4 + hash).
- [ ] Never persist the raw credential in `chrome.storage.local`. Collect → POST → discard.
- [ ] Status panel: queued → editing → live → committed, with a link to the diff.

---

## Phase 2 — The sidecar: one service, two distribution forms

The backend and the warm worker are **the same process**. Splitting them was an
unnecessary network hop: the worker already holds the repo and the running dev server,
so the control plane may as well live beside it.

Package it as **one npm package that is also published as a Docker image**. Same
codebase, two ways to run it, so it drops into a hosted dev environment or a laptop
with equal ease.

### Distribution

- [ ] **npm package** — `@yourorg/comment-agent`, with a `bin` entry so `npx @yourorg/comment-agent`
      starts it with zero install. Suits a developer running the dev server locally.
- [ ] **Docker image** — same package baked into an image that already carries node, git,
      and `@anthropic-ai/claude-code`. Suits the hosted dev environment, where you don't
      want to assume anything about the host. This is the primary form.
- [ ] Ship a `docker-compose.dev.yml` that runs the sidecar next to the app's dev server,
      sharing the repo as a mounted volume so both see the same working tree.

### Configuration

- [ ] Single config file, `comment-agent.config.json` (or `.ts` for type safety), read
      from the repo root. Everything overridable by env var for container use.
- [ ] Fields: `repo` (path or URL), `branch`, `devServerUrl`, `port`, `allowedOrigins`,
      `gitAuthor`, `agent.allowedTools`, `auth.mode`, `storage.encryptionKey`.
- [ ] `npx @yourorg/comment-agent init` writes a commented default config and prints
      the exact extension setup steps. Getting started should be two commands, not a page.
- [ ] Validate config on boot and fail loudly with a readable message. A sidecar that
      starts but silently can't reach the repo is worse than one that refuses to start.

### Keeping it out of production — non-negotiable

- [ ] It is a **separate process**, never imported by application code. There is no code
      path by which a bundler could pull it into the app bundle.
- [ ] Listed in `devDependencies` only.
- [ ] Defined in `docker-compose.dev.yml` only — never in the production compose file,
      Dockerfile, or deployment manifest.
- [ ] **Runtime guard:** refuse to boot if `NODE_ENV === "production"`, or if an explicit
      `COMMENT_AGENT_ENABLE=1` is absent. Exit non-zero with an explanation.
- [ ] Bind to the dev environment's internal network, behind whatever auth already
      protects the dev site. Do not expose it on a public port.
- [ ] CI check that fails the build if the package appears in a production dependency
      tree or manifest. Belt and braces — this is the failure mode with the worst blast radius.

Note: the Phase 0 Babel plugin is the one piece that *does* touch the build. It is a
separate concern with its own env gate — keep the two independent.

---

## Phase 3 — Sidecar runtime

### HTTP surface

- [ ] `POST /api/credentials` — accept credential, detect type by prefix, validate,
      envelope-encrypt, store per user. Return fingerprint only (last 4 + hash).
- [ ] `DELETE /api/credentials` — hard revoke.
- [ ] `POST /api/batches` — authenticate, enqueue a job, return `batch_id`.
- [ ] `GET /api/batches/:id/events` — SSE stream of status updates.
- [ ] `GET /healthz` — liveness, including dev-server reachability and repo state.
- [ ] CORS locked to `allowedOrigins`. The extension is the only client.

### State

- [ ] Default to **SQLite on a mounted volume**. No Redis, no Postgres, no external
      service to provision. A single-branch sidecar has tiny state; keep the dependency
      count near zero so spinning it up stays trivial.
- [ ] In-process queue with **per-branch serialization**. Concurrent agent runs on one
      working tree will corrupt each other. One in-flight job; queue the rest.
- [ ] Per-user rate limit. An accidental loop in the extension should not burn someone's
      whole token budget.

### Boot

- [ ] Clone the repo to the configured path if absent, else `git fetch && git reset --hard origin/<branch>`.
- [ ] Verify the dev server is reachable; wait and retry rather than crashing on a race.
- [ ] In Docker: deps cached on the volume so restarts are warm.

### Job handler

1. Pull job from queue
2. Decrypt the submitting user's credential, inject as env var for **this child process only**
   (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` per prefix) — never into the
   sidecar's own environment
3. Render the batch into a prompt (see template below)
4. Run `claude -p "$PROMPT" --output-format json --allowedTools "Read,Edit,Write,Glob,Grep"`
   — deliberately no Bash, no network tools
5. Stream status over SSE as it goes
6. On success: HMR has already fired. Then `git add -A && git commit && git push`
7. On failure: report the agent's error verbatim, reset the working tree to HEAD so the
   next job starts clean

- [ ] Scrub credentials from every log line and from agent stdout before it leaves the process.
- [ ] Health check + auto-restart. Dev servers die.
- [ ] `HOST:` if running as a standalone machine rather than a compose sidecar: idle
      timeout → stop; wake on next job. The volume keeps the clone warm.


### Prompt template

```
You are applying visual feedback to a running dev environment.
Repo root: {{repoRoot}}. The dev server is running with HMR — edits take effect immediately.

Apply the following comments. Each names the source location of the element it refers to.
Make the minimal edit that satisfies the comment. Do not refactor unrelated code.
Do not run build or test commands.

<comments>
{{#each comments}}
---
Comment: {{text}}
Source: {{data_src}}
Selector: {{selector}}
Element: {{outerHTML}}
Page: {{url}} (viewport {{viewport}})
{{/each}}
</comments>

When done, output a JSON summary: {"files_changed": [...], "summary": "..."}.
```

---

## Phase 4 — Feedback loop

- [ ] Extension subscribes to the SSE stream, shows live status per batch.
- [ ] On completion, show `files_changed` and the agent's summary.
- [ ] "Revert this batch" button → the sidecar runs `git revert <sha>`.
      One batch = one commit makes this trivial. Do not skip this.
- [ ] Surface agent failures as readable text, not a spinner that never resolves.

---

## Phase 5 — Promote path (GitHub Actions)

- [ ] Push to `dev` triggers the existing deploy (or a preview platform auto-builds it).
- [ ] Separate workflow to open a PR `dev → main` on demand.
- [ ] Branch protection on `main`. The agent never touches it.
- [ ] Optional: a `repository_dispatch` fallback path that runs the agent in CI when
      the worker is down. Slower (2–5 min) but keeps the system usable.
      If you build this, use repo secrets for credentials — **never** put a user
      credential in `client_payload`, it is visible in the run context and logs.

---

## Security checklist

- [ ] Real user auth on the sidecar. The endpoint accepts repo-modifying instructions;
      an unauthenticated endpoint is a repo write primitive for anyone who finds it.
- [ ] The sidecar is never reachable from production and never present in a production
      dependency tree. Runtime guard + CI check, per Phase 2.
- [ ] Agent tools restricted to file read/edit. No Bash, no network.
- [ ] Prompt injection: page content flows into the prompt. Restrict the extension
      to an allowlist of your own domains. A malicious page could otherwise author
      instructions to the agent.
- [ ] Agent writes to `dev` only, never `main`.
- [ ] Credentials: encrypted at rest, never logged, never returned to the client,
      one-click revoke, scrubbed from agent output.
- [ ] Per-user rate limits and a global kill switch.

---

## Latency budget (fast path target)

| Step | Target |
|---|---|
| Extension → backend | < 200ms |
| Queue → worker pickup | < 500ms |
| Agent run (1–3 small edits) | 10–40s |
| HMR → browser | ~1s |
| **Visible total** | **~15–45s** |
| git commit + push (async, off critical path) | +2s |
| Full deploy (promote path) | 1–3 min |

If the agent run dominates, the lever is prompt quality and scoping — a batch with
precise `data_src` values is dramatically faster than one that forces exploration.

---

## Documentation — write it as you go, not at the end

Docs are a deliverable of each phase, not a cleanup task afterwards. A phase is not
done until its docs are written. Write them for someone who has never seen this repo.

### Required

- [ ] **`README.md`** (sidecar package) — what it is, the two-command quickstart,
      a short "how it works" with the architecture diagram, and a prominent warning
      that it must never run in production.
- [ ] **`docs/setup.md`** — full install for both forms: `npx` and Docker Compose.
      Include a complete, copy-pasteable `docker-compose.dev.yml`.
- [ ] **`docs/configuration.md`** — every config field: type, default, env-var
      equivalent, and what breaks if it's wrong. Generate from the config schema if
      practical so it cannot drift.
- [ ] **`docs/source-mapping.md`** — what the Phase 0 Babel plugin does, how to enable
      it, how to confirm it's working, and how to adapt it to a non-React stack.
- [ ] **`docs/security.md`** — credential handling, the prod-isolation guards and why
      each exists, the prompt-injection threat model, and what an operator must do
      (domain allowlist, branch protection, revocation).
- [ ] **`docs/api.md`** — the HTTP surface: every endpoint, request/response shape,
      the SSE event types. The extension is the consumer; this is its contract.
- [ ] **`docs/troubleshooting.md`** — the failure modes you actually hit while building:
      sidecar can't reach the dev server, HMR not firing, agent edits the wrong file,
      credential rejected, git push rejected. Symptom → cause → fix.
- [ ] **`docs/operations.md`** — deploying the sidecar, logs, health checks, backup and
      restore of the SQLite state, upgrade path.
- [ ] **`CHANGELOG.md`** — from the first release. It's a distributed package.

### Standards

- Every code example must be complete and runnable. No `...` elisions in setup steps.
- Document the *why* for anything non-obvious, especially the isolation guards — a
  future maintainer who doesn't understand why they exist will remove them.
- Inline comments only where intent isn't obvious from the code. Do not narrate.
- When a decision from this plan changes during implementation, update this plan file
  too. It should stay an accurate description of what was built.
- Keep an `docs/adr/` folder for decisions with real trade-offs (SQLite vs Postgres,
  merged sidecar vs split services). Short: context, decision, consequences.

---

## Build order

1. Phase 0 end to end, verified in the browser. Nothing else works well without it.
2. Sidecar job handler only, driven by a hand-written JSON file. No extension, no HTTP.
   Prove the agent can take a comment and produce a correct HMR'd change.
3. Wrap it in the HTTP surface. Single user, credential from an env var.
4. Package it: npm `bin` + Dockerfile + `docker-compose.dev.yml` + `init` command.
   Verify a clean machine can go from zero to running in two commands.
5. Phase 1 extension wiring + Phase 4 status.
6. Credential vault, auth, rate limits, prod-isolation guards + CI check.
7. Phase 5 promote path.

Do not build the HTTP surface before step 2 proves the agent loop is good enough to be
worth a product around.
