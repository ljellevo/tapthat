## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Layout

npm workspaces monorepo. Sources live under `packages/`, not at the repo root:

- `packages/client/` — the Chromium MV3 extension (`src/`, `test/`, `manifest.json`,
  `build.mjs`, `package.mjs`). Build output is `packages/client/dist/`, and
  `npm run package` writes `packages/client/tapthat.zip`.
- `packages/shared/` — private, never published. Types, the HTTP protocol, and the one
  prompt builder used by both the extension and the sidecar. Compiled with
  `"lib": ["ES2022"], "types": []` so any DOM access in it is a typecheck failure.
- `packages/server/` — `tapthat-server`, the agent runner. Published to npm and ghcr.

Run everything from the repo root: `npm run check` fans out across workspaces.
