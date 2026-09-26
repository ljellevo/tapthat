# A playground environment

The richest way to run TapThat: a separate environment, a *playground*, where
non-developers apply changes that hot-reload **across services**, iterate freely, and send
the result to your `dev` branch in one step. From `dev`, your platform deploys as usual.

```
Railway project
├─ environment "dev"      every service deploys from the `dev` branch, as normal
│    app · api · auth · storage · … · postgres · redis
│         ▲                                   │
│         │ Commit to dev (git push)          │ Start session (pg_dump, read-only)
│         │                                   ▼
└─ environment "tapthat"  the playground
     workspace ← TapThat image, one volume, the only public service
     │   repos/app   next dev  :3000   ← proxied on the public domain, with HMR
     │   repos/api   tsx watch :3100   ← localhost only; the app's /api routes call it
     auth · storage · … · postgres · redis   ← normal deploys from `dev`, own data
```

This was tested end to end against Dealroom's real `app` and `api` in a container started
the way Railway starts it:
- From an empty volume, it cloned both repos, installed both, and started both dev
  servers.
- Start session copied the dev database, and the API came up on the copy.
- One comment changed an API route *and* a page. Both went live in about a second, and the
  API change was visible through the app's own `/api` proxy.
- Commit to dev pushed `api`, then `app`, one squashed commit each.
- A restart mid-session resumed in 2 seconds.

> **This is a development environment.** The same rules as everywhere in TapThat apply:
> see [security.md](security.md). The playground can change code on `dev`, never `main`,
> and nothing reaches customers until your developers merge and release as usual.

---

## How it works for a reviewer

1. **Start session.** The playground catches up with `dev`: every repository
   fast-forwards to `dev`, and `dev`'s databases are copied into the playground's Postgres.
   Migrations then run and the dev servers restart. This takes a few minutes; the panel
   shows progress per database.
2. **Comment and Apply**, as often as needed. Each batch may change several repositories.
   It hot-reloads immediately and is committed on a local *session branch*, so per-batch
   **Undo** still works. Nothing is pushed yet. Everyone using the playground shares the
   session and sees each other's changes.
3. **Commit to dev** (two clicks). Per repository, in the configured order (the API before
   the app that depends on it):
   1. The session is squashed into one commit, listing each change, its comments and its
      reviewers.
   2. If `dev` moved in the meantime, the commit is replayed onto it.
   3. It is pushed.

   Every repository is checked before any is pushed. A conflict anywhere, or edits left
   behind by a broken build, refuses the whole Commit, pushes nothing, and leaves the
   session exactly as it was.
4. The session ends and the playground moves onto the new `dev`. **Discard all** ends it
   without sending anything, and **puts the data back** to the copy taken at Start, so a
   session is always fully reversible.

---

## Setting it up

The example is Dealroom (`app` + `api`). Any set of repositories works the same way.

### 1. The workspace config, committed in the primary repository

The sidecar clones the primary repository (the one whose pages reviewers look at), reads
its `tapthat.config.json`, and clones the rest from there. Commit this to `app`, on `dev`:

```json
{
  "branch": "dev",
  "git": { "mode": "session", "deployOrder": ["api", "app"] },
  "agent": {
    "rules": [
      "Do not change Prisma schemas or migrations (shared/db-*/prisma). If a request needs a database change, stop and say exactly what is needed."
    ]
  },
  "repos": [
    {
      "name": "app", "primary": true,
      "description": "Next.js customer app. Pages under src/app; src/app/api/[...path] forwards /api/* to the API.",
      "verifyCommand": "npm run typecheck",
      "devServer": {
        "command": "npm run dev", "url": "http://localhost:3000", "install": "npm ci --no-audit --no-fund",
        "env": { "DEALROOM_API_URL": "http://localhost:3100" }
      }
    },
    {
      "name": "api", "url": "https://github.com/dealroom-no/api.git",
      "description": "Express core API. Routes under src/routes; shared/contracts holds the types app also uses.",
      "verifyCommand": "npm run typecheck",
      "devServer": {
        "command": "npm run dev", "url": "http://localhost:3100", "install": "npm ci --no-audit --no-fund",
        "prepare": "npm run migrate:deploy",
        "env": {
          "PLATFORM_DATABASE_URL": "${API_PLATFORM_DATABASE_URL}",
          "TENANCY_MAINTENANCE_URL": "${API_TENANCY_MAINTENANCE_URL}",
          "TENANCY_DB_HOST": "${API_TENANCY_DB_HOST}",
          "TENANCY_DB_PORT": "${API_TENANCY_DB_PORT}",
          "TENANCY_MASTER_KEY": "${API_TENANCY_MASTER_KEY}",
          "REDIS_URL": "${API_REDIS_URL}",
          "AUTH_SERVICE_URL": "${API_AUTH_SERVICE_URL}",
          "AUTH_SERVICE_TOKEN": "${API_AUTH_SERVICE_TOKEN}",
          "STORAGE_SERVICE_URL": "${API_STORAGE_SERVICE_URL}",
          "STORAGE_SERVICE_TOKEN": "${API_STORAGE_SERVICE_TOKEN}",
          "WEB_ORIGIN": "${API_WEB_ORIGIN}",
          "STORAGE_DRIVER": "mock", "PAYMENT_DRIVER": "mock", "MAIL_DRIVER": "console"
        }
      }
    }
  ],
  "mirrors": [
    { "from": "api:shared/contracts", "to": ["app:shared/contracts"], "alsoUsedBy": ["admin", "homepage", "auth", "payment"] }
  ],
  "session": {
    "snapshot": {
      "source": "${TAPTHAT_DEV_DATABASE_URL}",
      "target": "${TAPTHAT_PLAYGROUND_DATABASE_URL}",
      "redis": "${API_REDIS_URL}",
      "stopServers": ["api"]
    }
  }
}
```

