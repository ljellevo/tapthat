import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeAgentRunner, credentialKind } from './agent';
import { loadConfig, CONFIG_FILENAME } from './config';
import { sequencer } from './events';
import { assertNotProduction } from './guard';
import { runJob, type BatchRequest } from './job';
import { Repo } from './repo';
import { makeVerifier } from './verify';

const USAGE = `tapthat-sidecar — apply TapThat comments to this repo with a coding agent

  tapthat-sidecar run-file <batch.json>   run one batch from a file (no HTTP)
  tapthat-sidecar doctor                  check config, repo and agent CLI

Development tool only. Requires TAPTHAT_ENABLE=1.`;

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

  const repo = new Repo(config.repoRoot);
  if (!(await repo.isGitWorktree())) {
    console.error(`${config.repoRoot} is not a git working tree.`);
    return 78;
  }

  // An agent editing a branch nobody is looking at is the worst silent failure
  // in this system, so a mismatch is fatal rather than a warning.
  const checkedOut = await repo.branch();
  if (checkedOut !== config.branch) {
    console.error(
      `Branch mismatch: ${CONFIG_FILENAME} targets "${config.branch}" but ${config.repoRoot} has "${checkedOut}" checked out.\n` +
        `Check out "${config.branch}", or set TAPTHAT_BRANCH=${checkedOut}.`,
    );
    return 78;
  }

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

async function cmdDoctor(): Promise<number> {
  const { config, problems, source } = await loadConfig(process.cwd());
  console.log(`config: ${source ?? 'defaults (no tapthat.config.json found)'}`);
  console.log(`repo:   ${config.repoRoot}`);
  console.log(`branch: ${config.branch}`);

  const repo = new Repo(config.repoRoot);
  if (!(await repo.isGitWorktree())) {
    console.error('  ✗ not a git working tree');
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

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  assertNotProduction();

  switch (command) {
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
