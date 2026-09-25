# 0003 — Proxy mode, and why the sidecar lives under /__tapthat

## Context

Single-container hosts such as Railway expose one public HTTP port per service, and a
volume attaches to one service. The reviewer's browser needs the dev server, and the
extension needs the sidecar, on that one port.

The first version of proxy mode had the sidecar own `/api/*` and `/healthz` and forward
everything else. Tested against a real Next.js app (Dealroom), that broke the app: its
own `/api/[...path]` route was shadowed, and every API call got the sidecar's 401. Two
more failures showed up in the same test. The spawned dev server inherited the platform's
`PORT` and took the sidecar's port. And Next 16 refused the HMR websocket, because its
`Origin` was the public domain rather than localhost.

## Decision

- In proxy mode the sidecar owns **only** `/__tapthat/*`. Everything else, including
  websocket upgrades, goes to the dev server. Without proxy mode the sidecar also answers
  the bare paths, which keeps the npx and Compose URLs short.
- The extension's Sidecar URL includes the prefix (`https://dev.example.com/__tapthat`),
  and the client appends `/api/...` to whatever it is given, so one client serves both
  shapes.
- The proxy rewrites `Host` to the dev server's own, and passes the public host on as
  `X-Forwarded-Host`. On a websocket upgrade whose `Origin` matches the public host, it
  presents `Origin` as the dev server's. A foreign `Origin` is forwarded untouched, so the
  dev server's own protection still refuses it.
- The spawned dev server gets `PORT` from `devServerUrl`, never the platform's.

## Consequences

- Any app path is safe from the sidecar, except one prefix nobody uses.
- Same-origin traffic in proxy mode means no CORS preflight for the extension.
- Proxying is ~100 lines on `node:http` rather than a dependency, in keeping with the
  zero-runtime-dependency posture.
