/**
 * Several repositories in one workspace: one batch changes the page and the API
 * behind it, lands in both or neither, keeps shared copies in step, and undoes
 * all-or-nothing. Real git repositories, the real HTTP server, a fake agent.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
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
const modDir = mkdtempSync(join(tmpdir(), 'tapthat-ws-mod-'));
writeFileSync(join(modDir, 'mod.mjs'), bundle.outputFiles[0].text);
const { createHttpServer, Store, loadConfig, Workspace, mirrorDirectory, DevServers, deriveKey } =
  await import(join(modDir, 'mod.mjs'));

let failed = 0;
let total = 0;
function check(label, ok, detail) {
  total++;
  if (!ok) { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}

const scratch = mkdtempSync(join(tmpdir(), 'tapthat-ws-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const read = (path) => readFileSync(path, 'utf8');

const CONTRACT = 'export interface Deal { id: string; name: string }\n';

/** A workspace directory with app/ and api/ checkouts on `dev`, each with a bare remote. */
function makeWorkspace(label) {
  const root = join(scratch, label);
  const remotes = join(scratch, `${label}-remotes`);
  mkdirSync(root, { recursive: true });
  mkdirSync(remotes, { recursive: true });
  const files = {
    api: {
      'src/routes/deals.ts': "export const fields = ['id', 'name'];\n",
      'shared/contracts/index.ts': CONTRACT,
    },
    app: {
      'src/app/deals/page.tsx': 'export default () => <h1>Deals</h1>;\n',
      'shared/contracts/index.ts': CONTRACT,
    },
  };
  for (const [name, content] of Object.entries(files)) {
    const bare = join(remotes, `${name}.git`);
    git(remotes, 'init', '-q', '--bare', '-b', 'dev', bare);
    const dir = join(root, name);
    git(root, 'init', '-q', '-b', 'dev', dir);
    git(dir, 'config', 'user.email', 't@e.com');
    git(dir, 'config', 'user.name', 'T');
    for (const [path, text] of Object.entries(content)) write(join(dir, path), text);
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', 'origin', 'dev');
  }
  writeFileSync(join(root, 'app', 'tapthat.config.json'), JSON.stringify({
    branch: 'dev',
    allowedOrigins: ['http://localhost:3000'],
    agent: { command: 'node', args: [fakeAgent] },
    repos: [
      { name: 'app', primary: true, description: 'Next.js customer app',
        devServer: { url: 'http://localhost:3000', command: 'npm run dev' } },
      { name: 'api', description: 'Express API', verifyCommand: 'node -e "process.exit(process.env.BREAK_API ? 1 : 0)"',
        devServer: { url: 'http://localhost:3100', command: 'npm run dev',
          env: { PLATFORM_DATABASE_URL: '${API_DB_URL}' } } },
    ],
    mirrors: [{ from: 'api:shared/contracts', to: ['app:shared/contracts'], alsoUsedBy: ['admin', 'homepage'] }],
  }, null, 2));
  git(join(root, 'app'), 'add', '-A'); git(join(root, 'app'), 'commit', '-q', '-m', 'tapthat config');
  return { root, remotes, app: join(root, 'app'), api: join(root, 'api') };
}

