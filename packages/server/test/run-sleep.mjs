/**
 * Sleep: the dev servers stop after a stretch without use and start again on
 * request. What counts as use decides what the playground costs, so both sides
 * are checked: use keeps it awake, and things that are not use (an open tab's
 * socket, the panel's polling, a tab reloading the asleep page) do not.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const bundle = await esbuild.build({
  entryPoints: [join(pkgRoot, 'src', 'testing.ts')],
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  packages: 'bundle', write: false,
});
const modDir = mkdtempSync(join(tmpdir(), 'tapthat-mod-'));
const modPath = join(modDir, 'mod.mjs');
writeFileSync(modPath, bundle.outputFiles[0].text);
const { Sleeper, parseProcNetLine, createHttpServer, Store, Repo, defaults, deriveKey } = await import(modPath);

let failed = 0;
let total = 0;
function check(label, ok, detail) {
  total++;
  if (!ok) { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}

const MINUTE = 60_000;

/** A port nothing listens on yet, for the sleeper to hold. */
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '::', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/** A sleeper on a fake clock, with fake dev servers and a scripted set of connections. */
async function makeSleeper(ports = []) {
  const state = { now: 0, running: true, stops: 0, starts: 0, sockets: new Set() };
  const sleeper = new Sleeper({
    afterMs: 30 * MINUTE,
    ports,
    stopServers: async () => { state.running = false; state.stops++; },
    startServers: () => { state.running = true; state.starts++; },
    connections: async () => new Set(state.sockets),
    now: () => state.now,
  });
  return { sleeper, state };
}

// ── what counts as use ──────────────────────────────────────────────────────
{
  const { sleeper, state } = await makeSleeper();
  state.now = 29 * MINUTE;
  await sleeper.check();
  check('awake before the timeout', !sleeper.isAsleep && state.running);
  state.now = 30 * MINUTE;
  await sleeper.check();
  check('asleep after the timeout, with the dev servers stopped', sleeper.isAsleep && !state.running && state.stops === 1);
  await sleeper.check();
  check('a sleeping workspace is not stopped twice', state.stops === 1);
  await sleeper.wake();
  check('wake starts the dev servers', !sleeper.isAsleep && state.running && state.starts === 1);
  await sleeper.wake();
  check('waking an awake workspace starts nothing', state.starts === 1);
  state.now += 29 * MINUTE;
  await sleeper.check();
  check('waking counts as use: the timeout starts over', !sleeper.isAsleep);
}
{
  const { sleeper, state } = await makeSleeper();
  state.now = 20 * MINUTE;
  sleeper.touch();
  state.now = 45 * MINUTE;
  await sleeper.check();
  check('a touch (a request through the sidecar) keeps it awake', !sleeper.isAsleep);
}
{
  const { sleeper, state } = await makeSleeper();
  await sleeper.check();
  // A gateway calls a dev server directly: the sidecar sees only new connections.
  for (let m = 1; m <= 40; m++) {
    state.now = m * MINUTE;
    state.sockets = new Set([`conn-${m}`]);
    await sleeper.check();
  }
  check('new connections to the dev servers keep it awake', !sleeper.isAsleep);
}
{
  const { sleeper, state } = await makeSleeper();
  // A tab left open: its hot-reload socket stays, and nothing else happens.
  state.sockets = new Set(['hmr-socket']);
  for (let m = 0; m <= 30; m++) {
    state.now = m * MINUTE;
    await sleeper.check();
  }
  check('an open hot-reload socket alone does not keep it awake', sleeper.isAsleep);
}
{
  const { sleeper, state } = await makeSleeper();
  let busy = true;
  sleeper.busyWhen(() => busy);
  state.now = 60 * MINUTE;
  await sleeper.check();
  check('never sleeps while a batch or session step runs', !sleeper.isAsleep);
  busy = false;
  state.now = 89 * MINUTE;
  await sleeper.check();
  check('the timeout counts from when the work finished', !sleeper.isAsleep);
  state.now = 90 * MINUTE;
  await sleeper.check();
  check('and it sleeps once that has passed', sleeper.isAsleep);
}
{
  const { sleeper, state } = await makeSleeper();
  await Promise.all([sleeper.sleep(), sleeper.wake(), sleeper.sleep()]);
  check('sleep and wake run in the order asked', sleeper.isAsleep && state.stops === 2 && state.starts === 1);
  await sleeper.close();
}

// ── /proc/net/tcp ───────────────────────────────────────────────────────────
{
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  check('the header row is not a connection', parseProcNetLine(header)?.localPort === undefined || Number.isNaN(parseProcNetLine(header)?.localPort));
  const v4 = parseProcNetLine('   0: 0100007F:0BB8 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 20 4 30 10 -1');
  check('IPv4 loopback is recognised', v4?.localPort === 3000 && v4.established && v4.loopback && v4.inode === '4242');
  const v6 = parseProcNetLine('   1: 00000000000000000000000000000000:0BB9 B80D01200000000000000000A1B2C3D4:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 777 1 0000000000000000 20 4 30 10 -1');
  check('a private-network IPv6 peer is remote', v6?.localPort === 3001 && v6.established && !v6.loopback);
  const mapped = parseProcNetLine('   2: 00000000000000000000000000000000:0BB8 0000000000000000FFFF00000100007F:9C41 01 00000000:00000000 00:00000000 00000000  1000        0 778 1 0000000000000000 20 4 30 10 -1');
  check('IPv4-mapped loopback is loopback', mapped?.loopback === true);
  const one = parseProcNetLine('   3: 00000000000000000000000001000000:0BB8 00000000000000000000000001000000:9C42 01 00000000:00000000 00:00000000 00000000  1000        0 779 1 0000000000000000 20 4 30 10 -1');
  check('::1 is loopback', one?.loopback === true);
  const listen = parseProcNetLine('   4: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 780 1 0000000000000000 20 4 30 10 -1');
  check('a listening socket is not a connection', listen?.established === false);
}

