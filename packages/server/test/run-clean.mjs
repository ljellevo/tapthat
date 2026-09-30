/**
 * Start session's clean slate (session.clean): ignored files go, except
 * dependencies, secrets, the configured names and the sidecar's own state; the
 * dev servers are stopped around it and always started again.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
const modDir = mkdtempSync(join(tmpdir(), 'tapthat-clean-mod-'));
writeFileSync(join(modDir, 'mod.mjs'), bundle.outputFiles[0].text);
const { Repo, loadConfig, makeCleanStep, pruneIgnored } = await import(join(modDir, 'mod.mjs'));

let failed = 0;
let total = 0;
function check(label, ok, detail) {
  total++;
  if (!ok) { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}

const scratch = mkdtempSync(join(tmpdir(), 'tapthat-clean-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

// ── A checkout shaped like Dealroom's api after a few sessions ──────────────
const dir = join(scratch, 'api');
git(scratch, 'init', '-q', '-b', 'dev', dir);
write(join(dir, '.gitignore'), ['node_modules/', '.next/', '.env', '.env.local', 'shared/*/generated/', 'data/', '*.tsbuildinfo', 'config/'].join('\n'));
write(join(dir, 'src/main.ts'), 'export {};\n');
git(dir, '-c', 'user.email=s@e', '-c', 'user.name=S', 'add', '-A');
git(dir, '-c', 'user.email=s@e', '-c', 'user.name=S', 'commit', '-q', '-m', 'init');
write(join(dir, '.git/info/exclude'), '/.tapthat/\n');

write(join(dir, 'node_modules/next/index.js'), 'x');
write(join(dir, '.next/dev/cache/turbopack/blob'), 'x'.repeat(4096));
write(join(dir, '.env'), 'A=1');
write(join(dir, '.env.local'), 'B=2');
write(join(dir, 'shared/db-platform/generated/client.js'), 'prisma');
write(join(dir, 'data/doc-from-an-old-session.pdf'), 'bytes');
write(join(dir, 'tsconfig.tsbuildinfo'), '{}');
write(join(dir, 'config/.env'), 'C=3');
write(join(dir, 'config/cache.json'), '{}');
write(join(dir, '.tapthat/state.json'), '{}');

const repo = new Repo(dir);
const { removed, bytes } = await pruneIgnored(repo, ['generated'], [join(dir, '.tapthat')]);
const gone = (p) => !existsSync(join(dir, p));
const kept = (p) => existsSync(join(dir, p));

check('build output and caches are removed', gone('.next') && gone('tsconfig.tsbuildinfo'), removed.join(', '));
check('files earlier sessions left behind are removed', gone('data'));
check('dependencies stay', kept('node_modules/next/index.js'));
check('.env files stay, even inside an ignored directory', kept('.env') && kept('.env.local') && kept('config/.env') && gone('config/cache.json'));
check('configured names stay, whichever path segment matches', kept('shared/db-platform/generated/client.js'));
check('the sidecar\'s own state stays', kept('.tapthat/state.json'));
check('tracked files are untouched and the tree is clean', kept('src/main.ts') && git(dir, 'status', '--porcelain') === '');
check('the removed entries and bytes are reported',
  removed.includes('.next/') && removed.includes('data/') && !removed.includes('config/') && bytes >= 4096, `${removed.join(', ')} ${bytes}`);

// ── The step: servers stopped around it, stale session branches deleted ─────
git(dir, 'branch', 'tapthat/session-202601010000-aaaa');
git(dir, 'branch', 'feature/keep-me');
write(join(dir, '.next/dev/blob'), 'x');

const calls = [];
const step = (install) => makeCleanStep({
  repos: [{ name: 'api', repo }],
  keep: ['generated'],
  protect: [join(dir, '.tapthat')],
  stopServers: async () => { calls.push('stop'); },
  startServers: async () => { calls.push('start'); },
  install,
});
const events = [];
await step(async (name) => { calls.push(`install:${name}`); })((message) => events.push(message));

check('servers stop first, reinstall runs after the clean, servers start last',
  calls.join(',') === 'stop,install:api,start', calls.join(','));
check('leftover session branches are deleted, other branches stay',
  git(dir, 'branch', '--list', 'tapthat/*') === '' && git(dir, 'branch', '--list', 'feature/*') !== '');
check('the step reports what it freed', events.some((e) => /^Cleared \d+ KB of build output and caches\.$/.test(e)), events.join(' | '));
check('the clean ran inside the step', gone('.next'));

calls.length = 0;
const err = await step(async () => { throw new Error('npm ci failed'); })(() => {}).then(() => null, (e) => e);
check('a failed install fails the step', err?.message === 'npm ci failed', String(err));
check('the servers are started again even when it fails', calls.join(',') === 'stop,start', calls.join(','));

// ── Config ──────────────────────────────────────────────────────────────────
const cfgDir = join(scratch, 'cfg');
const withConfig = async (file, env = {}) => {
  write(join(cfgDir, 'tapthat.config.json'), JSON.stringify(file));
  return loadConfig(cfgDir, env);
};
const base = { git: { mode: 'session' }, devServer: { command: 'npm run dev' } };
{
  const { config, problems } = await withConfig(base);
  check('clean is off unless configured', config.session.clean === null && problems.length === 0, problems.join('; '));
}
{
  const { config, problems } = await withConfig({ ...base, session: { clean: true } }, { TAPTHAT_START_DEV_SERVER: '1' });
  check('"clean": true keeps only the defaults', JSON.stringify(config.session.clean) === '{"keep":[]}' && problems.length === 0, problems.join('; '));
}
{
  const { config } = await withConfig({ ...base, session: { clean: { keep: ['generated'] } } }, { TAPTHAT_START_DEV_SERVER: '1' });
  check('keep names are read', JSON.stringify(config.session.clean?.keep) === '["generated"]');
}
{
  const { problems } = await withConfig({ ...base, session: { clean: true } });
  check('clean without devServer.start is a config problem', problems.some((p) => p.startsWith('session.clean: needs devServer.start')), problems.join('; '));
}
{
  const { problems } = await withConfig({ devServer: { command: 'npm run dev' }, session: { clean: true } }, { TAPTHAT_START_DEV_SERVER: '1' });
  check('clean outside session mode is a config problem', problems.some((p) => p.startsWith('session.clean: only used')), problems.join('; '));
}

console.log(failed === 0 ? `PASS — ${total} clean checks` : `FAIL — ${failed} of ${total} clean checks`);
process.exit(failed === 0 ? 0 : 1);
