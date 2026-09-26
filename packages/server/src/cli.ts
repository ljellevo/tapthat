import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { credentialKind, makeAgentRunner } from './agent';
import { createAudit } from './audit';
import { CONFIG_FILENAME, loadConfig, type Config, type RepoConfig } from './config';
import { deriveKey } from './credentials';
import { DevServers, waitForDevServer } from './dev-server';
import { sequencer } from './events';
import { assertNotProduction, detectPlatform } from './guard';
import { createHttpServer, ROUTE_PREFIX } from './http';
import { runJob, type BatchRequest } from './job';
import { addSecret } from './log';
import { Repo } from './repo';
import { makeSnapshotHooks } from './snapshot';
import { Store } from './store';
import { Workspace } from './workspace';

const USAGE = `tapthat-server — apply TapThat comments to this repo with a coding agent

  tapthat-server init                    write tapthat.config.json and generate secrets
  tapthat-server serve                   start the HTTP API (default)
  tapthat-server run-file <batch.json>   run one batch from a file (no HTTP)
  tapthat-server doctor                  check config, repo and agent CLI
  tapthat-server audit-prod              fail if the sidecar is in a production dependency tree

Development tool only. serve and run-file require TAPTHAT_ENABLE=1.`;

const VERSION = '0.1.0';
const SECRETS_FILE = join('.tapthat', 'secrets.env');

const execFileP = promisify(execFile);

function credentialFromEnv() {
  const raw = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!raw) return null;
  const kind = credentialKind(raw);
  return kind ? { raw, kind } : null;
}

/**
 * Loads `.tapthat/secrets.env`, written by `init`, without overriding anything
 * already in the environment. The safety latch and NODE_ENV are never taken
 * from it: starting the sidecar has to stay an explicit act.
 */
