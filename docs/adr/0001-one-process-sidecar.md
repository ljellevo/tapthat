# 0001 — One process: API, queue, vault and agent runner together

## Context

`plan.md` first sketched a control plane (HTTP API, queue, credential vault) and a warm
worker (repository, dev server, agent) as separate services. The worker already holds the
working tree and sits beside the dev server; the control plane has almost no state of its
own.

## Decision

One process, `tapthat-server`, runs everything, beside the dev server and in its working
tree. It ships two ways from one codebase: an npm package with a `bin` entry (`npx`), and a
Docker image that also carries git and the Claude Code CLI.

## Consequences

- No network hop, no second deployment, no service-to-service auth.
- The dev server and the sidecar must share a filesystem. That rules out two separate
  services on hosts where a volume attaches to one service (Railway), which is why the
  sidecar can start the dev server itself and front it (proxy mode, ADR 0003).
- Scaling means one sidecar per dev environment, which matches the single shared branch
  this design targets. Branch-per-reviewer is out of scope.
