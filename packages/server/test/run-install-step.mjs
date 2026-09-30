/**
 * The install step Start session and Discard run: a repo whose dependencies
 * changed is reinstalled with its dev server stopped around it; the rest are
 * left alone, their servers still running.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const bundle = await esbuild.build({
  entryPoints: [join(pkgRoot, 'src', 'testing.ts')],
  bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'bundle', write: false,
});
const modDir = mkdtempSync(join(tmpdir(), 'tapthat-install-step-mod-'));
writeFileSync(join(modDir, 'mod.mjs'), bundle.outputFiles[0].text);
const { makeInstallStep } = await import(join(modDir, 'mod.mjs'));

let failed = 0;
let total = 0;
function check(label, ok, detail) {
  total++;
  if (!ok) { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}

/** A step over `repos`, of which `changed` need installing and `running` have a server up. */
function harness({ repos, changed, running, failing = [] }) {
  const calls = [];
  const up = new Set(running);
  const events = [];
  const step = makeInstallStep({
    repos,
    needsInstall: async (name) => changed.includes(name),
    install: async (name) => {
      calls.push(`install:${name}`);
      if (failing.includes(name)) throw new Error(`${name}: install failed`);
    },
    isRunning: (name) => up.has(name),
    stopServer: async (name) => { calls.push(`stop:${name}`); up.delete(name); },
    startServer: async (name) => { calls.push(`start:${name}`); up.add(name); },
  });
  return { calls, up, events, run: () => step((message) => events.push(message)) };
}

console.log('install step');
{
  const h = harness({ repos: ['app', 'api', 'auth'], changed: ['app'], running: ['app', 'api', 'auth'] });
  await h.run();
  check('only the repo whose dependencies changed is installed, its server stopped around it',
    h.calls.join(',') === 'stop:app,install:app,start:app', h.calls.join(','));
  check('every server is running afterwards', ['app', 'api', 'auth'].every((n) => h.up.has(n)));
  check('the progress names the repo', h.events.some((e) => e.includes('app')), h.events.join(' | '));
}
{
  const h = harness({ repos: ['app', 'api'], changed: [], running: ['app', 'api'] });
  await h.run();
  check('nothing changed: nothing is stopped or installed', h.calls.length === 0, h.calls.join(','));
  check('nothing changed: no progress is reported', h.events.length === 0, h.events.join(' | '));
}
{
  const h = harness({ repos: ['app', 'api'], changed: ['api'], running: ['app'] });
  await h.run();
  check('a repo without a running server is installed, and not started',
    h.calls.join(',') === 'install:api', h.calls.join(','));
}
{
  const h = harness({ repos: ['app', 'api'], changed: ['app', 'api'], running: ['app', 'api'], failing: ['app'] });
  let threw = null;
  try { await h.run(); } catch (err) { threw = err; }
  check('a failed install fails the step', threw?.message === 'app: install failed', String(threw));
  check('its server is started again all the same', h.up.has('app') && h.calls.includes('start:app'), h.calls.join(','));
  check('the repos after it are not touched', !h.calls.some((c) => c.endsWith(':api')), h.calls.join(','));
}

console.log(`\n${total - failed}/${total} passed`);
if (failed) process.exit(1);
