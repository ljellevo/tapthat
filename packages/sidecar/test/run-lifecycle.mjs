/**
 * The whole batch lifecycle over HTTP, with a fake agent standing in for the
 * Claude CLI: accept → queue → run → commit → push, watched over SSE, then undo.
 * Plus the Phase 6-7 pieces that only make sense end to end: clone-on-boot,
 * envelope encryption, per-credential limits, the audit log, `init` and
 * `audit-prod`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const fakeAgent = join(here, 'fake-agent.mjs');

const bundle = await esbuild.build({
  entryPoints: [join(pkgRoot, 'src', 'testing.ts')],
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  packages: 'bundle', write: false,
});
const modDir = mkdtempSync(join(tmpdir(), 'tapthat-mod-'));
const modPath = join(modDir, 'mod.mjs');
writeFileSync(modPath, bundle.outputFiles[0].text);
const {
  createHttpServer, Store, Repo, defaults, deriveKey, createAudit, seal, unseal,
} = await import(modPath);

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const scratch = mkdtempSync(join(tmpdir(), 'tapthat-life-'));

let failed = 0;
let total = 0;
function check(label, ok, detail) {
  total++;
  if (!ok) { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}

/** A bare remote plus a clone of it on `dev`, the shape a hosted sidecar works with. */
function makeRemoteAndClone(name) {
  const bare = join(scratch, `${name}.git`);
  git(scratch, 'init', '-q', '--bare', '-b', 'dev', bare);
  const seed = join(scratch, `${name}-seed`);
  git(scratch, 'init', '-q', '-b', 'dev', seed);
  git(seed, 'config', 'user.email', 't@e.com');
  git(seed, 'config', 'user.name', 'T');
  writeFileSync(join(seed, 'app.js'), 'export const x = 1;\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '-q', 'origin', 'dev');
  const work = join(scratch, `${name}-work`);
  git(scratch, 'clone', '-q', '--branch', 'dev', bare, work);
  return { bare, seed, work };
}

/** Minimal SSE reader over fetch: collects frames until the stream closes. */
async function readSse(url, headers = {}) {
  const res = await fetch(url, { headers });
  const frames = [];
  if (!res.ok) return { status: res.status, frames };
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (raw.startsWith(':')) continue;
      const frame = { event: 'message', id: null, data: '' };
      for (const line of raw.split('\n')) {
        const [k, ...v] = line.split(': ');
        if (k === 'event') frame.event = v.join(': ');
        else if (k === 'id') frame.id = Number(v.join(': '));
        else if (k === 'data') frame.data += v.join(': ');
      }
      frames.push({ ...frame, data: JSON.parse(frame.data) });
    }
  }
  return { status: res.status, frames };
}

const TOKEN = 'lifecycle-token-abcdefgh';
const ORIGIN = 'http://localhost:5173';
const comment = {
  id: 'c1', n: 1, comment: 'x should be 2', createdAt: '2025-01-01T00:00:00.000Z',
  selector: 'h1', domPath: 'body > h1', tagName: 'h1', attributes: {}, text: 'Hi',
  html: '<h1>Hi</h1>', ancestors: [], landmark: null, nearestHeading: null,
  siblingIndex: 1, siblingCount: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, styles: {},
};
const batchBody = (id, credentialHandle = null) => JSON.stringify({
  batchId: id, credentialHandle,
  page: { url: `${ORIGIN}/`, title: 'T', viewport: { w: 1, h: 1 }, capturedAt: '2025-01-01T00:00:00.000Z' },
  comments: [comment],
});

