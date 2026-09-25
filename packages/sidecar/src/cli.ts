import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { credentialKind, makeAgentRunner } from './agent';
import { createAudit } from './audit';
import { CONFIG_FILENAME, loadConfig, type Config } from './config';
import { deriveKey } from './credentials';
import { startDevServer, waitForDevServer } from './dev-server';
import { sequencer } from './events';
import { assertNotProduction, detectPlatform } from './guard';
import { createHttpServer, ROUTE_PREFIX } from './http';
import { runJob, type BatchRequest } from './job';
import { addSecret } from './log';
import { Repo } from './repo';
import { Store } from './store';
import { makeVerifier } from './verify';

const USAGE = `tapthat-sidecar — apply TapThat comments to this repo with a coding agent

  tapthat-sidecar init                    write tapthat.config.json and generate secrets
  tapthat-sidecar serve                   start the HTTP API (default)
  tapthat-sidecar run-file <batch.json>   run one batch from a file (no HTTP)
  tapthat-sidecar doctor                  check config, repo and agent CLI
  tapthat-sidecar audit-prod              fail if the sidecar is in a production dependency tree

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

async function readConfig(cwd = process.cwd()): Promise<Config | null> {
  const { config, problems, source } = await loadConfig(cwd);
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
async function bootstrapRepo(config: Config, gitToken: string | null): Promise<string | null> {
  const repo = new Repo(config.repoRoot, gitToken);
  const problem = await repo.worktreeProblem();

  if (problem) {
    if (!config.repoUrl) return problem;
    const entries = existsSync(config.repoRoot) ? await readdir(config.repoRoot) : [];
    if (entries.some((e) => e !== 'lost+found')) {
      return `${config.repoRoot} is not empty and not a git checkout, so it cannot be cloned into.`;
    }
    console.log(`[tapthat] cloning ${config.repoUrl} (${config.branch}) into ${config.repoRoot}`);
    try {
      await mkdir(config.repoRoot, { recursive: true });
      await Repo.clone(config.repoUrl, config.branch, config.repoRoot, gitToken);
    } catch (err) {
      const stderr = String((err as { stderr?: string }).stderr ?? err).trim();
      return `Could not clone ${config.repoUrl}:\n  ${stderr}\nIf the repository is private, set TAPTHAT_GIT_TOKEN.`;
    }
    return null;
  }

  if (config.repoUrl) {
    const skipped = await repo.fastForward(config.git.remote, config.branch).catch((err) => String(err));
    if (skipped) console.warn(`[tapthat] ${skipped}`);
  }
  return null;
}

/** Boot checks shared by serve and run-file. Returns null when everything holds. */
async function preflight(config: Config): Promise<string | null> {
  const repo = new Repo(config.repoRoot);
  const worktreeProblem = await repo.worktreeProblem();
  if (worktreeProblem) return worktreeProblem;

  // An agent editing a branch nobody is looking at is the worst silent failure
  // in this system, so a mismatch is fatal rather than a warning.
  const checkedOut = await repo.branch();
  if (checkedOut !== config.branch) {
    return (
      `Branch mismatch: ${CONFIG_FILENAME} targets "${config.branch}" but ${config.repoRoot} has "${checkedOut}" checked out.\n` +
      `Check out "${config.branch}", or set TAPTHAT_BRANCH=${checkedOut}.`
    );
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
  const rel = relative(config.repoRoot, dir);
  if (rel.startsWith('..') || resolve(config.repoRoot, rel) !== resolve(dir)) return;
  const exclude = join(config.repoRoot, '.git', 'info', 'exclude');
  const current = await readFile(exclude, 'utf8').catch(() => '');
  const entry = `/${rel}/`;
  if (current.split('\n').includes(entry)) return;
  await mkdir(join(config.repoRoot, '.git', 'info'), { recursive: true }).catch(() => {});
  await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`).catch(() => {});
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
async function installIfNeeded(config: Config): Promise<boolean> {
  const command = config.devServer.install!;
  const hash = createHash('sha256').update(command);
  for (const file of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'package.json']) {
    hash.update(await readFile(join(config.repoRoot, file)).catch(() => Buffer.alloc(0)));
  }
  const digest = hash.digest('hex');
  const marker = join(Store.defaultDir(config.repoRoot), 'install.sha256');
  const installed = existsSync(join(config.repoRoot, 'node_modules'));
  if (installed && (await readFile(marker, 'utf8').catch(() => '')) === digest) {
    console.log('[tapthat] dependencies unchanged since the last install; skipping it');
    return true;
  }
  console.log(`[tapthat] installing: ${command}`);
  if ((await runShell(command, config.repoRoot)) !== 0) return false;
  await mkdir(Store.defaultDir(config.repoRoot), { recursive: true });
  await writeFile(marker, digest);
  return true;
}

