import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { connect as netConnect, type Socket } from 'node:net';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { promisify } from 'node:util';
import { addSecret, scrub } from './log';
import type { Progress, SessionHooks } from './session';

const exec = promisify(execFile);

/**
 * Start session's data half: a copy of dev's Postgres into the playground's.
 *
 * Every database is dumped with pg_dump (custom format) and restored with
 * pg_restore after the target's copy is dropped, roles first so ownership and
 * per-database logins survive. The dumps are kept as the session's restore
 * point: Discard restores them the same way, so a session — schema changes and
 * all — is always fully reversible.
 */
export interface SnapshotConfig {
  /**
   * Connection URL for dev's Postgres. Read-only is enough: a role granted
   * `pg_read_all_data` can read every table and the role password hashes.
   */
  source: string;
  /** Connection URL for the playground's Postgres, as a user that may drop and create databases. */
  target: string;
  /** Databases never copied. `postgres` and templates are always skipped. */
  exclude: string[];
  /** Dev servers stopped while the data is replaced, so none holds a connection. */
  stopServers: string[];
  /** The playground's Redis, flushed after a restore (caches, rate limits). */
  redisUrl: string | null;
}

export interface SnapshotDeps {
  snapshot: SnapshotConfig;
  /** Holds the session's dumps. */
  dir: string;
  stopServer(name: string): Promise<void>;
  startServer(name: string): void;
  /** Each repo's `prepare` (migrations), run after the data is in place. */
  prepare(): Promise<void>;
  /** Extra commands after the copy, for stacks that need more than Postgres. */
  onStart?: string[];
  runCommand?(command: string): Promise<void>;
}

const ALWAYS_SKIPPED = ['postgres', 'template0', 'template1'];

function userOf(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).username) || null;
  } catch {
    return null;
  }
}

