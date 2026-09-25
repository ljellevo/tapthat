/**
 * The extension's sidecar client against a real sidecar — the actual HTTP
 * server from packages/sidecar, driving a fake agent that edits a real git repo.
 * Shared protocol types catch shape drift at compile time; this catches the
 * rest (status codes, SSE framing, CORS, resume) at runtime.
 *
 * Run with --experimental-eventsource so the SSE path is exercised; the polling
 * fallback is tested either way.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const sidecarRoot = resolve(here, '..', '..', 'sidecar');

const load = async (entry, name) => {
  const out = await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false, packages: 'bundle' });
  const path = join(mkdtempSync(join(tmpdir(), `tt-${name}-`)), 'mod.mjs');
  writeFileSync(path, out.outputFiles[0].text);
  return import(path);
};
const { createClient, SidecarError } = await load(resolve(here, '..', 'src', 'sidecar', 'client.ts'), 'client');
const { track, applyEvent, applyStatus, phaseOf } = await load(resolve(here, '..', 'src', 'sidecar', 'tracked.ts'), 'tracked');
const { createHttpServer, Store, Repo, defaults, deriveKey } = await load(join(sidecarRoot, 'src', 'testing.ts'), 'sidecar');

let failed = 0;
let total = 0;
function check(label, ok, detail) {
  total++;
  if (!ok) { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const repoDir = mkdtempSync(join(tmpdir(), 'tt-client-repo-'));
git(repoDir, 'init', '-q', '-b', 'dev');
git(repoDir, 'config', 'user.email', 't@e.com');
git(repoDir, 'config', 'user.name', 'T');
writeFileSync(join(repoDir, 'Hero.tsx'), 'export const title = "Welcome";\n');
git(repoDir, 'add', '-A'); git(repoDir, 'commit', '-q', '-m', 'init');

const TOKEN = 'client-test-token-123456';
const SITE = 'http://localhost:5173';
const base = defaults(repoDir);
const server = createHttpServer({
  config: {
    ...base, repoRoot: repoDir, branch: 'dev', allowedOrigins: [SITE], devServerUrl: 'http://127.0.0.1:1',
    agent: { ...base.agent, command: 'node', args: [join(sidecarRoot, 'test', 'fake-agent.mjs')] },
  },
  repo: new Repo(repoDir),
  store: await Store.open(join(mkdtempSync(join(tmpdir(), 'tt-st-')), 'state.json')),
  encryptionKey: deriveKey('k'), token: TOKEN, envCredential: null, version: '0.0.0', agentVersion: 'fake',
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

// The content script's fetches carry the page's Origin; model that.
const pageFetch = (input, init = {}) => fetch(input, { ...init, headers: { ...(init.headers ?? {}), origin: SITE } });
const client = createClient({ baseUrl: `${url}/`, token: TOKEN, fetch: pageFetch });

const comment = {
  id: 'c1', n: 1, comment: 'Say hello instead', createdAt: new Date().toISOString(),
  selector: 'h1', domPath: 'body > h1', tagName: 'h1', attributes: {}, text: 'Welcome',
  html: '<h1>Welcome</h1>', ancestors: [], landmark: null, nearestHeading: null,
  siblingIndex: 1, siblingCount: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, styles: {},
};
const request = (batchId, credentialHandle) => ({
  batchId, credentialHandle,
  page: { url: `${SITE}/`, title: 'T', viewport: { w: 1, h: 1 }, capturedAt: new Date().toISOString() },
  comments: [comment], client: { name: 'test', version: '0' },
});

// ── health, errors ───────────────────────────────────────────────────────────
{
  const health = await client.health();
  check('health round-trips', health.repo.branch === 'dev' && health.agent.envCredential === false);
  const info = await client.info();
  check('config lists the allowed sites', info.allowedOrigins.includes(SITE));

  const wrong = createClient({ baseUrl: url, token: 'nope', fetch: pageFetch });
  const err = await wrong.submit(request('x', null)).catch((e) => e);
  check('a bad token surfaces as SidecarError unauthorized', err instanceof SidecarError && err.code === 'unauthorized');

  const nothing = createClient({ baseUrl: 'http://127.0.0.1:1', token: TOKEN });
  const net = await nothing.health().catch((e) => e);
  check('an unreachable sidecar is a network error, not a crash', net instanceof SidecarError && net.code === 'network');

  const noCred = await client.submit(request('no-cred', null)).catch((e) => e);
  check('no credential anywhere → no_credential', noCred.code === 'no_credential', noCred.message);
}

const cred = await client.saveCredential('sk-ant-client-test-credential-9999');
check('credential save returns only a fingerprint and handle', cred.fingerprint === '9999' && !JSON.stringify(cred).includes('client-test'));

async function runBatch(batchId, find, replace, clientOpts) {
  process.env.FAKE_AGENT_EDIT = `Hero.tsx::${find}::${replace}`;
  const c = createClient({ baseUrl: url, token: TOKEN, fetch: pageFetch, ...clientOpts });
  const accepted = await c.submit(request(batchId, cred.handle));
  let tracked = track(accepted, ['c1']);
  const phases = [phaseOf(tracked)];
  const done = await new Promise((resolveDone) => {
    c.watch(batchId, accepted.eventsToken, {
      onEvent: (e) => { tracked = applyEvent(tracked, e); phases.push(phaseOf(tracked)); },
      onDone: (status) => resolveDone(status),
    }, { pollMs: 50 });
  });
  tracked = applyStatus(tracked, done);
  return { tracked, done, phases: [...new Set(phases)] };
}

// ── SSE path ─────────────────────────────────────────────────────────────────
if (typeof EventSource === 'function') {
  // Node's EventSource sends no Origin; the sidecar accepts that (it is the token that gates SSE).
  const { tracked, phases } = await runBatch('sse-1', 'Welcome', 'Hello', {});
  check('SSE: the batch ends committed', tracked.state === 'committed', JSON.stringify(tracked.error));
  check('SSE: phases progress queued → editing → live → committed',
    ['queued', 'editing', 'live', 'committed'].every((p) => phases.includes(p)), phases.join(' → '));
  check('SSE: files and sha are tracked', tracked.filesChanged.includes('Hero.tsx') && !!tracked.sha);
  check('SSE: the edit is on disk', readFileSync(join(repoDir, 'Hero.tsx'), 'utf8').includes('Hello'));

  const undo = await client.revert('sse-1');
  check('undo through the client', !!undo.revertSha && readFileSync(join(repoDir, 'Hero.tsx'), 'utf8').includes('Welcome'));
  const again = await client.revert('sse-1').catch((e) => e);
  check('a second undo is a readable 409', again instanceof SidecarError && again.status === 409, again.message);
} else {
  console.log('  (EventSource unavailable — run with --experimental-eventsource for the SSE checks)');
}

// ── polling fallback ─────────────────────────────────────────────────────────
{
  const { tracked, phases } = await runBatch('poll-1', 'Welcome', 'Howdy', { EventSource: null });
  check('polling: the batch ends committed', tracked.state === 'committed', JSON.stringify(tracked.error));
  check('polling: reaches live and committed', phases.includes('committed'), phases.join(' → '));
}

// ── resume after a reload: afterSeq skips what was already seen ──────────────
{
  const status = await client.get('poll-1');
  const seen = [];
  await new Promise((resolveDone) => {
    client.watch('poll-1', null, { onEvent: (e) => seen.push(e.seq), onDone: resolveDone }, { afterSeq: 3 });
  });
  check('resume replays only events after the given seq',
    seen.length === status.events.length - 4 && seen.every((s) => s > 3), seen.join(','));
}

// ── a failing agent reaches the client verbatim ──────────────────────────────
{
  process.env.FAKE_AGENT_FAIL = '1';
  const { tracked } = await runBatch('fail-1', 'x', 'y', { EventSource: null });
  delete process.env.FAKE_AGENT_FAIL;
  check('failure: state and the agent\'s own words',
    tracked.state === 'failed' && tracked.error?.message.includes('could not find the element'), JSON.stringify(tracked.error));
}

server.close();
rmSync(repoDir, { recursive: true, force: true });
console.log(failed === 0 ? `PASS — ${total} client ↔ sidecar checks` : `FAIL — ${failed} of ${total} client ↔ sidecar checks`);
process.exit(failed === 0 ? 0 : 1);
