/**
 * The playground flow (git.mode "session"): Start session → batches collect on
 * a local session branch → Commit to dev squashes, replays onto the latest dev
 * and pushes in deploy order → the playground moves onto the new dev. Real repos
 * with real remotes, the real HTTP server, a fake agent.
 */
import { execFileSync } from 'node:child_process';
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
  bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'bundle', write: false,
});
const modDir = mkdtempSync(join(tmpdir(), 'tapthat-sess-mod-'));
writeFileSync(join(modDir, 'mod.mjs'), bundle.outputFiles[0].text);
const { createHttpServer, Store, loadConfig, Workspace, deriveKey } = await import(join(modDir, 'mod.mjs'));

let failed = 0;
let total = 0;
function check(label, ok, detail) {
  total++;
  if (!ok) { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}

const scratch = mkdtempSync(join(tmpdir(), 'tapthat-sess-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const read = (path) => readFileSync(path, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Two repos, each with a bare remote on `dev`, plus a developer's own clone ─
const root = join(scratch, 'repos');
const remotes = join(scratch, 'remotes');
const devs = join(scratch, 'developer');
for (const dir of [root, remotes, devs]) mkdirSync(dir, { recursive: true });
const initial = {
  api: { 'src/routes/deals.ts': "export const fields = ['id', 'name'];\n", 'shared/contracts/index.ts': 'export type Deal = { id: string };\n', 'README.md': 'api\n' },
  app: { 'src/app/deals/page.tsx': 'export default () => <h1>Deals</h1>;\n', 'shared/contracts/index.ts': 'export type Deal = { id: string };\n', 'README.md': 'app\n' },
};
for (const [name, files] of Object.entries(initial)) {
  const bare = join(remotes, `${name}.git`);
  git(remotes, 'init', '-q', '--bare', '-b', 'dev', bare);
  const seed = join(scratch, `seed-${name}`);
  git(scratch, 'init', '-q', '-b', 'dev', seed);
  for (const [p, t] of Object.entries(files)) write(join(seed, p), t);
  if (name === 'app') {
    write(join(seed, 'tapthat.config.json'), JSON.stringify({
      branch: 'dev',
      allowedOrigins: ['http://localhost:3000'],
      agent: { command: 'node', args: [fakeAgent] },
      git: { mode: 'session', deployOrder: ['api', 'app'] },
      repos: [
        { name: 'app', primary: true, description: 'the app', devServer: { url: 'http://localhost:3000' } },
        { name: 'api', description: 'the API', verifyCommand: 'node -e "process.exit(process.env.BREAK_API ? 1 : 0)"',
          url: join(remotes, 'api.git') },
      ],
      mirrors: [{ from: 'api:shared/contracts', to: ['app:shared/contracts'], alsoUsedBy: ['admin', 'homepage'] }],
    }, null, 2));
  }
  git(seed, '-c', 'user.email=s@e', '-c', 'user.name=Seed', 'add', '-A');
  git(seed, '-c', 'user.email=s@e', '-c', 'user.name=Seed', 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', bare, 'dev');
  git(root, 'clone', '-q', '--branch', 'dev', bare, join(root, name));
  git(devs, 'clone', '-q', '--branch', 'dev', bare, join(devs, name));
  for (const d of [join(devs, name)]) { git(d, 'config', 'user.email', 'dev@e.com'); git(d, 'config', 'user.name', 'Developer'); }
}
const app = join(root, 'app');
const api = join(root, 'api');
const remoteHead = (name) => git(join(remotes, `${name}.git`), 'rev-parse', 'dev');

// A container has no git identity; nothing here may depend on one.
const noIdentity = join(scratch, 'no-identity.gitconfig');
writeFileSync(noIdentity, '[user]\n\tuseConfigOnly = true\n');
process.env.GIT_CONFIG_GLOBAL = noIdentity;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const { config, problems } = await loadConfig(app, {});
check('session config loads', problems.length === 0 && config.git.mode === 'session', problems.join('; '));
const statePath = join(mkdtempSync(join(tmpdir(), 'sess-st-')), 'state.json');

async function boot() {
  const store = await Store.open(statePath);
  const server = createHttpServer({
    config: { ...config, devServerUrl: 'http://127.0.0.1:1' },
    repo: Workspace.fromConfig(config).primary.repo, workspace: Workspace.fromConfig(config), store,
    encryptionKey: deriveKey('k'), token: 'session-token-abcdefghij',
    envCredential: { raw: 'sk-ant-session-test-0000', kind: 'api_key' }, version: '0.0.0',
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', authorization: 'Bearer session-token-abcdefghij', origin: 'http://localhost:3000' },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { server, store, call };
}
let { server, store, call } = await boot();

let n = 0;
async function apply(edits, extraEnv = {}, reviewer = 'Ana') {
  const id = `b-${++n}`;
  const saved = {};
  for (const [k, v] of Object.entries({ FAKE_AGENT_EDIT: edits, ...extraEnv })) { saved[k] = process.env[k]; process.env[k] = v; }
  const posted = await call('/api/batches', 'POST', {
    batchId: id, credentialHandle: null, reviewer,
    page: { url: 'http://localhost:3000/deals', title: 'Deals', viewport: { w: 1, h: 1 }, capturedAt: 'x' },
    comments: [{ id: `c${n}`, n: 1, comment: `Comment number ${n}`, createdAt: 'x', selector: 'h1', domPath: 'h1', tagName: 'h1',
      attributes: {}, text: '', html: '', ancestors: [], landmark: null, nearestHeading: null, siblingIndex: 1, siblingCount: 1,
      rect: { x: 0, y: 0, w: 1, h: 1 }, styles: {} }],
  });
  let status = posted.body;
  if (posted.status === 202) {
    for (let i = 0; i < 100; i++) {
      status = (await call(`/api/batches/${id}`)).body;
      if (!['queued', 'running'].includes(status.state)) break;
      await sleep(40);
    }
  }
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return { posted: posted.status, ...status };
}
async function startSession(reviewer = 'Ana') {
  const res = await call('/api/session/start', 'POST', { reviewer });
  let s = res.body?.session;
  for (let i = 0; i < 100 && s?.state === 'starting'; i++) { await sleep(40); s = (await call('/api/session')).body.session; }
  return { status: res.status, session: s, body: res.body };
}
const branchOf = (dir) => git(dir, 'branch', '--show-current');

// ── No session: nothing can be applied ──────────────────────────────────────
{
  const res = await apply("api/src/routes/deals.ts::'id'::'uuid'");
  check('a batch without a session is refused with no_session', res.posted === 409 && res.error === 'no_session', JSON.stringify(res));
  const health = (await call('/healthz')).body;
  check('healthz reports session mode and no session', health.mode === 'session' && health.session === null);
}

// ── Start, collect, commit ──────────────────────────────────────────────────
const devBefore = { api: remoteHead('api'), app: remoteHead('app') };
{
  const { status, session } = await startSession();
  check('Start session answers 202 and becomes active', status === 202 && session?.state === 'active', JSON.stringify(session));
  check('the session records who started it and each repo\'s dev head',
    session.startedBy === 'Ana' && session.base.length === 2 && session.base.every((b) => b.sha === git(join(root, b.repo), 'rev-parse', 'dev')));
  check('both repos are on the session branch', branchOf(app) === session.branch && branchOf(api) === session.branch, session.branch);
  const again = await call('/api/session/start', 'POST', {});
  check('a second Start is refused while one is active', again.status === 409 && again.body.error === 'session_active');

  const one = await apply("api/src/routes/deals.ts::'name'::'name', 'stage';;app/src/app/deals/page.tsx::Deals</h1>::Deals</h1><p>stage</p>", {}, 'Ana');
  check('a batch in the session commits locally', one.state === 'committed' && one.result.commits.length === 2, JSON.stringify(one.error));
  check('nothing reaches dev per batch', remoteHead('api') === devBefore.api && remoteHead('app') === devBefore.app);
  const two = await apply('app/README.md::app::the app', {}, 'Ben');
  check('a second batch lands', two.state === 'committed');
  const undo = await call(`/api/batches/${two.batchId}/revert`, 'POST');
  check('a batch can still be undone inside the session', undo.status === 202);

  const s = (await call('/api/session')).body.session;
  check('pending lists committed batches only, with reviewer and comment',
    s.pending.length === 1 && s.pending[0].reviewer === 'Ana' && s.pending[0].comments[0] === 'Comment number 2', JSON.stringify(s.pending));
  check('per-repo files show what Commit will send',
    JSON.stringify(s.repos) === JSON.stringify([
      { name: 'app', files: ['src/app/deals/page.tsx'] },
      { name: 'api', files: ['src/routes/deals.ts'] },
    ]), JSON.stringify(s.repos));
  check('healthz counts pending changes', (await call('/healthz')).body.session?.pending === 1);

  const commit = await call('/api/session/commit', 'POST', { reviewer: 'Cleo' });
  check('Commit to dev succeeds', commit.status === 200 && commit.body.outcome === 'committed', JSON.stringify(commit.body));
  check('repos are pushed in deploy order, API first',
    commit.body.commits.map((c) => c.repo).join(',') === 'api,app', JSON.stringify(commit.body.commits));
  for (const name of ['api', 'app']) {
    const bare = join(remotes, `${name}.git`);
    const count = git(bare, 'rev-list', '--count', `${devBefore[name]}..dev`);
    check(`${name}: dev gained exactly one squashed commit`, count === '1', count);
  }
  const msg = git(join(remotes, 'api.git'), 'log', '-1', '--format=%B', 'dev');
  check('the commit message carries the comments, the reviewers and the session',
    msg.includes('"Comment number 2"') && msg.split('\n')[0].endsWith('…') && msg.includes('TapThat-Session:') && msg.includes('Reviewed-by: Cleo, Ana'), msg);
  check('the undone batch did not travel', !read(join(app, 'README.md')).includes('the app')
    && git(join(remotes, 'app.git'), 'show', 'dev:README.md') === 'app');
  check('the playground is back on dev, at the new head',
    branchOf(app) === 'dev' && branchOf(api) === 'dev' && git(api, 'rev-parse', 'HEAD') === remoteHead('api'));
  check('the session branch is gone', git(api, 'branch', '--list', 'tapthat/*') === '');
  const after = (await call('/api/session')).body;
  check('the session ended and the outcome is kept', after.session === null && after.last?.outcome === 'committed');
}

// ── dev moved meanwhile: the session is replayed on top ──────────────────────
{
  const { session } = await startSession();
  await apply("api/src/routes/deals.ts::'id'::'uuid'");
  // A developer pushes an unrelated change to api's dev.
  const d = join(devs, 'api');
  git(d, 'pull', '-q', 'origin', 'dev');
  write(join(d, 'README.md'), 'api, now documented\n');
  git(d, 'commit', '-qam', 'docs'); git(d, 'push', '-q', 'origin', 'dev');
  const commit = await call('/api/session/commit', 'POST', {});
  check('Commit succeeds when dev moved without conflict', commit.status === 200, JSON.stringify(commit.body));
  const bare = join(remotes, 'api.git');
  check('dev keeps the developer\'s change and gains the session on top',
    git(bare, 'show', 'dev:README.md') === 'api, now documented'
    && git(bare, 'show', 'dev:src/routes/deals.ts').includes("'uuid'")
    && git(bare, 'log', '-1', '--format=%s', 'dev~1') === 'docs');
  check('the session\'s own id is in the replayed commit', git(bare, 'log', '-1', '--format=%B', 'dev').includes(session.id));
}

// ── dev moved with a conflict: nothing is sent anywhere ─────────────────────
{
  await startSession();
  await apply("api/src/routes/deals.ts::'uuid'::'key';;app/src/app/deals/page.tsx::<p>stage</p>::<p>Stage</p>");
  const d = join(devs, 'api');
  git(d, 'pull', '-q', 'origin', 'dev');
  write(join(d, 'src/routes/deals.ts'), "export const fields = ['pk', 'name', 'stage'];\n");
  git(d, 'commit', '-qam', 'rename id'); git(d, 'push', '-q', 'origin', 'dev');
  const heads = { api: remoteHead('api'), app: remoteHead('app') };
  const commit = await call('/api/session/commit', 'POST', {});
  check('a conflict is refused with the repo-prefixed file',
    commit.status === 409 && commit.body.error === 'conflict' && commit.body.conflicts.includes('api/src/routes/deals.ts'), JSON.stringify(commit.body));
  check('nothing was pushed to either repo', remoteHead('api') === heads.api && remoteHead('app') === heads.app);
  const s = (await call('/api/session')).body.session;
  check('the session stays active, changes intact', s?.state === 'active' && s.pending.length === 1);

  // ── Discard: leftovers of a broken build included ─────────────────────────
  const broken = await apply("api/src/routes/deals.ts::'key'::'broken'", { BREAK_API: '1' });
  check('setup: a broken build leaves edits on disk', broken.state === 'applied-unverified');
  const blocked = await call('/api/session/commit', 'POST', {});
  check('Commit refuses a tree with uncommitted leftovers', blocked.status === 409 && blocked.body.error === 'dirty', JSON.stringify(blocked.body));
  const discard = await call('/api/session/discard', 'POST', { reviewer: 'Ana' });
  check('Discard succeeds', discard.status === 200 && discard.body.outcome === 'discarded', JSON.stringify(discard.body));
  check('both repos are back on dev and clean',
    branchOf(api) === 'dev' && branchOf(app) === 'dev' && git(api, 'status', '--porcelain') === '' && git(app, 'status', '--porcelain') === '');
  check('dev was never touched by the discarded session', remoteHead('api') === heads.api && remoteHead('app') === heads.app);
}

// ── Shared folders: Commit names the repos that keep their own copy ──────────
{
  // The playground is behind the developer's push; the next Start catches up.
  const { session } = await startSession();
  check('Start brings the playground up to the latest dev', session.base.find((b) => b.repo === 'api').sha === remoteHead('api'));
  const res = await apply('api/shared/contracts/index.ts::id: string::id: string; stage: string');
  check('a contract change lands in both repos', res.state === 'committed' && res.result.filesChanged.includes('app/shared/contracts/index.ts'));
  const commit = await call('/api/session/commit', 'POST', {});
  check('the outcome tells a human to sync the other copies',
    commit.body.notices?.some((n) => n.includes('admin, homepage')), JSON.stringify(commit.body.notices));
}

// ── A restart mid-step: the session says it cannot be trusted ───────────────
{
  await startSession();
  const s = store.getSession();
  s.state = 'committing';
  store.putSession(s);
  await store.flush();
  server.close();
  ({ server, store, call } = await boot());
  await sleep(100);
  const after = (await call('/api/session')).body.session;
  check('a session caught mid-step is marked failed after a restart',
    after?.state === 'failed' && after.error.includes('restarted'), JSON.stringify(after));
  const blocked = await apply('app/README.md::app::x');
  check('batches are refused while the session is failed', blocked.posted === 409);
  const restart = await call('/api/session/start', 'POST', {});
  check('Start asks for a discard first', restart.status === 409 && restart.body.error === 'session_failed');
  const discard = await call('/api/session/discard', 'POST', {});
  check('a failed session can be discarded', discard.status === 200 && branchOf(app) === 'dev' && branchOf(api) === 'dev');
}

server.close();
rmSync(scratch, { recursive: true, force: true });
rmSync(modDir, { recursive: true, force: true });
console.log(failed === 0 ? `PASS — ${total} session checks` : `FAIL — ${failed} of ${total} session checks`);
process.exit(failed === 0 ? 0 : 1);
