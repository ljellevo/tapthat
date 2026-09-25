# 0004 — Playground sessions, built with git plumbing

## Context

Non-developers should change several services in a separate environment and send the
result to `dev` when they are happy. That needs a unit bigger than a batch (the session),
a way to send it that can't leave `dev` half-updated across repositories, and a data copy
so the playground starts from what `dev` looks like.

## Decision

- **Batches commit on a local session branch per repo**, never pushed. Per-batch Undo keeps
  working, and the session branch is disposable.
- **Commit to dev is built with plumbing:**
  - `commit-tree` squashes HEAD's tree onto the session's base;
  - `merge-tree --write-tree` replays it onto the latest `dev` in memory (git ≥ 2.38);
  - `commit-tree` again parents the result on `dev`.

  Nothing touches the working tree or index until every repository has a result, so a
  conflict anywhere means nothing is pushed and nothing needs cleaning up. Pushes go in
  `deployOrder`.
- **No hard reset anywhere:**
  - Discard restores the paths a session left behind, switches back to the base branch,
    and deletes the session branch.
  - Boot never fast-forwards a repo that is on a session branch.
- **The data copy is pg_dump/pg_restore per database, roles first**, with the dumps kept
  as the session's restore point. The source is a read-only role with `pg_read_all_data`,
  which (verified) reads password hashes too.
- **Sessions are polled, not streamed.** A session step takes minutes, not seconds, and the
  extension already polls `/healthz`; SSE would add a second token scheme for no visible
  gain.

## Consequences

- A push can still fail mid-way if someone pushes to `dev` between the replay and the push.
  The error names what was already sent. That's rare, and visible rather than silent.
- The playground's database passwords and `TENANCY_MASTER_KEY` must equal `dev`'s, because
  roles arrive with their passwords.
- Files outside Postgres (document bytes) are not copied yet.