// ── Config: a workspace from the primary repo's committed file ───────────────
const wsDirs = makeWorkspace('main');
{
  const env = { API_DB_URL: 'postgres://dev/platform', TAPTHAT_START_DEV_SERVER: '1' };
  const { config, problems } = await loadConfig(wsDirs.app, env);
  check('a repos[] config loads without problems', problems.length === 0, problems.join('; '));
  check('the workspace root is the directory holding the checkouts', config.workspaceRoot === wsDirs.root, config.workspaceRoot);
  check('primary first, others beside it',
    config.repos.map((r) => `${r.name}:${r.root}`).join(',') === `app:${wsDirs.app},api:${wsDirs.api}`,
    config.repos.map((r) => `${r.name}:${r.root}`).join(','));
  check('${NAME} in a dev server env is filled from the environment',
    config.repos[1].devServer.env.PLATFORM_DATABASE_URL === 'postgres://dev/platform');
  check('the primary dev server is the one the proxy fronts', config.devServerUrl === 'http://localhost:3000');

  const missing = await loadConfig(wsDirs.app, { TAPTHAT_START_DEV_SERVER: '1' });
  check('an unset ${NAME} is a readable config problem',
    missing.problems.some((p) => p.includes('${API_DB_URL}')), missing.problems.join('; '));

  const single = await loadConfig(scratch, {});
  check('without repos[] the config is a workspace of one',
    single.config.repos.length === 1 && single.config.workspaceRoot === single.config.repoRoot);

  const clashDir = join(scratch, 'clash');
  write(join(clashDir, 'tapthat.config.json'), JSON.stringify({
    repos: [
      { name: 'app', devServer: { url: 'http://localhost:3000' } },
      { name: 'app', devServer: { url: 'http://localhost:3000' } },
    ],
    mirrors: [{ from: 'nope:x', to: ['app:y'] }],
  }));
  const clash = await loadConfig(clashDir, { TAPTHAT_START_DEV_SERVER: '1', TAPTHAT_DEV_COMMAND: 'x' });
  check('duplicate repo names, shared ports and unknown mirror repos are all reported',
    ['listed twice', 'also used by', 'unknown repo "nope"'].every((s) => clash.problems.some((p) => p.includes(s))),
    clash.problems.join('; '));
}