What the parts do:

- **`repos`**: each checkout, its dev server, and a description the agent reads to know
  which repository holds what. `${NAME}` is filled from the service's variables, so each
  dev server gets only its own environment and no secret is committed.
- **`prepare`** runs on every boot and after every data copy. It must be idempotent, as
  migrations are. **`install`** is skipped when the lockfiles haven't changed.
- **`mirrors`**: the agent edits `api/shared/contracts`, and the copy in `app` is updated
  in the same batch. Editing only the copy is refused. On Commit, the repos in
  `alsoUsedBy` are named in a notice, because they keep their own copies (Dealroom's
  `sync.sh`).
- **`deployOrder`**: the API is pushed before the app, so the app never deploys against an
  API that lacks what it needs.
- **`agent.rules`**: house rules for the prompt. Schema changes are off here: the agent
  stops and says what's needed instead.

### 2. The Railway environment

Add a `tapthat` environment in which one `workspace` service replaces `app` and `api`. In
Dealroom's `resources/.railway/railway.ts` (typechecked against its `railway/iac`
version), add `image` to the `railway/iac` import. Then:

```ts
// ── The TapThat playground ───────────────────────────────────────────────────
// In the `tapthat` environment one `workspace` service replaces app and api:
// it clones both, runs them as dev servers side by side, and serves the app on
// its public domain. Start session copies dev's data into this environment's
// Postgres; Commit to dev pushes to the `dev` branch, which dev deploys.
const playground = ctx.isEnvironment("tapthat");
const workspace = service("workspace", {
  source: image("ghcr.io/ljellevo/tapthat-server:latest"),
  replicas: { [REGION]: 1 },
  healthcheck: "/__tapthat/healthz",
  // The first boot clones both repos and runs npm ci twice.
  healthcheckTimeout: 900,
  volumeMounts: { "/workspace": volume("tapthat-workspace", { region: REGION }) },
  env: {
    NODE_ENV: "development",
    PORT: "8080",
    TAPTHAT_ENABLE: "1",
    TAPTHAT_TOKEN: preserve(),
    TAPTHAT_ENCRYPTION_KEY: preserve(),
    // Fine-grained, Contents read and write on app and api.
    TAPTHAT_GIT_TOKEN: preserve(),
    TAPTHAT_WORKSPACE_ROOT: "/workspace/repos",
    TAPTHAT_REPO_ROOT: "/workspace/repos/app",
    TAPTHAT_REPO_URL: `https://github.com/${OWNER}/app.git`,
    TAPTHAT_PROXY: "1",
    TAPTHAT_START_DEV_SERVER: "1",
    TAPTHAT_ALLOWED_ORIGINS: `https://${ref("workspace", "RAILWAY_PUBLIC_DOMAIN")}`,
    // Start session reads dev's Postgres through its TCP proxy as a read-only
    // role (pg_read_all_data), and writes this environment's.
    TAPTHAT_DEV_DATABASE_URL: preserve(),
    TAPTHAT_PLAYGROUND_DATABASE_URL:
      `postgresql://${ref("postgres", "PGUSER")}:${ref("postgres", "PGPASSWORD")}@${ref("postgres", "PGHOST")}:${ref("postgres", "PGPORT")}/postgres`,
    // Roles and their passwords are copied from dev, so these must hold the
    // same values as in dev.
    PLATFORM_DB_PASSWORD: preserve(),
    TENANCY_DB_PASSWORD: preserve(),
    API_TENANCY_MASTER_KEY: preserve(),
    // What api needs, mapped into its dev server by tapthat.config.json.
    API_PLATFORM_DATABASE_URL: database("dealroom_platform", "PLATFORM_DB_PASSWORD", "dealroom_platform"),
    API_TENANCY_MAINTENANCE_URL: database("dealroom_tenancy", "TENANCY_DB_PASSWORD", "postgres"),
    API_TENANCY_DB_HOST: db.env.PGHOST,
    API_TENANCY_DB_PORT: db.env.PGPORT,
    API_REDIS_URL: REDIS_URL,
    API_AUTH_SERVICE_URL: internal("auth", 3200),
    API_AUTH_SERVICE_TOKEN: auth.env.AUTH_SERVICE_TOKEN,
    API_STORAGE_SERVICE_URL: internal("storage", 3300),
    API_STORAGE_SERVICE_TOKEN: storage.env.STORAGE_SERVICE_TOKEN,
    API_WEB_ORIGIN: `https://${ref("workspace", "RAILWAY_PUBLIC_DOMAIN")}`,
  },
});
```

The project then lists both environments and swaps the two services for `workspace` in
the playground:

```ts
return project("dealroom", {
  environments: ["dev", "tapthat"],
  resources: [db, cache, auth, storage, payment, webhooks,
    ...(playground ? [workspace] : [api, web("app", 3000)]), web("admin", 3400), homepage],
});
```

The `dev` environment's services deploy from branch `dev` (`BRANCH = "dev"` in
`railway.ts`). The playground's own `auth`, `storage` and so on also deploy from `dev`,
unmodified.

### 3. One-time setup in `dev`

1. **A read-only login for the copy.** Add it to `deploy/postgres/roles.sql`, or run it
   once through the TCP proxy:
   ```sql
   CREATE ROLE dealroom_dump LOGIN PASSWORD '<a long random password>';
   GRANT pg_read_all_data TO dealroom_dump;
   ```
   `pg_read_all_data` reads every table **and the role password hashes**, which the copy
   needs, so no superuser is involved. This was verified against real databases. A login
   without that grant still copies the data, but not the passwords, and the panel says so.
2. **Reach `dev`'s Postgres from the playground.** Railway environments cannot reach each
   other over the private network, so keep a TCP proxy open on `dev`'s Postgres
   (`railway tcp-proxy create --port 5432 --service postgres` in `dev`). DEPLOY.md closes
   it after bootstrap today; this is a deliberate change. It is a public endpoint guarded
   by a strong password and a read-only role.
3. **Set `TAPTHAT_DEV_DATABASE_URL`** in the playground to
   `postgresql://dealroom_dump:<password>@<proxy host>:<proxy port>/postgres`.

