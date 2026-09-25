import * as esbuild from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// packages: 'bundle' inlines @tapthat/shared, so the published package has no
// runtime dependencies and `npx tapthat-sidecar` starts without an install.
await esbuild.build({
  entryPoints: [join(root, 'src', 'cli.ts')],
  outfile: join(root, 'dist', 'cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'bundle',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
