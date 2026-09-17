/**
 * The safety suite (R1-R4 in the plan).
 *
 * These exercise runJob against real throwaway git repositories with a stubbed
 * agent, so they run in CI without the Claude CLI or an API key. What they guard
 * is the reason the job handler is allowed near a developer's working tree at
 * all — a regression here loses someone's uncommitted work.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

// Bundle the TypeScript sources once and import the result, so the suite tests
// the same code path the CLI ships.
const bundle = await esbuild.build({
  entryPoints: [join(pkgRoot, 'src', 'testing.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'bundle',
  write: false,
});
const modPath = join(mkdtempSync(join(tmpdir(), 'tapthat-mod-')), 'mod.mjs');
writeFileSync(modPath, bundle.outputFiles[0].text);
const { runJob, Repo, sequencer, checkNotProduction } = await import(modPath);

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tapthat-repo-'));
  git(dir, 'init', '-q', '-b', 'dev');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'app.js'), 'export const heading = "Hello";\n');
  writeFileSync(join(dir, 'other.js'), 'export const untouched = true;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const comment = {
  id: 'c1', n: 1, comment: 'Make the heading smaller', createdAt: '2025-01-01T00:00:00.000Z',
  selector: 'h1', domPath: 'body > h1', tagName: 'h1', attributes: {}, text: 'Hello',
  html: '<h1>Hello</h1>', ancestors: [], landmark: null, nearestHeading: null,
  siblingIndex: 1, siblingCount: 1, rect: { x: 0, y: 0, w: 100, h: 20 }, styles: {},
};
const page = {
  url: 'http://localhost:5173/', title: 'Test',
  viewport: { w: 1024, h: 768 }, capturedAt: '2025-01-01T00:00:00.000Z',
};
const batch = (over = {}) => ({
  batchId: 'batch-1', credentialHandle: null, page, comments: [comment], ...over,
});
const config = (over = {}) => ({
  allowDirty: false,
  git: { enabled: true, author: { name: 'TapThat', email: 'tapthat@localhost' } },
  timeoutMs: 5000,
  maxCommentsPerBatch: 20,
  ...over,
});

let failed = 0;
const results = [];
function check(label, ok, detail) {
  results.push([label, ok]);
  if (!ok) {
    failed++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

const events = () => {
  const log = [];
  return { log, emit: sequencer((e) => log.push(e)) };
};

// ── R1: a failed job must not touch uncommitted work ─────────────────────────
{
  const dir = makeRepo();
  // The developer's work in progress, unrelated to the batch.
  writeFileSync(join(dir, 'other.js'), 'export const untouched = true; // MY PRECIOUS WIP\n');
  const wipBefore = readFileSync(join(dir, 'other.js'), 'utf8');

  const { emit } = events();
  const result = await runJob(batch(), {
    repo: new Repo(dir),
    config: config({ allowDirty: true }),
    async runAgent() {
      // The agent edits a file, then fails — the worst case for cleanup.
      writeFileSync(join(dir, 'app.js'), 'export const heading = "BROKEN";\n');
      writeFileSync(join(dir, 'stray.js'), 'debris\n');
      return { ok: false, summary: '', error: 'could not locate the element' };
    },
  }, emit);

  check('R1 failed job reports failure', result.state === 'failed', `got ${result.state}`);
  check('R1 uncommitted WIP survives byte-identical',
    readFileSync(join(dir, 'other.js'), 'utf8') === wipBefore);
  check('R1 the agent\'s edit is rolled back',
    readFileSync(join(dir, 'app.js'), 'utf8') === 'export const heading = "Hello";\n');
  check('R1 the agent\'s stray file is removed', !existsSync(join(dir, 'stray.js')));
  rmSync(dir, { recursive: true, force: true });
}

// ── R1: refuse to start on a dirty tree by default ───────────────────────────
{
  const dir = makeRepo();
  writeFileSync(join(dir, 'other.js'), 'dirty\n');
  let agentRan = false;
  const { emit } = events();
  const result = await runJob(batch(), {
    repo: new Repo(dir),
    config: config(),
    async runAgent() { agentRan = true; return { ok: true, summary: 'x' }; },
  }, emit);

  check('R1 dirty tree refuses to start', result.state === 'failed' && result.error?.kind === 'git');
  check('R1 dirty tree never reaches the agent', agentRan === false);
  check('R1 refusal names the dirty file', /other\.js/.test(result.error?.message ?? ''));
  rmSync(dir, { recursive: true, force: true });
}

// ── R1: commit only what the run touched, never `add -A` ─────────────────────
{
  const dir = makeRepo();
  writeFileSync(join(dir, 'bystander.js'), 'not mine\n');   // untracked bystander
  const { emit, log } = events();
  const result = await runJob(batch(), {
    repo: new Repo(dir),
    config: config({ allowDirty: true }),
    async runAgent() {
      writeFileSync(join(dir, 'app.js'), 'export const heading = "Small";\n');
      return { ok: true, summary: 'Made the heading smaller' };
    },
  }, emit);

  check('R1 successful job commits', result.state === 'committed', `got ${result.state}`);
  const committed = git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
  check('R1 commit contains only the touched file',
    committed.length === 1 && committed[0] === 'app.js', `got ${JSON.stringify(committed)}`);
  check('R1 bystander file stays untracked', existsSync(join(dir, 'bystander.js')) &&
    git(dir, 'status', '--porcelain').includes('?? bystander.js'));
  check('R1 filesChanged comes from git, not the model',
    JSON.stringify(result.filesChanged) === JSON.stringify(['app.js']));
  check('R1 emits a files-changed event', log.some((e) => e.type === 'files-changed'));
  rmSync(dir, { recursive: true, force: true });
}

// ── R1: the unsafe call has nowhere to live ──────────────────────────────────
{
  const srcDir = join(pkgRoot, 'src');
  const sources = readdirSync(srcDir, { recursive: true })
    .filter((f) => typeof f === 'string' && f.endsWith('.ts'))
    .map((f) => readFileSync(join(srcDir, f), 'utf8'));
  const all = sources.join('\n');
  check('R1 no `reset --hard` anywhere in the sidecar', !/reset[^\n]*--hard/.test(all));
  check('R1 no `git add -A` / `add .` anywhere in the sidecar',
    !/'add',\s*'-A'/.test(all) && !/'add',\s*'\.'/.test(all));
}

// ── R4: a broken build must not be reported as success ───────────────────────
{
  const dir = makeRepo();
  const { emit, log } = events();
  const result = await runJob(batch(), {
    repo: new Repo(dir),
    config: config(),
    async runAgent() {
      writeFileSync(join(dir, 'app.js'), 'export const heading = ((( ;\n');
      return { ok: true, summary: 'Made the heading smaller' };
    },
    async verify() {
      return { ok: false, output: "app.js:1:32 - error TS1005: ')' expected." };
    },
  }, emit);

  check('R4 build breakage yields applied-unverified, not committed',
    result.state === 'applied-unverified', `got ${result.state}`);
  check('R4 compiler output is carried back',
    (result.error?.message ?? '').includes('TS1005'));
  check('R4 nothing is committed', git(dir, 'log', '--oneline').split('\n').length === 1);
  check('R4 the edit stays on disk for the reviewer to see',
    readFileSync(join(dir, 'app.js'), 'utf8').includes('((('));
  check('R4 emits verify-failed', log.some((e) => e.type === 'verify-failed'));
  rmSync(dir, { recursive: true, force: true });
}

// ── R4: a passing verify still commits ───────────────────────────────────────
{
  const dir = makeRepo();
  const { emit, log } = events();
  const result = await runJob(batch(), {
    repo: new Repo(dir),
    config: config(),
    async runAgent() {
      writeFileSync(join(dir, 'app.js'), 'export const heading = "Small";\n');
      return { ok: true, summary: 'Made the heading smaller' };
    },
    async verify() { return { ok: true, output: '' }; },
  }, emit);
  check('R4 passing verify commits', result.state === 'committed', `got ${result.state}`);
  check('R4 emits verify-passed', log.some((e) => e.type === 'verify-passed'));
  rmSync(dir, { recursive: true, force: true });
}

// ── An agent that claims success but changed nothing is a failure ────────────
{
  const dir = makeRepo();
  const { emit } = events();
  const result = await runJob(batch(), {
    repo: new Repo(dir),
    config: config(),
    async runAgent() { return { ok: true, summary: 'All done!' }; },
  }, emit);
  check('no-op run is reported as a failure', result.state === 'failed', `got ${result.state}`);
  rmSync(dir, { recursive: true, force: true });
}

// ── R5: revert refuses on a dirty tree, aborts cleanly on conflict ───────────
{
  const dir = makeRepo();
  const repo = new Repo(dir);
  writeFileSync(join(dir, 'app.js'), 'export const heading = "Small";\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'change');
  const target = git(dir, 'rev-parse', '--short', 'HEAD');

  const ok = await repo.revert(target);
  check('R5 clean revert succeeds', ok.ok === true);
  check('R5 revert restores the previous content',
    readFileSync(join(dir, 'app.js'), 'utf8') === 'export const heading = "Hello";\n');

  // Manufacture a conflict: change the same line, then revert the older commit.
  writeFileSync(join(dir, 'app.js'), 'export const heading = "Conflicting";\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'conflict');
  const conflicted = await repo.revert(target);
  check('R5 conflicting revert reports failure', conflicted.ok === false);
  check('R5 conflicting revert leaves the tree clean (no half-applied revert)',
    git(dir, 'status', '--porcelain') === '', `status: ${git(dir, 'status', '--porcelain')}`);
  rmSync(dir, { recursive: true, force: true });
}

// ── The production guard ─────────────────────────────────────────────────────
{
  check('guard blocks NODE_ENV=production',
    checkNotProduction({ NODE_ENV: 'production', TAPTHAT_ENABLE: '1' }) !== null);
  check('guard blocks a missing TAPTHAT_ENABLE',
    checkNotProduction({}) !== null);
  check('guard allows an explicit opt-in',
    checkNotProduction({ TAPTHAT_ENABLE: '1' }) === null);
  check('production refusal cannot be overridden by TAPTHAT_ENABLE',
    checkNotProduction({ NODE_ENV: 'production', TAPTHAT_ENABLE: '1' })?.includes('NODE_ENV=production'));
}

rmSync(dirname(modPath), { recursive: true, force: true });

console.log(
  failed === 0
    ? `PASS — ${results.length} sidecar safety checks`
    : `FAIL — ${failed} of ${results.length} sidecar safety checks`,
);
process.exit(failed === 0 ? 0 : 1);