### 4. Values that must match `dev`

The copy brings `dev`'s roles *with their passwords*, and Dealroom seals each data room's
password with `TENANCY_MASTER_KEY`. So in the `tapthat` environment:

- **`API_TENANCY_MASTER_KEY` equals `dev`'s `TENANCY_MASTER_KEY`.** Otherwise the copied
  rooms can't be opened.
- **Every database password variable equals `dev`'s:** `PLATFORM_DB_PASSWORD`,
  `TENANCY_DB_PASSWORD`, and `auth`'s. After a copy, the roles have `dev`'s passwords.

Service tokens (`AUTH_SERVICE_TOKEN`, …) stay per environment: they live in variables, not
in the database.

### 5. Deploy, then connect the extension

`railway config apply` for the `tapthat` environment, then generate a domain for
`workspace`. Reviewers set the extension's **Sidecar URL** to
`https://<workspace domain>/__tapthat` with the `TAPTHAT_TOKEN` (see
[INSTALL.md](../INSTALL.md#part-2--the-client-each-reviewers-browser)). On the playground,
the panel opens with **Start session**.

---

## Settings

Everything in [setup.md's reference](setup.md#configuration-reference), plus:

| Setting | Default | Environment | Notes |
|---|---|---|---|
| `repos[]` | one repo, from the classic settings | | `name`, `url`, `path`, `branch`, `primary`, `description`, `verifyCommand`, `devServer{command,url,install,prepare,env}` |
| `workspace.root` | the primary repo's parent directory | `TAPTHAT_WORKSPACE_ROOT` | The agent's working directory |
| `mirrors[]` | none | | `{from: "repo:path", to: ["repo:path"], alsoUsedBy: []}` |
| `agent.rules` | none | | Sentences added to the prompt |
| `git.mode` | `commit` | `TAPTHAT_GIT_MODE` | `session` for a playground |
| `git.deployOrder` | workspace order | | Push order on Commit |
| `session.snapshot.source` | none | `TAPTHAT_SNAPSHOT_SOURCE` | `dev`'s Postgres, read-only |
| `session.snapshot.target` | none | `TAPTHAT_SNAPSHOT_TARGET` | The playground's Postgres, as a user that can drop and create databases |
| `session.snapshot.redis` | none | `TAPTHAT_SNAPSHOT_REDIS` | Flushed after each copy |
| `session.snapshot.exclude` | none | | Databases not copied (`postgres` and templates never are) |
| `session.snapshot.stopServers` | none | | Dev servers stopped while their databases are replaced |
| `session.onStart` | none | | Extra commands after the copy, for data that isn't in Postgres |

The image carries `pg_dump` 18, Railway's current Postgres template. `pg_dump` reads older
servers fine but refuses newer ones: for a newer server, build with
`--build-arg PG_MAJOR=<n>`.

## Not covered yet

- **Document files.** They live on `storage`'s volume, not in Postgres. After a copy, the
  document list and metadata match `dev`, but previews of `dev`'s files may be missing.
- **Schema changes by the agent** are ruled out by the example's `agent.rules`. The
  plumbing makes them possible later: the playground has its own database, and Discard
  restores the start copy.
- **One playground per reviewer.** Everyone on a playground shares its session.
- **Deploy status.** After Commit, the panel says what was pushed, not whether `dev`
  deployed it.