async function startServer(work, overrides = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'st-'));
  const store = await Store.open(join(stateDir, 'state.json'));
  const auditPath = join(stateDir, 'audit.log');
  const base = defaults(work);
  const config = {
    ...base,
    repoRoot: work, branch: 'dev', allowedOrigins: [ORIGIN], devServerUrl: 'http://127.0.0.1:1',
    agent: { ...base.agent, command: 'node', args: [fakeAgent] },
    git: { ...base.git, push: true, author: { name: 'TapThat', email: 'tapthat@localhost' } },
    ...overrides,
  };
  const server = createHttpServer({
    config, repo: new Repo(work), store, encryptionKey: deriveKey('lifecycle-key'), token: TOKEN,
    envCredential: { raw: 'sk-ant-env-credential-0000', kind: 'api_key' }, version: '0.0.0',
    agentVersion: '0.0.0 (fake agent)', audit: createAudit(auditPath, { mirror: false }),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (path, opts = {}) => fetch(`${url}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, origin: ORIGIN, ...(opts.headers ?? {}) },
  });
  return { server, url, call, store, auditPath };
}

// ── Submit → SSE → commit → push ─────────────────────────────────────────────
{
  const { bare, work } = makeRemoteAndClone('happy');
  // A container has no git identity. Commits and reverts must not depend on one
  // (this is how an undo that only failed in Docker was found).
  const savedGit = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
  // useConfigOnly: refuse to invent an identity from the hostname, as git does
  // in a container whose hostname has no domain.
  const noIdentity = join(scratch, 'no-identity.gitconfig');
  writeFileSync(noIdentity, '[user]\n\tuseConfigOnly = true\n');
  process.env.GIT_CONFIG_GLOBAL = noIdentity;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.FAKE_AGENT_EDIT = 'app.js::1::2';
  const { server, url, call, auditPath } = await startServer(work);

  const health = await (await fetch(`${url}/healthz`)).json();
  check('healthz reports the agent CLI version', health.agent?.cliVersion === '0.0.0 (fake agent)');
  check('healthz says a fallback credential exists', health.agent?.envCredential === true);

  const accepted = await (await call('/api/batches', { method: 'POST', body: batchBody('b-happy') })).json();
  check('batch accepted with an events token', typeof accepted.eventsToken === 'string', JSON.stringify(accepted));

  const noToken = await fetch(`${url}/api/batches/b-happy/events`);
  check('SSE without the events token is refused', noToken.status === 401);
  const foreign = await fetch(`${url}/api/batches/b-happy/events?t=${accepted.eventsToken}`, { headers: { origin: 'https://evil.example' } });
  check('SSE from a foreign origin is refused', foreign.status === 403);

  const { frames } = await readSse(`${url}/api/batches/b-happy/events?t=${accepted.eventsToken}`, { origin: ORIGIN });
  const types = frames.filter((f) => f.event === 'message').map((f) => f.data.type);
  const done = frames.find((f) => f.event === 'done');
  check('SSE streams the lifecycle in order',
    ['accepted', 'queued', 'started', 'prompt-rendered', 'files-changed', 'committed', 'pushed']
      .every((t, i, all) => types.indexOf(t) >= 0 && (i === 0 || types.indexOf(t) > types.indexOf(all[i - 1]))),
    types.join(' → '));
  check('agent messages are streamed', types.includes('agent-message'));
  check('SSE ends with a done event carrying the final status',
    done?.data.state === 'committed' && done.data.result.filesChanged.includes('app.js'), JSON.stringify(done?.data));
  check('SSE ids are the event seqs',
    frames.filter((f) => f.event === 'message').every((f) => f.id === f.data.seq));
  check('the done payload does not leak the events token', !JSON.stringify(done?.data ?? {}).includes('ev_'));

  const pushedHead = git(bare, 'rev-parse', '--short', 'dev');
  check('the commit was pushed to the remote', pushedHead === done?.data.result.sha, `${pushedHead} vs ${done?.data.result.sha}`);
  check('the working tree holds the edit', readFileSync(join(work, 'app.js'), 'utf8').includes('x = 2'));

  // Resume: a reconnect with Last-Event-ID replays only what was missed.
  const resumeFrom = frames.find((f) => f.data.type === 'files-changed').id;
  const resumed = await readSse(`${url}/api/batches/b-happy/events?t=${accepted.eventsToken}`, { 'last-event-id': String(resumeFrom) });
  const replayed = resumed.frames.filter((f) => f.event === 'message');
  check('Last-Event-ID resumes after the given seq',
    replayed.length > 0 && replayed.every((f) => f.id > resumeFrom), replayed.map((f) => f.id).join(','));
  check('a finished batch still ends its stream with done', resumed.frames.at(-1)?.event === 'done');

  // Undo: a revert commit, pushed, and the batch marked reverted.
  const undo = await call('/api/batches/b-happy/revert', { method: 'POST' });
  const undone = await undo.json();
  check('undo returns the revert sha', undo.status === 202 && !!undone.revertSha, JSON.stringify(undone));
  check('undo restores the file', readFileSync(join(work, 'app.js'), 'utf8').includes('x = 1'));
  check('the revert was pushed too', git(bare, 'rev-parse', '--short', 'dev') === undone.revertSha);
  const status = await (await call('/api/batches/b-happy')).json();
  check('status is reverted with a reverted event', status.state === 'reverted' && status.events.at(-1).type === 'reverted');
  const again = await call('/api/batches/b-happy/revert', { method: 'POST' });
  check('a second undo is refused', again.status === 409);
  if (savedGit.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGit.g;
  if (savedGit.s === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = savedGit.s;

  server.close();
  await new Promise((r) => setTimeout(r, 100));
  const audit = readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('the audit log records accept, finish and revert',
    ['batch.accepted', 'batch.finished', 'batch.reverted'].every((e) => audit.some((a) => a.event === e)),
    audit.map((a) => a.event).join(','));
  check('the audit log never contains a credential', !readFileSync(auditPath, 'utf8').includes('sk-ant-'));
}

// ── A failing run ends failed, with the agent's text, and the tree untouched ──
{
  const { work } = makeRemoteAndClone('fail');
  process.env.FAKE_AGENT_FAIL = '1';
  const { server, url, call } = await startServer(work);
  const accepted = await (await call('/api/batches', { method: 'POST', body: batchBody('b-fail') })).json();
  const { frames } = await readSse(`${url}/api/batches/b-fail/events?t=${accepted.eventsToken}`);
  const done = frames.find((f) => f.event === 'done');
  check('a failing agent ends the batch failed', done?.data.state === 'failed');
  check("the agent's own error text reaches the client verbatim",
    done?.data.error?.message.includes('could not find the element'), JSON.stringify(done?.data.error));
  check('a failed run leaves the tree clean', git(work, 'status', '--porcelain') === '');
  const undo = await call('/api/batches/b-fail/revert', { method: 'POST' });
  check('undo of a batch with no commit is refused readably', undo.status === 409);
  delete process.env.FAKE_AGENT_FAIL;
  server.close();
}

// ── Per-credential rate limit ────────────────────────────────────────────────
{
  const { work } = makeRemoteAndClone('rate');
  const base = defaults(work);
  const { server, call } = await startServer(work, {
    limits: { batchesPerHour: 100, batchesPerHourPerCredential: 1 },
    git: { ...base.git, enabled: false },
  });
  const cred = await (await call('/api/credentials', {
    method: 'POST', body: JSON.stringify({ credential: 'sk-ant-user-one-credential-1111' }),
  })).json();
  const first = await call('/api/batches', { method: 'POST', body: batchBody('r1', cred.handle) });
  const second = await call('/api/batches', { method: 'POST', body: batchBody('r2', cred.handle) });
  const other = await call('/api/batches', { method: 'POST', body: batchBody('r3') });
  check('first batch for a credential is accepted', first.status === 202);
  check('the per-credential cap stops that credential', second.status === 429);
  check('another credential is unaffected', other.status === 202, `got ${other.status}`);

  const bogus = await call('/api/batches', { method: 'POST', body: batchBody('r4', 'cred_nope') });
  const bogusBody = await bogus.json();
  check('an unknown credential handle says to paste the key again',
    bogus.status === 401 && bogusBody.error === 'credential_invalid', JSON.stringify(bogusBody));
  await new Promise((r) => setTimeout(r, 300));
  server.close();
}

// ── Envelope encryption ──────────────────────────────────────────────────────
{
  const key = deriveKey('master');
  const a = seal('sk-ant-secret-aaaa', key);
  const b = seal('sk-ant-secret-aaaa', key);
  check('sealed credentials use the envelope format', a.startsWith('v2.'));
  check('the same secret seals differently each time (own data key)', a !== b);
  check('envelope round-trips', unseal(a, key) === 'sk-ant-secret-aaaa');
  let wrongKeyFailed = false;
  try { unseal(a, deriveKey('other')); } catch { wrongKeyFailed = true; }
  check('a different master key cannot open it', wrongKeyFailed);
}

// ── Clone-on-boot helpers: clone, then fast-forward only when clean ──────────
{
  const { bare, seed } = makeRemoteAndClone('clone');
  const dest = join(scratch, 'cloned');
  const repo = await Repo.clone(bare, 'dev', dest, null);
  check('clone produces a worktree on the branch', (await repo.branch()) === 'dev');

  writeFileSync(join(seed, 'app.js'), 'export const x = 3;\n');
  git(seed, 'commit', '-qam', 'upstream'); git(seed, 'push', '-q', 'origin', 'dev');
  check('a clean checkout fast-forwards', (await repo.fastForward('origin', 'dev')) === null
    && readFileSync(join(dest, 'app.js'), 'utf8').includes('x = 3'));

  writeFileSync(join(dest, 'app.js'), 'export const x = 99;\n');
  const skipped = await repo.fastForward('origin', 'dev');
  check('a dirty checkout is left alone, never reset',
    typeof skipped === 'string' && readFileSync(join(dest, 'app.js'), 'utf8').includes('x = 99'), skipped);
}

// ── CLI: init and audit-prod ─────────────────────────────────────────────────
{
  // Bundled from src like the modules above, not read from dist/: CI starts from
  // a clean checkout where nothing has been built yet, and a stale dist/ would
  // test yesterday's code.
  const cli = join(modDir, 'cli.mjs');
  await esbuild.build({
    entryPoints: [join(pkgRoot, 'src', 'cli.ts')],
    bundle: true, platform: 'node', format: 'esm', target: 'node20',
    packages: 'bundle', outfile: cli, logLevel: 'silent',
  });
  {
    const app = join(scratch, 'init-app');
    mkdirSync(app);
    git(app, 'init', '-q', '-b', 'dev');
    writeFileSync(join(app, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev', typecheck: 'tsc' } }));
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('RAILWAY_') || k.startsWith('TAPTHAT_')) delete env[k];
    const run = (args, cwd) => spawnSync('node', [cli, ...args], { cwd, env, encoding: 'utf8' });

    const init = run(['init'], app);
    const config = JSON.parse(readFileSync(join(app, 'tapthat.config.json'), 'utf8'));
    const secrets = readFileSync(join(app, '.tapthat', 'secrets.env'), 'utf8');
    check('init exits 0', init.status === 0, init.stderr);
    check('init targets the checked-out branch and guesses the Next port',
      config.branch === 'dev' && config.devServerUrl === 'http://localhost:3000', JSON.stringify(config));
    check('init picks up a typecheck script as the verify command', config.verifyCommand === 'npm run typecheck');
    check('init generates a token and an encryption key',
      /TAPTHAT_TOKEN=\S{20,}/.test(secrets) && /TAPTHAT_ENCRYPTION_KEY=\S{40,}/.test(secrets));
    check('init never writes the safety latch', !secrets.includes('TAPTHAT_ENABLE'));
    check('init gitignores .tapthat/', readFileSync(join(app, '.gitignore'), 'utf8').includes('.tapthat/'));
    const token = /TAPTHAT_TOKEN=(\S+)/.exec(secrets)[1];
    check('init prints the token to paste', init.stdout.includes(token));
    const rerun = run(['init'], app);
    check('init is idempotent and keeps existing secrets',
      rerun.status === 0 && readFileSync(join(app, '.tapthat', 'secrets.env'), 'utf8') === secrets);

    const guarded = run(['serve'], app);
    check('serve still refuses without TAPTHAT_ENABLE, even with secrets on disk', guarded.status === 78);

    writeFileSync(join(app, 'package.json'), JSON.stringify({ devDependencies: { '@tapthat/sidecar': '^0.1.0' } }));
    writeFileSync(join(app, 'docker-compose.dev.yml'), 'services:\n  tapthat:\n    image: ghcr.io/x/tapthat-sidecar\n');
    check('audit-prod passes for a devDependency in a dev compose file', run(['audit-prod'], app).status === 0);
    writeFileSync(join(app, 'Dockerfile'), 'RUN npx tapthat-sidecar\n');
    const bad = run(['audit-prod'], app);
    check('audit-prod fails when a production Dockerfile names the sidecar',
      bad.status === 1 && bad.stderr.includes('Dockerfile'), bad.stderr);
    rmSync(join(app, 'Dockerfile'));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { '@tapthat/sidecar': '^0.1.0' } }));
    check('audit-prod fails for a production dependency', run(['audit-prod'], app).status === 1);
  }
}

delete process.env.FAKE_AGENT_EDIT;
rmSync(scratch, { recursive: true, force: true });
rmSync(modDir, { recursive: true, force: true });

console.log(failed === 0 ? `PASS — ${total} sidecar lifecycle checks` : `FAIL — ${failed} of ${total} sidecar lifecycle checks`);
process.exit(failed === 0 ? 0 : 1);