// ── The HTTP server over a two-repo workspace ────────────────────────────────
const { config } = await loadConfig(wsDirs.app, { API_DB_URL: 'x' });
const workspace = Workspace.fromConfig(config);
const TOKEN = 'workspace-token-abcdefghij';
const ORIGIN = 'http://localhost:3000';
const server = createHttpServer({
  config: { ...config, devServerUrl: 'http://127.0.0.1:1' },
  repo: workspace.primary.repo, workspace,
  store: await Store.open(join(mkdtempSync(join(tmpdir(), 'ws-st-')), 'state.json')),
  encryptionKey: deriveKey('k'), token: TOKEN,
  envCredential: { raw: 'sk-ant-workspace-test-0000', kind: 'api_key' }, version: '0.0.0',
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = (path, opts = {}) => fetch(`${base}${path}`, {
  ...opts, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, origin: ORIGIN },
});
const comment = {
  id: 'c1', n: 1, comment: 'Show the deal stage', createdAt: '2025-01-01T00:00:00.000Z',
  selector: 'h1', domPath: 'body > h1', tagName: 'h1', attributes: {}, text: 'Deals', html: '<h1>Deals</h1>',
  ancestors: [], landmark: null, nearestHeading: null, siblingIndex: 1, siblingCount: 1,
  rect: { x: 0, y: 0, w: 1, h: 1 }, styles: {},
};
let n = 0;
async function apply(edits, extraEnv = {}) {
  const id = `ws-${++n}`;
  const saved = {};
  const env = { FAKE_AGENT_EDIT: edits, ...extraEnv };
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  await call('/api/batches', { method: 'POST', body: JSON.stringify({
    batchId: id, credentialHandle: null,
    page: { url: `${ORIGIN}/deals`, title: 'Deals', viewport: { w: 1, h: 1 }, capturedAt: 'x' }, comments: [comment],
  }) });
  let status;
  for (let i = 0; i < 100; i++) {
    status = await (await call(`/api/batches/${id}`)).json();
    if (!['queued', 'running'].includes(status.state)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return status;
}
const heads = () => ({ app: git(wsDirs.app, 'rev-parse', 'HEAD'), api: git(wsDirs.api, 'rev-parse', 'HEAD') });
const clean = () => git(wsDirs.app, 'status', '--porcelain') === '' && git(wsDirs.api, 'status', '--porcelain') === '';

// One batch, both repos.
{
  const promptFile = join(scratch, 'prompt.md');
  const before = heads();
  const status = await apply(
    "api/src/routes/deals.ts::'name'::'name', 'stage';;app/src/app/deals/page.tsx::Deals</h1>::Deals</h1><p>{deal.stage}</p>",
    { FAKE_AGENT_PROMPT_OUT: promptFile },
  );
  check('a batch touching both repos is committed', status.state === 'committed', JSON.stringify(status.error));
  check('one commit per repo is reported',
    status.result.commits?.map((c) => c.repo).sort().join(',') === 'api,app', JSON.stringify(status.result.commits));
  check('changed files are prefixed with their repo',
    status.result.filesChanged.includes('api/src/routes/deals.ts') && status.result.filesChanged.includes('app/src/app/deals/page.tsx'),
    status.result.filesChanged.join(', '));
  const after = heads();
  check('both repos moved', after.app !== before.app && after.api !== before.api);
  check('both commits carry the same batch trailer',
    git(wsDirs.app, 'log', '-1', '--format=%B').includes('TapThat batch ws-1') && git(wsDirs.api, 'log', '-1', '--format=%B').includes('TapThat batch ws-1'));
  check('the trees are clean afterwards', clean());

  const prompt = read(promptFile);
  check('the prompt tells the agent which repository is which',
    prompt.includes('`app/` — **app**: Next.js customer app') && prompt.includes('`api/` — **api**: Express API'), prompt.slice(0, 600));
  check('the prompt names the copy not to edit',
    prompt.includes('`app/shared/contracts` is a copy of `api/shared/contracts`'));

  const health = await (await fetch(`${base}/healthz`)).json();
  check('healthz lists every repo', health.repos?.map((r) => r.name).join(',') === 'app,api', JSON.stringify(health.repos));
  check('healthz lists every dev server', health.devServers?.map((s) => s.name).join(',') === 'app,api');

  // Undo both.
  const undo = await call(`/api/batches/ws-1/revert`, { method: 'POST' });
  const undone = await undo.json();
  check('undo reverts both repos', undo.status === 202 && undone.commits?.length === 2, JSON.stringify(undone));
  check('the files are back', read(join(wsDirs.api, 'src/routes/deals.ts')).includes("['id', 'name']")
    && !read(join(wsDirs.app, 'src/app/deals/page.tsx')).includes('stage'));
}

// Mirrors: the original is edited, the copy follows in the same batch.
{
  const status = await apply(`api/shared/contracts/index.ts::name: string::name: string; stage: string`);
  check('an edit to the original contract is committed', status.state === 'committed', JSON.stringify(status.error));
  check('the copy in app was updated to match',
    read(join(wsDirs.app, 'shared/contracts/index.ts')) === read(join(wsDirs.api, 'shared/contracts/index.ts'))
    && read(join(wsDirs.app, 'shared/contracts/index.ts')).includes('stage'));
  check('the copy is committed in app, in the same batch',
    status.result.filesChanged.includes('app/shared/contracts/index.ts'), status.result.filesChanged.join(', '));

  const before = heads();
  const copyOnly = await apply(`app/shared/contracts/index.ts::stage: string::stage: number`);
  check('editing only the copy is refused', copyOnly.state === 'failed'
    && copyOnly.error?.message.includes('is a copy of api/shared/contracts'), JSON.stringify(copyOnly.error));
  check('…and nothing is left behind', clean() && heads().app === before.app);
}

// A verify failure in one repo: nothing committed anywhere.
{
  const before = heads();
  const status = await apply(
    "api/src/routes/deals.ts::'id'::'uuid';;app/src/app/deals/page.tsx::<h1>::<h1 className=\"x\">",
    { BREAK_API: '1' },
  );
  check('a broken build in api ends applied-unverified', status.state === 'applied-unverified', status.state);
  check('the output names the repo that broke', status.error?.message.includes('── api ──'), status.error?.message);
  const after = heads();
  check('nothing was committed in either repo', after.app === before.app && after.api === before.api);
  // Leave the next test a clean slate, as a reviewer's "comment again" would.
  git(wsDirs.api, 'checkout', '--', '.'); git(wsDirs.app, 'checkout', '--', '.');
}

// The agent fails after editing both: both are restored.
{
  const before = heads();
  const status = await apply(
    "api/src/routes/deals.ts::'id'::'uuid';;app/src/app/deals/page.tsx::<h1>::<h2>;;app/src/new-file.ts::::export {};",
    { FAKE_AGENT_FAIL_AFTER: '1' },
  );
  check('a failing run ends failed', status.state === 'failed');
  check('both repos are restored, including the new file',
    clean() && !existsSync(join(wsDirs.app, 'src/new-file.ts')) && heads().app === before.app);
}

// Undo is all-or-nothing: a conflict in one repo leaves both untouched.
{
  const status = await apply("api/src/routes/deals.ts::'id'::'key';;app/src/app/deals/page.tsx::Deals</h1>::All deals</h1>");
  check('setup batch committed', status.state === 'committed', JSON.stringify(status.error));
  // A developer changes the same api line afterwards.
  write(join(wsDirs.api, 'src/routes/deals.ts'), "export const fields = ['pk', 'name'];\n");
  git(wsDirs.api, 'commit', '-qam', 'developer change');
  const before = heads();
  const undo = await call(`/api/batches/${status.batchId}/revert`, { method: 'POST' });
  const body = await undo.json();
  check('the conflict is reported with the repo-prefixed path',
    undo.status === 409 && body.error === 'conflict' && body.conflicts?.includes('api/src/routes/deals.ts'), JSON.stringify(body));
  const after = heads();
  check('neither repo was reverted', after.app === before.app && after.api === before.api && clean());
  check('app still shows the change', read(join(wsDirs.app, 'src/app/deals/page.tsx')).includes('All deals'));
}

server.close();

// ── Mirroring mechanics ──────────────────────────────────────────────────────
{
  const src = join(scratch, 'mirror-src');
  const dst = join(scratch, 'mirror-dst');
  write(join(src, 'a.ts'), 'a'); write(join(src, 'deep/b.ts'), 'b');
  write(join(dst, 'a.ts'), 'old'); write(join(dst, 'gone.ts'), 'x');
  write(join(dst, 'node_modules/keep.js'), 'k'); write(join(dst, 'generated/client.js'), 'g');
  const changed = await mirrorDirectory(src, dst);
  check('changed and new files are copied, removed ones deleted',
    read(join(dst, 'a.ts')) === 'a' && read(join(dst, 'deep/b.ts')) === 'b' && !existsSync(join(dst, 'gone.ts')));
  check('installed and generated files are left alone',
    existsSync(join(dst, 'node_modules/keep.js')) && existsSync(join(dst, 'generated/client.js')));
  check('it reports what it touched', changed.join(',') === 'a.ts,deep/b.ts,gone.ts', changed.join(','));
  check('a second run is a no-op', (await mirrorDirectory(src, dst)).length === 0);
}

// ── Dev servers: one per repo, own port, own env, stopped for real ──────────
{
  const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  const [p1, p2] = [await freePort(), await freePort()];
  const serverScript = join(scratch, 'serve.cjs');
  writeFileSync(serverScript, "require('http').createServer((q, r) => r.end(`${process.env.PORT} ${process.env.WHO}`)).listen(process.env.PORT);");
  const servers = new DevServers([
    { name: 'app', command: `node ${serverScript}`, cwd: scratch, url: `http://127.0.0.1:${p1}`, env: { WHO: 'app' } },
    { name: 'api', command: `node ${serverScript}`, cwd: scratch, url: `http://127.0.0.1:${p2}`, env: { WHO: 'api' } },
  ]);
  servers.startAll();
  const get = async (port) => {
    for (let i = 0; i < 50; i++) {
      try { return await (await fetch(`http://127.0.0.1:${port}`)).text(); } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    return null;
  };
  check('each dev server gets its own port and env',
    (await get(p1)) === `${p1} app` && (await get(p2)) === `${p2} api`);
  await servers.stop('api');
  let stillUp = true;
  try { await fetch(`http://127.0.0.1:${p2}`); } catch { stillUp = false; }
  check('stopping a server stops the process behind the shell, freeing its port', !stillUp);
  check('the other server keeps running', (await get(p1)) === `${p1} app`);
  servers.start('api');
  check('a stopped server can be started again', (await get(p2)) === `${p2} api`);
  await servers.stopAll();
}

rmSync(scratch, { recursive: true, force: true });
rmSync(modDir, { recursive: true, force: true });
console.log(failed === 0 ? `PASS — ${total} workspace checks` : `FAIL — ${failed} of ${total} workspace checks`);
process.exit(failed === 0 ? 0 : 1);
