import * as esbuild from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');

// Resolved against this file rather than cwd, so `node packages/extension/build.mjs`
// from the repo root behaves the same as the workspace script.
const root = dirname(fileURLToPath(import.meta.url));
const src = (...p) => join(root, 'src', ...p);
const out = (...p) => join(root, 'dist', ...p);

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  target: 'chrome111',
  logLevel: 'info',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
};

const configs = [
  {
    ...shared,
    entryPoints: [src('background.ts')],
    outfile: out('background.js'),
    format: 'esm',
  },
  {
    ...shared,
    entryPoints: [src('content', 'index.ts')],
    outfile: out('content.js'),
    format: 'iife',
  },
];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching...');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
