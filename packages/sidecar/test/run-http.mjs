/**
 * HTTP surface checks: auth, origin gating, idempotency, rate limiting and the
 * proxy.
 *
 * The endpoint accepts instructions that modify a repository, and on a PaaS it
 * is reachable from the open internet, so the gates around it are the difference
 * between a dev tool and a public repo-write primitive.
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
const { createHttpServer, Store, Repo, defaults, deriveKey, Queue } = await import(modPath);

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tapthat-http-'));
  git(dir, 'init', '-q', '-b', 'dev');
  git(dir, 'config', 'user.email', 't@e.com');
  git(dir, 'config', 'user.name', 'T');
  writeFileSync(join(dir, 'app.js'), 'export const x = 1;\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

let failed = 0;
let total = 0;
function check(label, ok, detail) {
  total++;
  if (!ok) { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}

const TOKEN = 'test-token-abcdefghijklmnop';
const ORIGIN = 'http://localhost:5173';

const repoDir = makeRepo();
const store = await Store.open(join(mkdtempSync(join(tmpdir(), 'st-')), 'state.json'));
const config = {
  ...defaults(repoDir),
  repoRoot: repoDir, branch: 'dev', allowedOrigins: [ORIGIN],
  devServerUrl: 'http://127.0.0.1:1',   // deliberately unreachable
  limits: { batchesPerHour: 2 },
};
const server = createHttpServer({
  config, repo: new Repo(repoDir), store,
  encryptionKey: deriveKey('test-key'), token: TOKEN,
  envCredential: { raw: 'sk-ant-test-0000', kind: 'api_key' }, version: '0.0.0',
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const call = (path, opts = {}) => fetch(`${base}${path}`, {
  ...opts,
  headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
});
const auth = (extra = {}) => ({ authorization: `Bearer ${TOKEN}`, origin: ORIGIN, ...extra });

const comment = {
  id: 'c1', n: 1, comment: 'smaller', createdAt: '2025-01-01T00:00:00.000Z',
  selector: 'h1', domPath: 'body > h1', tagName: 'h1', attributes: {}, text: 'Hi',
  html: '<h1>Hi</h1>', ancestors: [], landmark: null, nearestHeading: null,
  siblingIndex: 1, siblingCount: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, styles: {},
};
const body = (id, url = `${ORIGIN}/`) => JSON.stringify({
  batchId: id, credentialHandle: null,
  page: { url, title: 'T', viewport: { w: 1, h: 1 }, capturedAt: '2025-01-01T00:00:00.000Z' },
  comments: [comment],
});

// ── /healthz is unauthenticated and matches the documented shape ─────────────
{
  const res = await call('/healthz');
  const json = await res.json();
  check('healthz needs no auth', res.status === 200);
  check('healthz reports repo branch and head', json.repo?.branch === 'dev' && !!json.repo?.head);
  check('healthz reports queue state', typeof json.queue?.depth === 'number');
  check('healthz reports dev server reachability', json.devServer?.reachable === false);
}

// ── Auth ─────────────────────────────────────────────────────────────────────
{
  check('missing token is rejected', (await call('/api/batches', { method: 'POST', body: body('x') })).status === 401);
  check('wrong token is rejected',
    (await call('/api/batches', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: body('x') })).status === 401);
  check('credentials endpoint needs auth',
    (await call('/api/credentials', { method: 'POST', body: '{"credential":"sk-ant-x"}' })).status === 401);
}

// ── Origin gating: a second, independent gate ────────────────────────────────
{
  const res = await call('/api/batches', {
    method: 'POST', headers: auth({ origin: 'https://evil.example' }), body: body('b-origin'),
  });
  check('foreign Origin is rejected even with a valid token', res.status === 403);

  const pre = await call('/api/batches', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  check('preflight from a foreign origin is refused', pre.status === 403);

  const ok = await call('/api/batches', { method: 'OPTIONS', headers: { origin: ORIGIN } });
  check('preflight from an allowed origin succeeds', ok.status === 204);
  check('preflight echoes only the exact origin', ok.headers.get('access-control-allow-origin') === ORIGIN);
}

// ── A page outside the allowlist cannot be the source of comments ────────────
{
  const res = await call('/api/batches', {
    method: 'POST', headers: auth(), body: body('b-page', 'https://evil.example/x'),
  });
  const json = await res.json();
  check('comments captured off-allowlist are refused', res.status === 403 && json.error === 'page_not_allowed');
}

// ── Idempotency ──────────────────────────────────────────────────────────────
{
  const first = await call('/api/batches', { method: 'POST', headers: auth(), body: body('b-dup') });
  check('a valid batch is accepted', first.status === 202, `got ${first.status}`);
  const accepted = await first.json();
  check('acceptance returns an events token', typeof accepted.eventsToken === 'string');
  check('acceptance reports the base sha', typeof accepted.baseSha === 'string');

  const replay = await call('/api/batches', { method: 'POST', headers: auth(), body: body('b-dup') });
  const dup = await replay.json();
  check('replaying a batchId returns 409 rather than running twice',
    replay.status === 409 && dup.error === 'duplicate');
}

// ── The events token must not leak through the status endpoint ───────────────
{
  const res = await call('/api/batches/b-dup', { headers: auth() });
  const json = await res.json();
  check('status endpoint works', res.status === 200);
  check('status does not leak the events token', json.eventsToken === undefined);
  check('unknown batch is 404', (await call('/api/batches/nope', { headers: auth() })).status === 404);
}

// ── Credentials: stored sealed, only a fingerprint comes back ────────────────
{
  const res = await call('/api/credentials', {
    method: 'POST', headers: auth(), body: JSON.stringify({ credential: 'sk-ant-secret-value-1234' }),
  });
  const json = await res.json();
  check('credential is accepted', res.status === 200, JSON.stringify(json));
  check('only a fingerprint is returned', json.fingerprint === '1234');
  check('the raw credential never comes back', !JSON.stringify(json).includes('secret-value'));
  check('kind is detected by prefix', json.kind === 'api_key');

  const bad = await call('/api/credentials', {
    method: 'POST', headers: auth(), body: JSON.stringify({ credential: 'not-a-key' }),
  });
  check('an unrecognised credential is rejected', bad.status === 400);

  const oauth = await call('/api/credentials', {
    method: 'POST', headers: auth(), body: JSON.stringify({ credential: 'sk-ant-oat01-abcdefgh' }),
  });
  check('oauth tokens are detected by prefix', (await oauth.json()).kind === 'oauth_token');
}

// ── Rate limit ───────────────────────────────────────────────────────────────
{
  await call('/api/batches', { method: 'POST', headers: auth(), body: body('b-rate-1') });
  const res = await call('/api/batches', { method: 'POST', headers: auth(), body: body('b-rate-2') });
  check('rate limit returns 429 once the hourly cap is hit', res.status === 429, `got ${res.status}`);
}

server.close();

// ── Proxy mode: one port serves both the API and the dev server ──────────────
{
  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html>dev server: ${req.url}</html>`);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  const store2 = await Store.open(join(mkdtempSync(join(tmpdir(), 'st2-')), 'state.json'));
  const proxied = createHttpServer({
    config: { ...config, proxy: { enabled: true, target: upstreamUrl }, devServerUrl: upstreamUrl },
    repo: new Repo(repoDir), store: store2, encryptionKey: deriveKey('k'), token: TOKEN,
    envCredential: null, version: '0.0.0',
  });
  await new Promise((r) => proxied.listen(0, '127.0.0.1', r));
  const pbase = `http://127.0.0.1:${proxied.address().port}`;

  const page = await fetch(`${pbase}/some/route`);
  check('proxy forwards page requests to the dev server',
    (await page.text()).includes('dev server: /some/route'));
  const health = await fetch(`${pbase}/healthz`);
  check('the sidecar still owns /healthz on the same port',
    health.status === 200 && (await health.json()).repo.branch === 'dev');

  proxied.close(); upstream.close();
}

// ── The queue serializes per branch ──────────────────────────────────────────
{
  const q = new Queue();
  const order = [];
  let releaseFirst;
  const first = q.run('dev', async () => {
    order.push('first-start');
    await new Promise((r) => { releaseFirst = r; });
    order.push('first-end');
  });
  const second = q.run('dev', async () => { order.push('second-start'); });
  await new Promise((r) => setTimeout(r, 20));
  check('a second job does not start while the first runs', !order.includes('second-start'));
  releaseFirst();
  await Promise.all([first, second]);
  check('the second job runs after the first finishes',
    order.join(',') === 'first-start,first-end,second-start', order.join(','));
}

rmSync(repoDir, { recursive: true, force: true });
rmSync(modDir, { recursive: true, force: true });

console.log(failed === 0 ? `PASS — ${total} sidecar HTTP checks` : `FAIL — ${failed} of ${total} sidecar HTTP checks`);
process.exit(failed === 0 ? 0 : 1);
