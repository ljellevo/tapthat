# 0002 — A JSON file for state, not SQLite

## Context

`plan.md` specified SQLite on a volume, "to keep the dependency count near zero". The
state is one in-flight job, a few dozen recent batches, and a handful of sealed
credentials. There is one process and one writer, and git is the durable record of
anything that matters.

## Decision

State lives in `state.json` in the state directory. Writes go to a temp file, which is
then renamed, debounced. Batches older than 7 days are pruned on boot. The store
interface is narrow (`get/put/list/delete`), so swapping the backend touches one file.

## Consequences

- Zero runtime dependencies. `better-sqlite3` is a native addon, the single most likely
  thing to break `npx` on an unknown machine, and `node:sqlite` is still moving.
- A crash mid-write can't truncate the file. A corrupt file is logged and ignored on
  boot, because everything in it can be recreated: reviewers paste keys again, and batch
  history is in git.
- It does not scale to many writers, and doesn't need to (ADR 0001).