/** The same server, a different database: how per-database tools are pointed. */
function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(db)}`;
  return u.toString();
}

async function run(bin: string, args: string[], input?: string): Promise<string> {
  try {
    const child = exec(bin, args, { maxBuffer: 256 * 1024 * 1024 });
    if (input !== undefined) {
      child.child.stdin?.end(input);
    }
    const { stdout } = await child;
    return stdout;
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message?: string };
    if (e.code === 'ENOENT') {
      throw new Error(`${bin} is not installed. The TapThat image includes the Postgres client; on npx, install postgresql-client.`);
    }
    throw new Error(scrub(`${bin} failed: ${(e.stderr || e.message || String(err)).trim()}`));
  }
}

async function psql(url: string, sql: string): Promise<string> {
  return run('psql', ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-At', '-d', url, '-c', sql]);
}

async function listDatabases(url: string, exclude: string[]): Promise<string[]> {
  const out = await psql(url, 'select datname from pg_database where not datistemplate order by datname');
  const skip = new Set([...ALWAYS_SKIPPED, ...exclude]);
  return out.split('\n').map((s) => s.trim()).filter((d) => d && !skip.has(d));
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Roles as `pg_dumpall --roles-only` writes them, minus the two connecting
 * users: replaying the source's superuser onto the target would change the
 * password the playground itself logs in with.
 */
function filterRoles(sql: string, skip: Set<string>): string {
  return sql
    .split('\n')
    .filter((line) => {
      const m = /^(?:CREATE|ALTER) ROLE (?:"((?:[^"]|"")+)"|([^\s;]+))/.exec(line);
      const name = m ? (m[1] ?? m[2])!.replace(/""/g, '"') : null;
      return !(name && (skip.has(name) || name.startsWith('pg_')));
    })
    .join('\n');
}

async function dumpRoles(source: string, progress: Progress): Promise<{ sql: string; passwords: boolean }> {
  try {
    return { sql: await run('pg_dumpall', ['--roles-only', '-d', source]), passwords: true };
  } catch (err) {
    // Reading password hashes needs pg_read_all_data (or a superuser). Without
    // it, roles still come across — but an app that logs into its own
    // databases with them (Dealroom's data rooms) won't be able to.
    if (!/pg_authid|permission denied/i.test(String(err))) throw err;
    progress('The source user cannot read role passwords; copying roles without them.');
    return { sql: await run('pg_dumpall', ['--roles-only', '--no-role-passwords', '-d', source]), passwords: false };
  }
}

/** FLUSHDB over RESP, so the image needs no Redis client. */
async function flushRedis(url: string): Promise<void> {
  const u = new URL(url);
  const tls = u.protocol === 'rediss:';
  const port = Number(u.port || 6379);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const db = Number(u.pathname.slice(1) || 0);
  const password = decodeURIComponent(u.password);
  const user = decodeURIComponent(u.username);
  const cmd = (...parts: string[]) => `*${parts.length}\r\n${parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join('')}`;
  const commands = [
    ...(password ? [user && user !== 'default' ? cmd('AUTH', user, password) : cmd('AUTH', password)] : []),
    ...(db ? [cmd('SELECT', String(db))] : []),
    cmd('FLUSHDB'),
  ];
  await new Promise<void>((done, fail) => {
    const socket: Socket = tls ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
    let replies = 0;
    let buffer = '';
    socket.setTimeout(10_000, () => {
      socket.destroy();
      fail(new Error('Redis did not answer in time'));
    });
    socket.on('connect', () => socket.write(commands.join('')));
    socket.on('secureConnect', () => socket.write(commands.join('')));
    socket.on('data', (d) => {
      buffer += d.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('-')) {
          socket.destroy();
          fail(new Error(`Redis refused: ${line.slice(1)}`));
          return;
        }
        if (line.startsWith('+')) replies++;
      }
      if (replies >= commands.length) {
        socket.end();
        done();
      }
    });
    socket.on('error', fail);
  });
}

interface Manifest {
  takenAt: string;
  databases: string[];
  rolesWithPasswords: boolean;
}

export function makeSnapshotHooks(deps: SnapshotDeps): SessionHooks {
  const { snapshot } = deps;
  addSecret(snapshot.source);
  addSecret(snapshot.target);
  const current = join(deps.dir, 'current');

  async function restore(progress: Progress, what: 'Loading into the playground' | 'Restoring'): Promise<void> {
    const manifest = JSON.parse(await readFile(join(current, 'manifest.json'), 'utf8')) as Manifest;
    const steps = manifest.databases.length;

    for (const name of snapshot.stopServers) await deps.stopServer(name);
    try {
      const keep = new Set([userOf(snapshot.target), userOf(snapshot.source)].filter((u): u is string => !!u));
      const roles = filterRoles(await readFile(join(current, 'roles.sql'), 'utf8'), keep);
      // Roles that already exist fail their CREATE and still get their ALTER.
      await run('psql', ['--no-psqlrc', '-q', '-d', snapshot.target], roles).catch(() => {});

      // The playground ends up with exactly dev's databases: rooms created
      // during a session are dropped with it.
      const existing = await listDatabases(snapshot.target, snapshot.exclude);
      for (const db of existing.filter((d) => !manifest.databases.includes(d))) {
        await psql(snapshot.target, `DROP DATABASE IF EXISTS ${quoteIdent(db)} WITH (FORCE)`);
      }
      for (const [i, db] of manifest.databases.entries()) {
        progress(`${what}… ${db}`, i + 1, steps);
        // WITH (FORCE) ends the connections of services that stayed up (auth,
        // storage); they reconnect on their next query.
        await psql(snapshot.target, `DROP DATABASE IF EXISTS ${quoteIdent(db)} WITH (FORCE)`);
        await run('pg_restore', ['--create', '--exit-on-error', '-d', withDatabase(snapshot.target, 'postgres'), join(current, `${db}.dump`)]);
      }

      if (snapshot.redisUrl) {
        progress('Clearing the playground cache…');
        await flushRedis(snapshot.redisUrl);
      }
      progress('Running migrations…');
      await deps.prepare();
    } finally {
      for (const name of snapshot.stopServers) deps.startServer(name);
    }
  }

  return {
    async onStart(progress) {
      progress('Reading dev\'s databases…');
      const databases = await listDatabases(snapshot.source, snapshot.exclude);
      await rm(current, { recursive: true, force: true });
      await mkdir(current, { recursive: true });

      const roles = await dumpRoles(snapshot.source, progress);
      await writeFile(join(current, 'roles.sql'), roles.sql);
      for (const [i, db] of databases.entries()) {
        progress(`Copying data from dev… ${db}`, i + 1, databases.length);
        await run('pg_dump', ['-Fc', '-f', join(current, `${db}.dump`), '-d', withDatabase(snapshot.source, db)]);
      }
      const manifest: Manifest = { takenAt: new Date().toISOString(), databases, rolesWithPasswords: roles.passwords };
      await writeFile(join(current, 'manifest.json'), JSON.stringify(manifest, null, 2));

      await restore(progress, 'Loading into the playground');
      for (const command of deps.onStart ?? []) {
        progress(`Running ${command}…`);
        await deps.runCommand?.(command);
      }
      progress(`Copied ${databases.length} database${databases.length === 1 ? '' : 's'} from dev.`);
    },

    async onDiscard(progress) {
      const taken = await readFile(join(current, 'manifest.json'), 'utf8').then(() => true, () => false);
      if (!taken) {
        // The session failed before its copy existed, so there is nothing to go back to.
        progress('No data copy was taken for this session; the data is left as it is.');
        return;
      }
      progress('Resetting the data to the session\'s start…');
      await restore(progress, 'Restoring');
    },
  };
}