// ── the held ports while asleep ─────────────────────────────────────────────
{
  const port = await freePort();
  const { sleeper, state } = await makeSleeper([port]);
  await sleeper.sleep();
  const base = `http://localhost:${port}`;

  const page = await fetch(`${base}/rooms/1`, { headers: { accept: 'text/html' } });
  const html = await page.text();
  check('a page request to a sleeping dev server gets the asleep page',
    page.status === 503 && page.headers.get('x-tapthat-asleep') === '1' && html.includes('Wake it up'));
  check('loading the asleep page does not wake it', sleeper.isAsleep && state.starts === 0);
  const asset = await fetch(`${base}/_next/static/chunk.js`);
  check('anything else gets a short 503', asset.status === 503 && !(await asset.text()).includes('<html'));
  check('nor does an asset request', sleeper.isAsleep);

  const woke = await fetch(`${base}/__tapthat/wake`, { method: 'POST' });
  check('POST /__tapthat/wake on the held port is accepted', woke.status === 202);
  await sleeper.wake(); // wait for the wake the request queued
  check('and wakes the workspace', !sleeper.isAsleep && state.starts === 1);

  // The port is free again for the dev server.
  const devServer = createServer((_q, r) => r.end('dev server'));
  const bound = await new Promise((done) => {
    devServer.once('error', () => done(false));
    devServer.listen(port, '::', () => done(true));
  });
  check('waking gives the port back to the dev server', bound);
  await new Promise((r) => devServer.close(r));
  await sleeper.close();
}

// ── the sidecar's own routes ────────────────────────────────────────────────
{
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const repoDir = mkdtempSync(join(tmpdir(), 'tapthat-sleep-'));
  git(repoDir, 'init', '-q', '-b', 'dev');
  git(repoDir, 'config', 'user.email', 't@e.com');
  git(repoDir, 'config', 'user.name', 'T');
  writeFileSync(join(repoDir, 'app.js'), 'export const x = 1;\n');
  git(repoDir, 'add', '-A'); git(repoDir, 'commit', '-q', '-m', 'init');

  const upstream = createServer((req, res) => res.end(`dev server: ${req.url}`));
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  const TOKEN = 'test-token-abcdefghijklmnop';
  const { sleeper, state } = await makeSleeper();
  const server = createHttpServer({
    config: {
      ...defaults(repoDir), repoRoot: repoDir, branch: 'dev',
      proxy: { enabled: true, target: upstreamUrl }, devServerUrl: upstreamUrl,
    },
    repo: new Repo(repoDir),
    store: await Store.open(join(mkdtempSync(join(tmpdir(), 'st-')), 'state.json')),
    encryptionKey: deriveKey('k'), token: TOKEN, envCredential: null, version: '0.0.0',
    sleep: sleeper,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Bearer ${TOKEN}` };

  state.now = 10 * MINUTE;
  const health = await (await fetch(`${base}/__tapthat/healthz`)).json();
  check('healthz reports sleep', health.sleep?.asleep === false && health.sleep.afterMinutes === 30);
  await fetch(`${base}/__tapthat/api/session`, { headers: auth });
  state.now = 30 * MINUTE;
  await sleeper.check();
  check("the panel's polling (healthz, session status) is not use", sleeper.isAsleep);
  await sleeper.wake();

  const refused = await fetch(`${base}/__tapthat/api/sleep`, { method: 'POST' });
  check('Sleep needs the token', refused.status === 401 && !sleeper.isAsleep);
  const slept = await fetch(`${base}/__tapthat/api/sleep`, { method: 'POST', headers: auth });
  check('Sleep with the token stops the dev servers', slept.status === 200 && sleeper.isAsleep);

  const page = await fetch(`${base}/rooms`, { headers: { accept: 'text/html' } });
  check('the proxied site answers with the asleep page while asleep',
    page.status === 503 && (await page.text()).includes('Wake it up'));
  check('and is not woken by it', sleeper.isAsleep);
  const asleepHealth = await (await fetch(`${base}/__tapthat/healthz`)).json();
  check('healthz says asleep', asleepHealth.sleep.asleep === true);

  const woke = await fetch(`${base}/__tapthat/wake`, { method: 'POST' });
  check('/__tapthat/wake on the sidecar wakes it, without a token', woke.status === 202 && !sleeper.isAsleep);
  const proxied = await fetch(`${base}/rooms`);
  check('awake, the site is proxied again', (await proxied.text()) === 'dev server: /rooms');

  state.now = 100 * MINUTE;
  await fetch(`${base}/rooms`);
  state.now = 129 * MINUTE;
  await sleeper.check();
  check('a proxied request is use', !sleeper.isAsleep);

  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
  await sleeper.close();
  rmSync(repoDir, { recursive: true, force: true });
}

rmSync(modDir, { recursive: true, force: true });

console.log(failed === 0 ? `PASS — ${total} sleep checks` : `FAIL — ${failed} of ${total} sleep checks`);
process.exit(failed === 0 ? 0 : 1);