async function loadSecretsFile(cwd: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(join(cwd, SECRETS_FILE), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    const [, key, value] = match as unknown as [string, string, string];
    if (key === 'TAPTHAT_ENABLE' || key === 'NODE_ENV') continue;
    if (process.env[key] === undefined) process.env[key] = value.replace(/^["']|["']$/g, '');
  }
}

async function readConfig(cwd = process.cwd(), provisional = false): Promise<Config | null> {
  const { config, problems, source } = await loadConfig(cwd, process.env, { provisional });
  if (problems.length) {
    console.error(`Configuration problems${source ? ` in ${source}` : ''}:`);
    for (const p of problems) console.error(`  - ${p}`);
    return null;
  }
  return config;
}

/**
 * Makes sure repoRoot holds a checkout. On the npx and Compose paths it already
 * does and this only checks. On a PaaS the container starts with an empty
 * volume, so it clones — and on later boots fast-forwards a clean tree, never
 * resetting one.
 */
async function bootstrapOne(repoConfig: RepoConfig, remote: string, gitToken: string | null): Promise<string | null> {
  const { root, url, branch, name } = repoConfig;
  const repo = new Repo(root, gitToken);
  const problem = await repo.worktreeProblem();

  if (problem) {
    if (!url) return problem;
    const entries = existsSync(root) ? await readdir(root) : [];
    if (entries.some((e) => e !== 'lost+found')) {
      return `${root} is not empty and not a git checkout, so it cannot be cloned into.`;
    }
    console.log(`[tapthat] cloning ${name}: ${url} (${branch}) into ${root}`);
    try {
      await mkdir(root, { recursive: true });
      await Repo.clone(url, branch, root, gitToken);
    } catch (err) {
      const stderr = String((err as { stderr?: string }).stderr ?? err).trim();
      return `Could not clone ${url}:\n  ${stderr}\nIf the repository is private, set TAPTHAT_GIT_TOKEN (it must be able to read every repo in the workspace).`;
    }
    return null;
  }

  // Only a checkout on its base branch follows the remote. One on a session
  // branch is mid-session: moving it would change what reviewers are looking at.
  if (url && (await repo.branch().catch(() => null)) === branch) {
    const skipped = await repo.fastForward(remote, branch).catch((err) => String(err));
    if (skipped) console.warn(`[tapthat] ${name}: ${skipped}`);
  }
  return null;
}

/**
 * Makes sure every repository has a checkout. On the npx and Compose paths they
 * already do and this only checks. On a PaaS the container starts with an empty
 * volume, so it clones — and on later boots fast-forwards a clean tree, never
 * resetting one. `done` remembers roots already handled, because the primary
 * is bootstrapped before its committed config names the others.
 */
async function bootstrapRepos(config: Config, gitToken: string | null, done: Set<string>): Promise<string | null> {
  for (const repoConfig of config.repos) {
    if (done.has(repoConfig.root)) continue;
    const problem = await bootstrapOne(repoConfig, config.git.remote, gitToken);
    if (problem) return problem;
    done.add(repoConfig.root);
  }
  return null;
}

/**
 * Boot checks shared by serve and run-file. Returns null when everything holds.
 * `sessionBranch` is also acceptable while a playground session is active.
 */
async function preflight(config: Config, sessionBranch: string | null = null): Promise<string | null> {
  for (const repoConfig of config.repos) {
    const repo = new Repo(repoConfig.root);
    const worktreeProblem = await repo.worktreeProblem();
    if (worktreeProblem) return worktreeProblem;

    // An agent editing a branch nobody is looking at is the worst silent failure
    // in this system, so a mismatch is fatal rather than a warning.
    const checkedOut = await repo.branch();
    if (checkedOut !== repoConfig.branch && checkedOut !== sessionBranch) {
      const which = config.repos.length > 1 ? ` (${repoConfig.name})` : '';
      return (
        `Branch mismatch${which}: ${CONFIG_FILENAME} targets "${repoConfig.branch}" but ${repoConfig.root} has "${checkedOut}" checked out.\n` +
        `Check out "${repoConfig.branch}", or set TAPTHAT_BRANCH=${checkedOut}.`
      );
    }
  }
  return null;
}

/**
 * The state directory holds sealed credentials and the audit log. When it sits
 * inside the checkout it must never be committed — by the agent's commits or by
 * a developer's `git add -A` — so it goes into .git/info/exclude, which touches
 * no tracked file.
 */
async function excludeStateDir(config: Config): Promise<void> {
  const dir = Store.defaultDir(config.repoRoot);
  for (const { root } of config.repos) {
    const rel = relative(root, dir);
    if (rel.startsWith('..') || resolve(root, rel) !== resolve(dir)) continue;
    const exclude = join(root, '.git', 'info', 'exclude');
    const current = await readFile(exclude, 'utf8').catch(() => '');
    const entry = `/${rel}/`;
    if (current.split('\n').includes(entry)) continue;
    await mkdir(join(root, '.git', 'info'), { recursive: true }).catch(() => {});
    await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`).catch(() => {});
  }
}

async function probeAgent(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(command, ['--version'], { timeout: 15_000 });
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Runs the install command unless the lockfile is unchanged since the last
 * successful install. A PaaS restarts the container often, and a full `npm ci`
 * on every boot turns a restart into minutes of downtime for the reviewer.
 */
async function installIfNeeded(config: Config, repoConfig: RepoConfig): Promise<boolean> {
  const command = repoConfig.devServer!.install!;
  const root = repoConfig.root;
  const hash = createHash('sha256').update(command);
  for (const file of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'package.json']) {
    hash.update(await readFile(join(root, file)).catch(() => Buffer.alloc(0)));
  }
  const digest = hash.digest('hex');
  // One marker per repo; the single-repo name is kept so an upgrade does not reinstall.
  const markerName = config.repos.length > 1 ? `install-${repoConfig.name}.sha256` : 'install.sha256';
  const marker = join(Store.defaultDir(config.repoRoot), markerName);
  const installed = existsSync(join(root, 'node_modules'));
  if (installed && (await readFile(marker, 'utf8').catch(() => '')) === digest) {
    console.log(`[tapthat] ${repoConfig.name}: dependencies unchanged since the last install; skipping it`);
    return true;
  }
  console.log(`[tapthat] ${repoConfig.name}: installing: ${command}`);
  if ((await runShell(command, root, repoConfig.devServer!.env)) !== 0) return false;
  await mkdir(Store.defaultDir(config.repoRoot), { recursive: true });
  await writeFile(marker, digest);
  return true;
}

/** `prepare` (migrations and the like) runs on every boot; it must be idempotent. */
async function prepareAll(config: Config): Promise<boolean> {
  for (const r of config.repos) {
    if (!r.devServer?.prepare) continue;
    console.log(`[tapthat] ${r.name}: preparing: ${r.devServer.prepare}`);
    if ((await runShell(r.devServer.prepare, r.root, r.devServer.env)) !== 0) {
      console.error(`[tapthat] ${r.name}: "${r.devServer.prepare}" failed`);
      return false;
    }
  }
  return true;
}

function runShell(command: string, cwd: string, env: Record<string, string> = {}): Promise<number> {
  return new Promise((done) => {
    const child = spawn(command, { cwd, shell: true, stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('exit', (code) => done(code ?? 1));
    child.on('error', () => done(1));
  });
}

// ── commands ────────────────────────────────────────────────────────────────

async function cmdRunFile(path: string): Promise<number> {
  const config = await readConfig();
  if (!config) return 78;

  const failure = await preflight(config);
  if (failure) {
    console.error(failure);
    return 78;
  }
  const workspace = Workspace.fromConfig(config);

  const batch = JSON.parse(await readFile(resolve(process.cwd(), path), 'utf8')) as BatchRequest;
  const emit = sequencer((event) => {
    const detail = event.message ?? (event.files ? event.files.join(', ') : '') ?? '';
    console.log(`[${String(event.seq).padStart(2, '0')}] ${event.type}${detail ? ` — ${detail}` : ''}`);
    if (event.output) console.log(event.output);
  });

  const result = await runJob(
    batch,
    {
      workspace,
      config: {
        allowDirty: config.git.allowDirty,
        git: { enabled: config.git.enabled, author: config.git.author },
        timeoutMs: config.agent.timeoutMs,
        maxCommentsPerBatch: config.agent.maxCommentsPerBatch,
        rules: config.agent.rules,
      },
      runAgent: makeAgentRunner({
        config,
        credential: credentialFromEnv(),
        onMessage: (text) => console.log(`     ${text.split('\n')[0]!.slice(0, 120)}`),
      }),
    },
    emit,
  );

  console.log(`\nstate: ${result.state}`);
  if (result.filesChanged.length) console.log(`files: ${result.filesChanged.join(', ')}`);
  for (const c of result.commits ?? []) console.log(`commit: ${workspace.multi ? `${c.repo} ` : ''}${c.sha}`);
  if (result.summary) console.log(`summary: ${result.summary}`);
  if (result.error) console.error(`error (${result.error.kind}): ${result.error.message}`);

  return result.state === 'failed' ? 1 : 0;
}

async function cmdServe(): Promise<number> {
  let config = await readConfig(process.cwd(), true);
  if (!config) return 78;

  const token = process.env.TAPTHAT_TOKEN ?? null;
  if (config.auth.mode === 'token' && !token) {
    console.error(
      'TAPTHAT_TOKEN is not set.\n\n' +
        'This endpoint accepts instructions that modify your repository, so it will not\n' +
        'start unauthenticated. Run `npx tapthat-server init` to generate one, or set\n' +
        'auth.mode to "none" (permitted only when bound to loopback).',
    );
    return 78;
  }

  const gitToken = process.env.TAPTHAT_GIT_TOKEN ?? null;
  if (gitToken) addSecret(gitToken);
  const bootstrapped = new Set<string>();
  const bootProblem = await bootstrapRepos(config, gitToken, bootstrapped);
  if (bootProblem) {
    console.error(bootProblem);
    return 78;
  }

  // On a PaaS the process starts outside the checkout, configured by env alone.
  // Once the clone exists, the project's own committed tapthat.config.json is
  // the base layer, with the env still on top — and it may name more repos.
  if (!existsSync(join(process.cwd(), CONFIG_FILENAME)) && existsSync(join(config.repoRoot, CONFIG_FILENAME))) {
    const fromRepo = await readConfig(config.repoRoot);
    if (!fromRepo) return 78;
    config = fromRepo;
    const moreProblems = await bootstrapRepos(config, gitToken, bootstrapped);
    if (moreProblems) {
      console.error(moreProblems);
      return 78;
    }
  } else {
    // No committed config after all: the environment is the whole config, so
    // hold it to the full rules.
    const final = await readConfig(process.cwd());
    if (!final) return 78;
    config = final;
  }

  const store = await Store.open(Store.defaultPath(config.repoRoot));
  const session = store.getSession();
  const failure = await preflight(config, session && session.state !== 'failed' ? session.branch : null);
  if (failure) {
    console.error(failure);
    return 78;
  }

  await excludeStateDir(config);
  const workspace = Workspace.fromConfig(config, gitToken);
  const repo = workspace.primary.repo;
  const audit = createAudit(join(Store.defaultDir(config.repoRoot), 'audit.log'));
  const encryptionKey = deriveKey(process.env.TAPTHAT_ENCRYPTION_KEY);
  if (!encryptionKey) {
    console.warn('[tapthat] TAPTHAT_ENCRYPTION_KEY is not set — credentials cannot be stored.');
  }

  const agentVersion = await probeAgent(config.agent.command);
  if (!agentVersion) {
    console.warn(
      `[tapthat] "${config.agent.command} --version" failed. Install the Claude Code CLI ` +
        '(npm i -g @anthropic-ai/claude-code) or every batch will fail.',
    );
  }

  for (const r of config.repos) {
    if (r.devServer?.install && !(await installIfNeeded(config, r))) {
      console.error(`[tapthat] ${r.name}: "${r.devServer.install}" failed; its dev server cannot start without it.`);
      return 1;
    }
  }
  if (!(await prepareAll(config))) return 1;

  const servers = new DevServers(
    config.devServer.start
      ? config.repos
          .filter((r) => r.devServer?.command)
          .map((r) => ({ name: r.name, command: r.devServer!.command!, cwd: r.root, url: r.devServer!.url, env: r.devServer!.env }))
      : [],
  );
  servers.startAll();

  const snapshot = config.session.snapshot;
  const sessionHooks = snapshot
    ? makeSnapshotHooks({
        snapshot,
        dir: join(Store.defaultDir(config.repoRoot), 'snapshots'),
        stopServer: (name) => servers.stop(name),
        startServer: (name) => servers.start(name),
        prepare: async () => {
          if (!(await prepareAll(config))) throw new Error('A prepare command failed after the data was copied; see the service log.');
        },
        onStart: config.session.onStart,
        runCommand: async (command) => {
          if ((await runShell(command, config.workspaceRoot)) !== 0) throw new Error(`"${command}" failed`);
        },
      })
    : undefined;

  const server = createHttpServer({
    config,
    repo,
    sessionHooks,
    store,
    encryptionKey,
    token,
    envCredential: credentialFromEnv(),
    version: VERSION,
    agentVersion,
    audit,
    workspace,
  });

  // Listen before the dev server is ready: a PaaS health check on the sidecar
  // must pass while a cold `next dev` is still compiling.
  await new Promise<void>((done) => server.listen(config.port, config.host, done));
  for (const r of config.repos) {
    if (!servers.isRunning(r.name)) continue;
    const ready = await waitForDevServer(r.devServer!.url, config.devServer.readyTimeoutMs);
    if (!ready) console.warn(`[tapthat] ${r.name} dev server did not answer at ${r.devServer!.url} yet; continuing`);
  }

  const platform = detectPlatform(process.env);
  const listenHost = config.host === '::' || config.host === '0.0.0.0' ? 'localhost' : config.host;
  const publicBase = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://${listenHost}:${config.port}`;
  // In proxy mode the app owns the path space, so only the prefix reaches us.
  const sidecarUrl = config.proxy.enabled ? `${publicBase}${ROUTE_PREFIX}` : publicBase;
  console.log('');
  console.log(`  TapThat sidecar ready on ${config.host}:${config.port}`);
  for (const e of workspace.entries) {
    const label = workspace.multi ? `repo    ${e.name.padEnd(8)}` : 'repo    ';
    // The branch actually checked out: mid-session, that is the session branch.
    const on = await e.repo.branch().catch(() => e.config?.branch ?? config.branch);
    console.log(`  ${label}${e.repo.root} @ ${on} (${await e.repo.head()})`);
  }
  console.log(`  agent   ${config.agent.command} ${agentVersion ?? '(not found)'} [${config.agent.allowedTools}]`);
  console.log(`  proxy   ${config.proxy.enabled ? `on → ${config.proxy.target ?? config.devServerUrl}` : 'off'}`);
  console.log(
    config.git.mode === 'session'
      ? `  mode    session — changes reach ${config.branch} on Commit, in order ${config.git.deployOrder.join(' → ') || 'as listed'}`
      : `  push    ${config.git.push ? `on → ${config.git.remote}/${config.branch}` : 'off'}`,
  );
  console.log(`  origins ${config.allowedOrigins.join(', ') || '(none — Apply will be refused)'}`);
  console.log('');
  console.log('  Paste into the extension options page:');
  console.log(`    Sidecar URL  ${sidecarUrl}`);
  console.log(`    Token        ${token ? `${token.slice(0, 4)}… (TAPTHAT_TOKEN)` : '(auth disabled)'}`);
  if (platform && config.git.push && config.git.mode === 'commit') {
    console.log('');
    console.log(`  ⚠ ${platform} redeploys on push. git.push is enabled, so if this service`);
    console.log(`    deploys from "${config.branch}", every applied batch will restart it and`);
    console.log('    interrupt the reviewer mid-session. See docs/setup.md, "Railway".');
  }
  console.log('');

  const shutdown = () => {
    void servers.stopAll();
    server.close(() => {
      void store.flush().then(() => process.exit(0));
    });
    // SSE connections keep close() waiting; don't hang a redeploy on them.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
  return 0;
}

async function cmdDoctor(): Promise<number> {
  const { config, problems, source } = await loadConfig(process.cwd());
  console.log(`config: ${source ?? 'defaults (no tapthat.config.json found)'}`);
  console.log(`repo:   ${config.repoRoot}`);
  console.log(`branch: ${config.branch}`);

  const repo = new Repo(config.repoRoot);
  const worktreeProblem = await repo.worktreeProblem();
  if (worktreeProblem) {
    console.error(`  ✗ ${worktreeProblem}`);
    return 1;
  }
  console.log(`  head:     ${await repo.head()}`);
  console.log(`  checkout: ${await repo.branch()}`);
  console.log(`  clean:    ${await repo.isClean()}`);
  console.log(`agent:  ${(await probeAgent(config.agent.command)) ?? `✗ "${config.agent.command}" not found`}`);
  console.log(`credential: ${credentialFromEnv() ? 'found in env' : 'none in env (reviewers paste their own)'}`);
  console.log(`token:  ${process.env.TAPTHAT_TOKEN ? 'set' : '✗ TAPTHAT_TOKEN not set'}`);
  console.log(`key:    ${process.env.TAPTHAT_ENCRYPTION_KEY ? 'set' : '✗ TAPTHAT_ENCRYPTION_KEY not set'}`);

  for (const p of problems) console.error(`  ✗ ${p}`);
  return problems.length ? 78 : 0;
}

/** Best guess at the dev server from package.json, so init's defaults usually just work. */
async function guessDevServer(cwd: string): Promise<{ url: string; script: string | null; typecheck: boolean }> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const dev = pkg.scripts?.dev ?? '';
    const typecheck = !!pkg.scripts?.typecheck;
    const port = /--port[= ](\d+)/.exec(dev)?.[1];
    const guess = port
      ? Number(port)
      : /\bnext\b/.test(dev) ? 3000 : /\bastro\b/.test(dev) ? 4321 : /\bnuxt\b/.test(dev) ? 3000 : 5173;
    return { url: `http://localhost:${guess}`, script: dev ? 'npm run dev' : null, typecheck };
  } catch {
    return { url: 'http://localhost:5173', script: null, typecheck: false };
  }
}

async function cmdInit(): Promise<number> {
  const cwd = process.cwd();
  const repo = new Repo(cwd);
  const problem = await repo.worktreeProblem();
  if (problem) {
    console.error(`${problem}\nRun init in the root of the repository you want the agent to edit.`);
    return 1;
  }
  const branch = await repo.branch();
  const dev = await guessDevServer(cwd);

  const configPath = join(cwd, CONFIG_FILENAME);
  if (existsSync(configPath)) {
    console.log(`  kept     ${CONFIG_FILENAME} (already exists)`);
  } else {
    const config = {
      branch,
      devServerUrl: dev.url,
      allowedOrigins: [new URL(dev.url).origin],
      verifyCommand: dev.typecheck ? 'npm run typecheck' : null,
      git: { push: false },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`  wrote    ${CONFIG_FILENAME} (branch "${branch}", dev server ${dev.url})`);
  }

  const secretsPath = join(cwd, SECRETS_FILE);
  let token: string;
  if (existsSync(secretsPath)) {
    await loadSecretsFile(cwd);
    token = process.env.TAPTHAT_TOKEN ?? '(see .tapthat/secrets.env)';
    console.log(`  kept     ${SECRETS_FILE} (already exists)`);
  } else {
    token = randomBytes(24).toString('base64url');
    const key = randomBytes(32).toString('base64');
    await mkdir(join(cwd, '.tapthat'), { recursive: true });
    await writeFile(
      secretsPath,
      [
        '# Generated by `tapthat-server init`. Never commit this file.',
        '# The bearer token the extension sends, and the key that seals stored credentials.',
        `TAPTHAT_TOKEN=${token}`,
        `TAPTHAT_ENCRYPTION_KEY=${key}`,
        '',
      ].join('\n'),
    );
    await chmod(secretsPath, 0o600);
    console.log(`  wrote    ${SECRETS_FILE} (token + encryption key, mode 600)`);
  }

  // .tapthat/ holds sealed credentials and the audit log; it must never be committed.
  const gitignore = join(cwd, '.gitignore');
  const ignored = await readFile(gitignore, 'utf8').catch(() => '');
  if (!ignored.split('\n').some((l) => l.trim() === '.tapthat/' || l.trim() === '/.tapthat/')) {
    await appendFile(gitignore, `${ignored && !ignored.endsWith('\n') ? '\n' : ''}.tapthat/\n`);
    console.log('  updated  .gitignore (+ .tapthat/)');
  }

  console.log('');
  console.log('Next:');
  console.log(`  1. Start your dev server${dev.script ? ` (${dev.script})` : ''} on ${dev.url}.`);
  console.log('  2. Start the sidecar beside it:');
  console.log('       TAPTHAT_ENABLE=1 npx tapthat-server');
  console.log('  3. In the TapThat extension\'s options page, paste:');
  console.log('       Sidecar URL   http://localhost:7420');
  console.log(`       Token         ${token}`);
  console.log(`       Allowed sites ${new URL(dev.url).origin}`);
  console.log('');
  console.log(`Branch "${branch}" is what the agent will commit to. Check out a dev branch first if`);
  console.log('that is not what you want, and edit tapthat.config.json to match.');

  if (detectPlatform(process.env)) {
    console.log('');
    console.log(`⚠ ${detectPlatform(process.env)} detected. It redeploys on push: keep git.push off, or push`);
    console.log('  to a branch this service does not deploy from. See docs/setup.md, "Railway".');
  }
  return 0;
}

/**
 * The CI belt-and-braces for "never in production": fails when the sidecar is a
 * production dependency, or named in a Dockerfile or compose file that is not a
 * dev one. Run it in the target project's CI.
 */
async function cmdAuditProd(): Promise<number> {
  const cwd = process.cwd();
  const findings: string[] = [];

  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      if (pkg[field]?.['tapthat-server']) findings.push(`package.json lists tapthat-server in ${field}`);
    }
  } catch {
    /* no package.json: nothing to check there */
  }

  try {
    const { stdout } = await execFileP('npm', ['ls', 'tapthat-server', '--omit=dev', '--all', '--parseable'], { cwd });
    if (stdout.trim()) findings.push('npm ls --omit=dev finds tapthat-server in the production tree');
  } catch (err) {
    // npm ls exits 1 when the package is absent, which is the good case.
    const stdout = String((err as { stdout?: string }).stdout ?? '').trim();
    if (stdout) findings.push('npm ls --omit=dev finds tapthat-server in the production tree');
  }

  const isDevFile = (name: string) => /(^|[.-])dev([.-]|$)/i.test(name);
  for (const name of await readdir(cwd).catch(() => [] as string[])) {
    const deployFile = /^dockerfile/i.test(name) || /^(docker-)?compose.*\.ya?ml$/i.test(name) || /^(fly|railway|render)\.(toml|json|ya?ml)$/i.test(name);
    if (!deployFile || isDevFile(name)) continue;
    const text = await readFile(join(cwd, name), 'utf8').catch(() => '');
    if (/tapthat-server/.test(text)) findings.push(`${name} references the sidecar`);
  }

  if (findings.length) {
    console.error('✗ The TapThat sidecar is reachable from a production build:');
    for (const f of findings) console.error(`  - ${f}`);
    console.error('\nIt must be a devDependency and appear only in dev-only compose files (*.dev.yml).');
    return 1;
  }
  console.log('✓ tapthat-server is not in a production dependency tree or deploy file.');
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    return 0;
  }

  // These start nothing and touch no repository content beyond writing config.
  if (command === 'init') return cmdInit();
  if (command === 'audit-prod') return cmdAuditProd();

  await loadSecretsFile(process.cwd());
  if (command === 'doctor') return cmdDoctor();

  assertNotProduction();

  switch (command ?? 'serve') {
    case 'serve':
      return cmdServe();
    case 'run-file': {
      if (!rest[0]) {
        console.error('run-file needs a path to a batch JSON file.');
        return 1;
      }
      return cmdRunFile(rest[0]);
    }
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

process.exit(await main());
