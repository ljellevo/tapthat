# tapthat-server

Applies [TapThat](https://github.com/ljellevo/tapthat) comments to your repository with a
coding agent, beside your dev server, so a reviewer sees the change in their browser within
seconds.

> ⚠️ **Development tool. Never run it in production.** It accepts instructions that modify
> your repository. It refuses to start when `NODE_ENV=production`, needs an explicit
> `TAPTHAT_ENABLE=1`, and belongs in `devDependencies` only. See
> [security.md](https://github.com/ljellevo/tapthat/blob/main/docs/security.md).

```
TapThat extension ──Apply──▶ sidecar ──claude -p──▶ edits files in your working tree
                                 ├─▶ your dev server's HMR shows it   (seconds)
                                 └─▶ git commit (+ push, optional)
```

## Quickstart

In the repository you want edited, on the branch the agent should commit to (not `main`):

```bash
npm i -D tapthat-server
npx tapthat-server init            # config + secrets, prints what to paste into the extension
TAPTHAT_ENABLE=1 npx tapthat-server
```

It needs Node 20+, git, and the Claude Code CLI (`npm i -g @anthropic-ai/claude-code`). The
Docker image `ghcr.io/ljellevo/tapthat-server` includes all three and runs on Compose or a
single-container host such as Railway, where it clones the repository, starts the dev
server, and serves it all on one port.

## Commands

| | |
|---|---|
| `tapthat-server init` | Write `tapthat.config.json` and `.tapthat/secrets.env` |
| `tapthat-server` | Start (needs `TAPTHAT_ENABLE=1`) |
| `tapthat-server doctor` | Check config, repo, agent CLI and secrets |
| `tapthat-server run-file batch.json` | Run one batch without HTTP |
| `tapthat-server audit-prod` | Fail CI if the sidecar is in a production dependency tree |

## Documentation

- [Install guide](https://github.com/ljellevo/tapthat/blob/main/INSTALL.md): service side and client side, step by step
- [Setup reference](https://github.com/ljellevo/tapthat/blob/main/docs/setup.md): npx, Docker Compose, Railway, every setting
- [Security](https://github.com/ljellevo/tapthat/blob/main/docs/security.md) · [HTTP API](https://github.com/ljellevo/tapthat/blob/main/docs/api.md) · [Troubleshooting](https://github.com/ljellevo/tapthat/blob/main/docs/troubleshooting.md)

MIT licensed.
