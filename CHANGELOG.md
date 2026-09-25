# Changelog

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

### `@tapthat/sidecar` 0.1.0

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
- Docker image `ghcr.io/ljellevo/tapthat-sidecar` with git and the Claude Code CLI; drops
  root on start.

### Fixed during Railway validation

- The spawned dev server took the sidecar's `PORT`.
- Proxy mode shadowed the app's own `/api/*` routes.
- Next 16 refused the proxied HMR websocket.
- Undo failed in containers without a git identity.