function runShell(command: string, cwd: string): Promise<number> {
  return new Promise((done) => {
    const child = spawn(command, { cwd, shell: true, stdio: 'inherit' });
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
  const repo = new Repo(config.repoRoot);

  const batch = JSON.parse(await readFile(resolve(process.cwd(), path), 'utf8')) as BatchRequest;
  const emit = sequencer((event) => {
    const detail = event.message ?? (event.files ? event.files.join(', ') : '') ?? '';
    console.log(`[${String(event.seq).padStart(2, '0')}] ${event.type}${detail ? ` — ${detail}` : ''}`);
    if (event.output) console.log(event.output);
  });

  const result = await runJob(
    batch,
    {
      repo,
      config: {
        allowDirty: config.git.allowDirty,
        git: { enabled: config.git.enabled, author: config.git.author },
        timeoutMs: config.agent.timeoutMs,
        maxCommentsPerBatch: config.agent.maxCommentsPerBatch,
      },
      runAgent: makeAgentRunner({
        config,
        credential: credentialFromEnv(),
        onMessage: (text) => console.log(`     ${text.split('\n')[0]!.slice(0, 120)}`),
      }),
      verify: makeVerifier(config.verifyCommand, config.repoRoot),
    },
    emit,
  );

  console.log(`\nstate: ${result.state}`);
  if (result.filesChanged.length) console.log(`files: ${result.filesChanged.join(', ')}`);
  if (result.sha) console.log(`commit: ${result.sha}`);
  if (result.summary) console.log(`summary: ${result.summary}`);
  if (result.error) console.error(`error (${result.error.kind}): ${result.error.message}`);

  return result.state === 'failed' ? 1 : 0;
}

async function cmdServe(): Promise<number> {
  let config = await readConfig();
  if (!config) return 78;

  const token = process.env.TAPTHAT_TOKEN ?? null;
  if (config.auth.mode === 'token' && !token) {
    console.error(
      'TAPTHAT_TOKEN is not set.\n\n' +
        'This endpoint accepts instructions that modify your repository, so it will not\n' +
        'start unauthenticated. Run `npx tapthat-sidecar init` to generate one, or set\n' +
        'auth.mode to "none" (permitted only when bound to loopback).',
    );
    return 78;
  }

  const gitToken = process.env.TAPTHAT_GIT_TOKEN ?? null;
  if (gitToken) addSecret(gitToken);
  const bootProblem = await bootstrapRepo(config, gitToken);
  if (bootProblem) {
    console.error(bootProblem);
    return 78;
  }

  // On a PaaS the process starts outside the checkout, configured by env alone.
  // Once the clone exists, the project's own committed tapthat.config.json is
  // the base layer, with the env still on top.
  if (!existsSync(join(process.cwd(), CONFIG_FILENAME)) && existsSync(join(config.repoRoot, CONFIG_FILENAME))) {
    const fromRepo = await readConfig(config.repoRoot);
    if (!fromRepo) return 78;
    config = fromRepo;
  }

  const failure = await preflight(config);
  if (failure) {
    console.error(failure);
    return 78;
  }

  await excludeStateDir(config);
  const repo = new Repo(config.repoRoot, gitToken);
  const store = await Store.open(Store.defaultPath(config.repoRoot));
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

  if (config.devServer.install && !(await installIfNeeded(config))) {
    console.error(`[tapthat] "${config.devServer.install}" failed; the dev server cannot start without it.`);
    return 1;
  }

  let dev: ReturnType<typeof startDevServer> | null = null;
  if (config.devServer.start && config.devServer.command) {
    console.log(`[tapthat] starting dev server: ${config.devServer.command}`);
    dev = startDevServer(config.devServer.command, config.repoRoot, config.devServerUrl);
  }

  const server = createHttpServer({
    config,
    repo,
    store,
    encryptionKey,
    token,
    envCredential: credentialFromEnv(),
    version: VERSION,
    agentVersion,
    audit,
  });

  // Listen before the dev server is ready: a PaaS health check on the sidecar
  // must pass while a cold `next dev` is still compiling.
  await new Promise<void>((done) => server.listen(config.port, config.host, done));
  if (dev) {
    const ready = await waitForDevServer(config.devServerUrl, config.devServer.readyTimeoutMs);
    if (!ready) console.warn(`[tapthat] dev server did not answer at ${config.devServerUrl} yet; continuing`);
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
  console.log(`  repo    ${config.repoRoot} @ ${config.branch} (${await repo.head()})`);
  console.log(`  agent   ${config.agent.command} ${agentVersion ?? '(not found)'} [${config.agent.allowedTools}]`);
  console.log(`  proxy   ${config.proxy.enabled ? `on → ${config.proxy.target ?? config.devServerUrl}` : 'off'}`);
  console.log(`  push    ${config.git.push ? `on → ${config.git.remote}/${config.branch}` : 'off'}`);
  console.log(`  origins ${config.allowedOrigins.join(', ') || '(none — Apply will be refused)'}`);
  console.log('');
  console.log('  Paste into the extension options page:');
  console.log(`    Sidecar URL  ${sidecarUrl}`);
  console.log(`    Token        ${token ? `${token.slice(0, 4)}… (TAPTHAT_TOKEN)` : '(auth disabled)'}`);
  if (platform && config.git.push) {
    console.log('');
    console.log(`  ⚠ ${platform} redeploys on push. git.push is enabled, so if this service`);
    console.log(`    deploys from "${config.branch}", every applied batch will restart it and`);
    console.log('    interrupt the reviewer mid-session. See docs/setup.md, "Railway".');
  }
  console.log('');

  const shutdown = () => {
    dev?.stop();
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
        '# Generated by `tapthat-sidecar init`. Never commit this file.',
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
  console.log('       TAPTHAT_ENABLE=1 npx tapthat-sidecar');
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
      if (pkg[field]?.['@tapthat/sidecar']) findings.push(`package.json lists @tapthat/sidecar in ${field}`);
    }
  } catch {
    /* no package.json: nothing to check there */
  }

  try {
    const { stdout } = await execFileP('npm', ['ls', '@tapthat/sidecar', '--omit=dev', '--all', '--parseable'], { cwd });
    if (stdout.trim()) findings.push('npm ls --omit=dev finds @tapthat/sidecar in the production tree');
  } catch (err) {
    // npm ls exits 1 when the package is absent, which is the good case.
    const stdout = String((err as { stdout?: string }).stdout ?? '').trim();
    if (stdout) findings.push('npm ls --omit=dev finds @tapthat/sidecar in the production tree');
  }

  const isDevFile = (name: string) => /(^|[.-])dev([.-]|$)/i.test(name);
  for (const name of await readdir(cwd).catch(() => [] as string[])) {
    const deployFile = /^dockerfile/i.test(name) || /^(docker-)?compose.*\.ya?ml$/i.test(name) || /^(fly|railway|render)\.(toml|json|ya?ml)$/i.test(name);
    if (!deployFile || isDevFile(name)) continue;
    const text = await readFile(join(cwd, name), 'utf8').catch(() => '');
    if (/tapthat-sidecar|@tapthat\/sidecar/.test(text)) findings.push(`${name} references the sidecar`);
  }

  if (findings.length) {
    console.error('✗ The TapThat sidecar is reachable from a production build:');
    for (const f of findings) console.error(`  - ${f}`);
    console.error('\nIt must be a devDependency and appear only in dev-only compose files (*.dev.yml).');
    return 1;
  }
  console.log('✓ @tapthat/sidecar is not in a production dependency tree or deploy file.');
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
