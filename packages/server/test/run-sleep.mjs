/**
 * Sleep: the dev servers stop after a stretch without use and start again on
 * request. What counts as use decides what the playground costs, so both sides
 * are checked: use keeps it awake, and things that are not use (an open tab's
 * hot-reload socket, the panel's polling, a tab reloading the asleep page) do not.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const { Sleeper, isRequestLine, listening, DevServers, createHttpServer, Store, Repo, defaults, deriveKey } = await import(modPath);

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
  const state = { now: 0, running: true, stops: 0, starts: 0, changes: [] };
  const sleeper = new Sleeper({
    afterMs: 30 * MINUTE,
    ports,
    stopServers: async () => { state.running = false; state.stops++; },
    startServers: () => { state.running = true; state.starts++; },
    onChange: (asleep) => state.changes.push(asleep),
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
  // A gateway calls a dev server directly: the sidecar sees its request lines.
  for (let m = 1; m <= 40; m++) {
    state.now = m * MINUTE;
    if (m % 10 === 0) sleeper.noteOutput(' GET /rooms 200 in 41ms (next.js: 4ms, application-code: 37ms)');
    await sleeper.check();
  }
  check('a request a dev server logs keeps it awake', !sleeper.isAsleep);
}
{
  const { sleeper, state } = await makeSleeper();
  // A tab left open overnight: its hot-reload socket reconnects every few
  // minutes, and the dev servers print what they print when idle.
  for (let m = 0; m <= 30; m++) {
    state.now = m * MINUTE;
    sleeper.noteOutput('✓ Compiled in 120ms');
    sleeper.noteOutput('[00:16:28] INFO (api): request completed');
    await sleeper.check();
  }
  check('output that is not a request does not keep it awake', sleeper.isAsleep);
  check('sleeping is reported, so a restart can come back asleep', state.changes.join() === 'true');
  await sleeper.wake();
  check('and so is waking', state.changes.join() === 'true,false');
}
{
  check('a Next.js request line is a request', isRequestLine(' GET /rooms/1/members 200 in 156ms (next.js: 15ms, application-code: 141ms)'));
  check('so is one with colours', isRequestLine('\x1b[1mPOST\x1b[22m /api/session 201 in 9ms'));
  check('and a morgan one', isRequestLine('GET /health 200 1.234 ms - 2'));
  check('a Next.js banner is not', !isRequestLine('   - Local:         http://localhost:3000'));
  check('nor a compile', !isRequestLine(' ✓ Compiled /rooms in 1.2s'));
  check('nor a Prisma line', !isRequestLine('Datasource "db": PostgreSQL database "dealroom_auth"'));
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

// ── probes ──────────────────────────────────────────────────────────────────
{
  // The sidecar's own probes must not print a request line on a dev server, or
  // an open panel (polling health every 20 s) would keep the workspace awake.
  let requests = 0;
  const devServer = createServer((_q, r) => { requests++; r.end('dev'); });
  await new Promise((r) => devServer.listen(0, '::', r));
  const { port } = devServer.address();
  check('a listening dev server is seen as up', await listening(`http://localhost:${port}`));
  check('without a request reaching it', requests === 0);
  await new Promise((r) => devServer.close(r));
  check('a closed port is seen as down', !(await listening(`http://localhost:${port}`)));
}
{
  const lines = [];
  const dir = mkdtempSync(join(tmpdir(), 'tapthat-out-'));
  const servers = new DevServers(
    [{ name: 'app', command: `node -e "console.log('GET /a 200 in 1ms'); process.stdout.write('GET /b 200'); setTimeout(() => console.log(' in 2ms'), 50); setInterval(() => {}, 1000)"`, cwd: dir, url: 'http://localhost:1', env: {} }],
    (line) => lines.push(line),
  );
  servers.startAll();
  await new Promise((r) => setTimeout(r, 1500));
  await servers.stopAll();
  check("a dev server's output reaches the sleeper line by line, split chunks joined",
    lines.includes('GET /a 200 in 1ms') && lines.includes('GET /b 200 in 2ms'), JSON.stringify(lines));
  rmSync(dir, { recursive: true, force: true });
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

  state.now = 200 * MINUTE;
  sleeper.touch();
  state.now = 229 * MINUTE;
  await new Promise((done) => {
    const socket = connectTcp(server.address().port, '127.0.0.1', () => {
      socket.write('GET /_next/hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      setTimeout(() => { socket.destroy(); done(); }, 200);
    });
    socket.on('error', done);
  });
  state.now = 230 * MINUTE;
  await sleeper.check();
  check('a hot-reload socket through the sidecar is not use', sleeper.isAsleep);

  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
  await sleeper.close();
  rmSync(repoDir, { recursive: true, force: true });
}

// ── a restart comes back asleep ─────────────────────────────────────────────
{
  // Railway's serverless stops an idle container and starts it again for any
  // request: a forgotten tab's hot-reload socket must not start the dev servers.
  const cli = join(modDir, 'cli.mjs');
  await esbuild.build({
    entryPoints: [join(pkgRoot, 'src', 'cli.ts')],
    bundle: true, platform: 'node', format: 'esm', target: 'node20',
    packages: 'bundle', outfile: cli, logLevel: 'silent',
  });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const app = mkdtempSync(join(tmpdir(), 'tapthat-boot-'));
  const devPort = await freePort();
  const sidecarPort = await freePort();
  writeFileSync(join(app, 'dev.js'),
    `require('fs').writeFileSync('started', 'yes');\n` +
    `require('http').createServer((q, r) => { console.log(q.method + ' ' + q.url + ' 200 in 1ms'); r.end('dev'); }).listen(${devPort});\n`);
  writeFileSync(join(app, '.gitignore'), 'started\n.tapthat/\n');
  writeFileSync(join(app, 'tapthat.config.json'), JSON.stringify({
    branch: 'dev', host: '127.0.0.1', port: sidecarPort, devServerUrl: `http://localhost:${devPort}`,
    devServer: { start: true, command: 'node dev.js', sleepAfterMinutes: 30 },
  }));
  git(app, 'init', '-q', '-b', 'dev');
  git(app, 'config', 'user.email', 't@e.com');
  git(app, 'config', 'user.name', 'T');
  git(app, 'add', '-A'); git(app, 'commit', '-q', '-m', 'init');
  mkdirSync(join(app, '.tapthat'));
  writeFileSync(join(app, '.tapthat', 'state.json'), JSON.stringify({ version: 1, batches: {}, credentials: {}, asleep: true }));

  const env = { ...process.env, TAPTHAT_ENABLE: '1', TAPTHAT_TOKEN: 'test-token-abcdefghijklmnop', NODE_ENV: 'development' };
  for (const k of Object.keys(env)) if (k.startsWith('RAILWAY_')) delete env[k];
  const serve = spawn('node', [cli, 'serve'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  serve.stdout.on('data', (c) => { log += c; });
  serve.stderr.on('data', (c) => { log += c; });
  const sidecar = `http://127.0.0.1:${sidecarPort}/__tapthat`;
  const until = async (fn, ms = 20_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
      try { if (await fn()) return true; } catch {}
    }
    return false;
  };
  await until(async () => (await fetch(`${sidecar}/healthz`)).ok);
  const health = await (await fetch(`${sidecar}/healthz`)).json().catch(() => null);
  check('booting asleep, the sidecar says so', health?.sleep?.asleep === true, log);
  check('and does not start the dev server', !existsSync(join(app, 'started')));
  const page = await fetch(`http://localhost:${devPort}/`, { headers: { accept: 'text/html' } });
  check("and holds the dev server's port with the asleep page", page.status === 503 && page.headers.get('x-tapthat-asleep') === '1');

  await fetch(`${sidecar}/wake`, { method: 'POST' });
  const up = await until(async () => (await (await fetch(`http://localhost:${devPort}/`)).text()) === 'dev');
  check('Wake starts it', up && existsSync(join(app, 'started')), log);
  await until(async () => JSON.parse(readFileSync(join(app, '.tapthat', 'state.json'), 'utf8')).asleep === false, 3000);
  check('and the state says awake for the next restart',
    JSON.parse(readFileSync(join(app, '.tapthat', 'state.json'), 'utf8')).asleep === false);

  serve.kill('SIGTERM');
  await new Promise((r) => serve.once('exit', r));
  rmSync(app, { recursive: true, force: true });
}

rmSync(modDir, { recursive: true, force: true });

console.log(failed === 0 ? `PASS — ${total} sleep checks` : `FAIL — ${failed} of ${total} sleep checks`);
process.exit(failed === 0 ? 0 : 1);
