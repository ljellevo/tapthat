import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeAgentRunner, credentialKind } from './agent';
import { loadConfig, CONFIG_FILENAME } from './config';
import { deriveKey } from './credentials';
import { startDevServer, waitForDevServer } from './dev-server';
import { detectPlatform } from './guard';
import { createHttpServer, ROUTE_PREFIX } from './http';
import { Store } from './store';
import { sequencer } from './events';
import { assertNotProduction } from './guard';
import { runJob, type BatchRequest } from './job';
import { Repo } from './repo';
import { makeVerifier } from './verify';

const USAGE = `tapthat-sidecar — apply TapThat comments to this repo with a coding agent

  tapthat-sidecar serve                   start the HTTP API (default)
  tapthat-sidecar run-file <batch.json>   run one batch from a file (no HTTP)
  tapthat-sidecar doctor                  check config, repo and agent CLI

Development tool only. Requires TAPTHAT_ENABLE=1.`;

const VERSION = '0.1.0';

function credentialFromEnv() {
  const raw = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!raw) return null;
  const kind = credentialKind(raw);
  return kind ? { raw, kind } : null;
}

async function cmdRunFile(path: string): Promise<number> {
  const cwd = process.cwd();
  const { config, problems, source } = await loadConfig(cwd);
  if (problems.length) {
    console.error(`Configuration problems${source ? ` in ${source}` : ''}:`);
    for (const p of problems) console.error(`  - ${p}`);
    return 78;
  }

  const failure = await preflight(config);
  if (failure) {
    console.error(failure);
    return 78;
  }
  const repo = new Repo(config.repoRoot);

  const batch = JSON.parse(await readFile(resolve(cwd, path), 'utf8')) as BatchRequest;
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

/** Boot checks shared by serve and run-file. Returns null when everything holds. */
async function preflight(config: Awaited<ReturnType<typeof loadConfig>>['config']): Promise<string | null> {
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

async function cmdServe(): Promise<number> {
  const cwd = process.cwd();
  const { config, problems, source } = await loadConfig(cwd);
  if (problems.length) {
    console.error(`Configuration problems${source ? ` in ${source}` : ''}:`);
    for (const p of problems) console.error(`  - ${p}`);
    return 78;
  }

  const failure = await preflight(config);
  if (failure) {
    console.error(failure);
    return 78;
  }

  const token = process.env.TAPTHAT_TOKEN ?? null;
  if (config.auth.mode === 'token' && !token) {
    console.error(
      'TAPTHAT_TOKEN is not set.\n\n' +
        'This endpoint accepts instructions that modify your repository, so it will not\n' +
        'start unauthenticated. Generate one with `openssl rand -base64 32`, or set\n' +
        'auth.mode to "none" (permitted only when bound to loopback).',
    );
    return 78;
  }

  const repo = new Repo(config.repoRoot);
  const store = await Store.open(Store.defaultPath(config.repoRoot));
  const encryptionKey = deriveKey(process.env.TAPTHAT_ENCRYPTION_KEY);
  if (!encryptionKey) {
    console.warn('[tapthat] TAPTHAT_ENCRYPTION_KEY is not set — credentials cannot be stored.');
  }

  let dev: ReturnType<typeof startDevServer> | null = null;
  if (config.devServer.start && config.devServer.command) {
    console.log(`[tapthat] starting dev server: ${config.devServer.command}`);
    dev = startDevServer(config.devServer.command, config.repoRoot, config.devServerUrl);
    const ready = await waitForDevServer(config.devServerUrl, config.devServer.readyTimeoutMs);
    if (!ready) console.warn(`[tapthat] dev server did not answer at ${config.devServerUrl} yet; continuing`);
  }

  const server = createHttpServer({
    config,
    repo,
    store,
    encryptionKey,
    token,
    envCredential: credentialFromEnv(),
    version: VERSION,
  });

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));

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
  console.log(`  agent   ${config.agent.command} [${config.agent.allowedTools}]`);
  console.log(`  proxy   ${config.proxy.enabled ? `on → ${config.proxy.target ?? config.devServerUrl}` : 'off'}`);
  console.log(`  origins ${config.allowedOrigins.join(', ') || '(none — Apply will be refused)'}`);
  console.log('');
  console.log('  Paste into the extension options page:');
  console.log(`    Sidecar URL  ${sidecarUrl}`);
  console.log(`    Token        ${token ?? '(auth disabled)'}`);
  if (platform && config.git.push) {
    console.log('');
    console.log(`  ⚠ ${platform} redeploys on push. git.push is enabled, so every applied`);
    console.log('    batch will restart this service and interrupt the reviewer mid-session.');
  }
  console.log('');

  const shutdown = () => {
    dev?.stop();
    server.close(() => {
      void store.flush().then(() => process.exit(0));
    });
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
  console.log(`credential: ${credentialFromEnv() ? 'found in env' : 'none in env'}`);

  for (const p of problems) console.error(`  ✗ ${p}`);
  return problems.length ? 78 : 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }

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
    case 'doctor':
      return cmdDoctor();
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

process.exit(await main());
