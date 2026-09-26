/**
 * Start session's data copy against real databases: a "dev" Postgres, a
 * "playground" Postgres and a Redis, each a throwaway container. Shaped like
 * Dealroom: a platform database, an auth database, and a data-room database
 * that logs in with its own role and password.
 *
 * Needs Docker and the Postgres client tools; skips (and says so) without them.
 * The containers use Postgres 16 so the client that ships with Ubuntu runners
 * and Homebrew can dump them.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const has = (bin, args) => spawnSync(bin, args, { stdio: 'ignore' }).status === 0;
if (!has('docker', ['info']) || !has('pg_dump', ['--version']) || !has('psql', ['--version'])) {
  console.log('SKIP — snapshot checks need Docker and the Postgres client (pg_dump, psql)');
  process.exit(0);
}

const bundle = await esbuild.build({
  entryPoints: [join(pkgRoot, 'src', 'testing.ts')],
  bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'bundle', write: false,
});
const modDir = mkdtempSync(join(tmpdir(), 'tapthat-snap-mod-'));
writeFileSync(join(modDir, 'mod.mjs'), bundle.outputFiles[0].text);
const { createHttpServer, Store, loadConfig, Workspace, deriveKey, makeSnapshotHooks } = await import(join(modDir, 'mod.mjs'));

let failed = 0;
let total = 0;
function check(label, ok, detail) {
  total++;
  if (!ok) { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();

// ── Containers ──────────────────────────────────────────────────────────────
const tag = `tapthat-snap-${process.pid}`;
const containers = [];
function container(name, image, env, port) {
  const id = sh('docker', ['run', '-d', '--rm', '--name', `${tag}-${name}`, ...env.flatMap((e) => ['-e', e]), '-p', `127.0.0.1::${port}`, image]);
  containers.push(id);
  return Number(sh('docker', ['port', id, String(port)]).split(':').pop());
}
const cleanup = () => { for (const id of containers) spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' }); };
process.on('exit', cleanup);

const srcPort = container('dev', 'postgres:16-alpine', ['POSTGRES_PASSWORD=devsuper'], 5432);
const dstPort = container('play', 'postgres:16-alpine', ['POSTGRES_PASSWORD=playsuper'], 5432);
const redisPort = container('redis', 'redis:7-alpine', [], 6379);

const SRC = `postgresql://postgres:devsuper@127.0.0.1:${srcPort}/postgres`;
const DST = `postgresql://postgres:playsuper@127.0.0.1:${dstPort}/postgres`;
const REDIS = `redis://127.0.0.1:${redisPort}/0`;
const at = (url, db, user, pass) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) { u.username = user; u.password = pass; }
  return u.toString();
};
const sql = (url, q) => sh('psql', ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-At', '-d', url, '-c', q]);
const trySql = (url, q) => spawnSync('psql', ['--no-psqlrc', '-At', '-d', url, '-c', q], { encoding: 'utf8' });

for (const url of [SRC, DST]) {
  for (let i = 0; i < 60 && trySql(url, 'select 1').status !== 0; i++) await sleep(500);
}
for (let i = 0; i < 30 && spawnSync('docker', ['exec', `${tag}-redis`, 'redis-cli', 'ping']).status !== 0; i++) await sleep(300);

// dev: platform + auth + one data room with its own login.
sql(SRC, 'CREATE DATABASE platform');
sql(at(SRC, 'platform'), "CREATE TABLE rooms (id text); INSERT INTO rooms VALUES ('abc')");
sql(SRC, 'CREATE DATABASE auth');
sql(at(SRC, 'auth'), "CREATE TABLE users (email text); INSERT INTO users VALUES ('ana@example.com')");
sql(SRC, "CREATE ROLE room_abc LOGIN PASSWORD 'room-secret'");
sql(SRC, 'CREATE DATABASE room_abc OWNER room_abc');
sql(at(SRC, 'room_abc', 'room_abc', 'room-secret'), "CREATE TABLE docs (title text); INSERT INTO docs VALUES ('NDA'), ('SPA')");
// The recommended source login: read-only, via pg_read_all_data.
sql(SRC, "CREATE ROLE reader LOGIN PASSWORD 'reader-secret'; GRANT pg_read_all_data TO reader");
// A login that can read the data table by table, but not role passwords.
sql(SRC, "CREATE ROLE limited LOGIN PASSWORD 'limited-secret'; GRANT room_abc TO limited");
sql(at(SRC, 'platform'), 'GRANT SELECT ON rooms TO limited');
sql(at(SRC, 'auth'), 'GRANT SELECT ON users TO limited');
// playground: stale data, and a room created during an earlier session.
sql(DST, 'CREATE DATABASE platform');
sql(at(DST, 'platform'), "CREATE TABLE rooms (id text); INSERT INTO rooms VALUES ('old')");
sql(DST, 'CREATE DATABASE stale_room');
sh('docker', ['exec', `${tag}-redis`, 'redis-cli', 'set', 'ratelimit:ana', '5']);

// ── A session-mode sidecar with the snapshot hooks ──────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'tapthat-snap-'));
const bare = join(scratch, 'app.git');
sh('git', ['init', '-q', '--bare', '-b', 'dev', bare]);
const app = join(scratch, 'app');
sh('git', ['init', '-q', '-b', 'dev', app]);
writeFileSync(join(app, 'tapthat.config.json'), JSON.stringify({ branch: 'dev', allowedOrigins: ['http://localhost:3000'], git: { mode: 'session' } }));
sh('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'add', '-A'], { cwd: app });
sh('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init'], { cwd: app });
sh('git', ['remote', 'add', 'origin', bare], { cwd: app });
sh('git', ['push', '-q', 'origin', 'dev'], { cwd: app });

const calls = [];
async function boot(source) {
  const { config, problems } = await loadConfig(app, { TAPTHAT_SNAPSHOT_SOURCE: source, TAPTHAT_SNAPSHOT_TARGET: DST, TAPTHAT_SNAPSHOT_REDIS: REDIS });
  if (problems.length) throw new Error(problems.join('; '));
  config.session.snapshot.stopServers = [config.repos[0].name];
  const snapDir = join(scratch, 'state', 'snapshots');
  mkdirSync(snapDir, { recursive: true });
  const hooks = makeSnapshotHooks({
    snapshot: config.session.snapshot,
    dir: snapDir,
    stopServer: async (name) => calls.push(`stop:${name}`),
    startServer: (name) => calls.push(`start:${name}`),
    prepare: async () => calls.push('prepare'),
  });
  const ws = Workspace.fromConfig(config);
  const store = await Store.open(join(scratch, 'state', 'state.json'));
  const server = createHttpServer({
    config, repo: ws.primary.repo, workspace: ws, sessionHooks: hooks, store,
    encryptionKey: deriveKey('k'), token: 'snapshot-token-abcdefgh', envCredential: null, version: '0.0.0',
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET') => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer snapshot-token-abcdefgh', origin: 'http://localhost:3000' }, body: method === 'POST' ? '{}' : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  // As the CLI does on shutdown: persist before the next sidecar reads the state.
  const stop = async () => { await store.flush(); server.close(); };
  return { stop, call };
}
async function startAndWait(call) {
  const res = await call('/api/session/start', 'POST');
  let s = res.body?.session;
  for (let i = 0; i < 300 && s?.state === 'starting'; i++) { await sleep(100); s = (await call('/api/session')).body.session; }
  return s;
}

// ── Start session: dev's data arrives ────────────────────────────────────────
let { stop, call } = await boot(SRC);
{
  const s = await startAndWait(call);
  check('Start session with a snapshot becomes active', s?.state === 'active', JSON.stringify({ state: s?.state, error: s?.error }));
  check('progress reports each database with a step count',
    s.events.some((e) => e.message.includes('room_abc') && e.steps === 3), JSON.stringify(s.events.map((e) => e.message)));
  check('every database arrives with dev\'s rows',
    sql(at(DST, 'platform'), 'select id from rooms') === 'abc'
    && sql(at(DST, 'auth'), 'select email from users') === 'ana@example.com');
  check('a room database is reachable with its own copied login',
    sql(at(DST, 'room_abc', 'room_abc', 'room-secret'), 'select count(*) from docs') === '2');
  check('databases dev does not have are dropped', trySql(at(DST, 'stale_room'), 'select 1').status !== 0);
  check('the playground still logs in with its own superuser password', trySql(DST, 'select 1').status === 0);
  check('servers holding connections are stopped around the copy, and migrations run',
    calls.join(',') === 'stop:app,prepare,start:app', calls.join(','));
  check('the playground cache is cleared',
    sh('docker', ['exec', `${tag}-redis`, 'redis-cli', 'exists', 'ratelimit:ana']) === '0');
}

// ── Discard: back to the session's starting data ─────────────────────────────
{
  sql(at(DST, 'room_abc', 'room_abc', 'room-secret'), "INSERT INTO docs VALUES ('made in the playground')");
  sql(DST, 'CREATE DATABASE room_new');
  const res = await call('/api/session/discard', 'POST');
  check('Discard succeeds', res.status === 200, JSON.stringify(res.body));
  check('data changed during the session is back to the start',
    sql(at(DST, 'room_abc', 'room_abc', 'room-secret'), 'select count(*) from docs') === '2');
  check('a room created during the session is gone', trySql(at(DST, 'room_new'), 'select 1').status !== 0);
  check('dev was never written to', sql(at(SRC, 'room_abc'), 'select count(*) from docs') === '2'
    && trySql(at(SRC, 'room_new'), 'select 1').status !== 0);
}
await stop();

// ── A source that cannot be reached: failed, and the playground untouched ────
{
  sql(at(DST, 'platform'), "INSERT INTO rooms VALUES ('marker')");
  ({ stop, call } = await boot('postgresql://postgres:devsuper@127.0.0.1:1/postgres'));
  const s = await startAndWait(call);
  check('an unreachable source fails the session with the client\'s own message',
    s?.state === 'failed' && /psql failed|connection|refused/i.test(s.error ?? ''), JSON.stringify(s?.error));
  check('the failure message never contains the connection password', !(s?.error ?? '').includes('devsuper'));
  check('the playground data is untouched', sql(at(DST, 'platform'), "select count(*) from rooms where id = 'marker'") === '1');
  const discard = await call('/api/session/discard', 'POST');
  check('the failed session can be discarded without a copy to restore', discard.status === 200, JSON.stringify(discard.body));
  await stop();
}

// ── A read-only source (pg_read_all_data): everything, passwords included ────
const resetRoom = () => { sql(DST, 'DROP DATABASE IF EXISTS room_abc WITH (FORCE)'); sql(DST, 'DROP ROLE IF EXISTS room_abc'); };
{
  resetRoom();
  ({ stop, call } = await boot(`postgresql://reader:reader-secret@127.0.0.1:${srcPort}/postgres`));
  const s = await startAndWait(call);
  check('a read-only pg_read_all_data source starts a session', s?.state === 'active', JSON.stringify(s?.error));
  check('…with role passwords copied, so a room login works',
    sql(at(DST, 'room_abc', 'room_abc', 'room-secret'), 'select count(*) from docs') === '2');
  await call('/api/session/discard', 'POST');
  await stop();
}

// ── A source that can read the data but not role passwords ──────────────────
{
  resetRoom();
  ({ stop, call } = await boot(`postgresql://limited:limited-secret@127.0.0.1:${srcPort}/postgres`));
  const s = await startAndWait(call);
  check('a source without pg_read_all_data still starts a session', s?.state === 'active', JSON.stringify(s?.error));
  check('it says role passwords could not be copied',
    s?.events.some((e) => e.message.includes('cannot read role passwords')), JSON.stringify(s?.events.map((e) => e.message)));
  check('the data arrives', sql(at(DST, 'room_abc'), 'select count(*) from docs') === '2');
  check('but a room login needing its password does not work',
    trySql(at(DST, 'room_abc', 'room_abc', 'room-secret'), 'select 1').status !== 0);
  await stop();
}

cleanup();
rmSync(scratch, { recursive: true, force: true });
rmSync(modDir, { recursive: true, force: true });
console.log(failed === 0 ? `PASS — ${total} snapshot checks` : `FAIL — ${failed} of ${total} snapshot checks`);
process.exit(failed === 0 ? 0 : 1);
