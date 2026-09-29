/**
 * `tapthat-server install`: sets up a TapThat playground on Railway.
 *
 * Three questions (platform, dev branch, site), then everything else is
 * detected, listed, confirmed once and fixed. Every step checks before it
 * acts, so running it again is safe: on a finished setup it changes nothing,
 * and after a failure it picks up where it stopped.
 */
import { randomBytes } from 'node:crypto';
import { canPush, GitHub } from './github';
import {
  baseVariables,
  configPlaceholders,
  danglingReferences,
  devDatabaseUrl,
  environmentDeploying,
  IMAGE,
  isLiteralTemplate,
  isRepoService,
  keptRewrites,
  missingVariables,
  planWorkspace,
  REDIS_TEMPLATE_VARIABLES,
  type EdgeOptions,
  SIDECAR_PORT,
  suggestSite,
  WORKSPACE,
  type RepoFacts,
} from './model';
import { Railway, type EnvService, type Project } from './railway';
import { run, sleep } from './sh';
import { bold, cyan, dim, fail, green, heading, ok, PACE, Prompter, readAllStdin, say, todo, waitFor, warn, yellow } from './ui';

export const INSTALL_USAGE = `tapthat-server install — set up a TapThat playground environment

  Run it in a folder linked to your Railway project (or it links one).
  Asks for the platform, your dev branch and the site reviewers comment on;
  finds and fixes everything else, after one confirmation.

  --platform <name>     railway (the only one for now)
  --branch <name>       the dev branch Commit pushes to (asks; default dev)
  --site <service>      the service reviewers comment on (asks; suggests one).
                        A gateway in front of your sites works too: it stays,
                        and every service behind it runs in the workspace
  --playground <name>   the playground environment (default tapthat)
  --dry-run             show what would change, change nothing
  --yes                 accept defaults and the plan without asking
  --git-token-stdin     read the workspace's GitHub token from stdin

  Needs the Railway CLI (logged in) and the GitHub CLI (gh, logged in).`;

export interface InstallOptions {
  cwd: string;
  platform?: string;
  branch?: string;
  site?: string;
  playground: string;
  dryRun: boolean;
  yes: boolean;
  gitTokenStdin: boolean;
}

export function parseInstallArgs(args: string[], cwd: string): InstallOptions | string {
  const opts: InstallOptions = { cwd, playground: 'tapthat', dryRun: false, yes: false, gitTokenStdin: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = () => {
      const v = inline ?? args[++i];
      if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
      return v;
    };
    try {
      if (flag === '--platform') opts.platform = value();
      else if (flag === '--branch') opts.branch = value();
      else if (flag === '--site') opts.site = value();
      else if (flag === '--playground') opts.playground = value();
      else if (flag === '--dry-run') opts.dryRun = true;
      else if (flag === '--yes' || flag === '-y') opts.yes = true;
      else if (flag === '--git-token-stdin') opts.gitTokenStdin = true;
      else return `Unknown option: ${a}`;
    } catch (e) {
      return (e as Error).message;
    }
  }
  return opts;
}

interface Action {
  label: string;
  run: () => Promise<void>;
  /** Changes something outside the playground (dev), so the workspace needn't redeploy for it. */
  outside?: boolean;
}

const token = () => randomBytes(24).toString('base64url');
const key32 = () => randomBytes(32).toString('base64');

export async function install(opts: InstallOptions): Promise<number> {
  try {
    return await installInner(opts);
  } catch (e) {
    say();
    fail((e as Error).message);
    say(dim('  Nothing is half-done in a way that matters: fix the above and run the installer again.'));
    return 1;
  }
}

async function installInner(opts: InstallOptions): Promise<number> {
  const p = new Prompter(opts.yes);
  const rw = new Railway(opts.cwd);
  const gh = new GitHub();
  say(bold('TapThat installer') + (opts.dryRun ? yellow('  (dry run: nothing will change)') : ''));

  // ── 1. platform ──────────────────────────────────────────────────────────
  const platform = opts.platform ?? (await p.select('Where do your environments run?', [{ value: 'railway', label: 'Railway' }], 'railway'));
  if (platform.toLowerCase() !== 'railway') throw new Error(`Only Railway is supported for now (got "${platform}").`);

  heading('Tools');
  if (!(await rw.version())) throw new Error('The Railway CLI is not installed: https://docs.railway.com/cli (brew install railway)');
  if (!(await rw.capable())) throw new Error('This Railway CLI is too old for the installer. Update it: railway upgrade');
  if (!(await rw.loggedIn())) {
    if (opts.dryRun || !process.stdin.isTTY) throw new Error('Not logged in to Railway. Run: railway login');
    if (!(await rw.login())) throw new Error('Railway login did not complete.');
  }
  ok(`Railway CLI ${await rw.version()}, logged in`);
  if (!(await gh.available())) throw new Error('The GitHub CLI is not installed: https://cli.github.com (brew install gh)');
  if (!(await gh.loggedIn())) {
    if (opts.dryRun || !process.stdin.isTTY) throw new Error('Not logged in to GitHub. Run: gh auth login');
    if (!(await gh.login())) throw new Error('GitHub login did not complete.');
  }
  ok('GitHub CLI, logged in');

  let project = await rw.project();
  if (!project) {
    if (opts.dryRun || !process.stdin.isTTY) throw new Error('This folder is not linked to a Railway project. Run: railway link');
    say('  This folder is not linked to a Railway project; pick it:');
    await rw.link();
    project = await rw.project();
    if (!project) throw new Error('No Railway project linked.');
  }
  ok(`Railway project ${bold(project.name)}`);
  const envNames = project.environments.map((e) => e.name);

  // Re-reads the project each time, so services created along the way have names.
  const load = async (env: string) => rw.services((await rw.project()) ?? project!, env);
  const envs = await Promise.all(envNames.map(async (name) => ({ name, services: await load(name) })));
  const repoServices = new Map<string, EnvService>();
  for (const env of envs) for (const s of env.services.filter(isRepoService)) if (!repoServices.has(s.source.repo!)) repoServices.set(s.source.repo!, s);
  if (!repoServices.size) throw new Error(`No service in ${project.name} deploys from a GitHub repository.`);

  // ── 2. the dev branch ────────────────────────────────────────────────────
  heading('Dev branch');
  const branch = opts.branch ?? (await p.input('Which branch should reviewed changes go to?', 'dev'));
  const repos = [...repoServices.keys()].sort();
  const defaults = new Map<string, string>();
  const missingBranch: string[] = [];
  for (const repo of repos) {
    defaults.set(repo, await gh.defaultBranch(repo));
    if (!(await gh.branchSha(repo, branch))) missingBranch.push(repo);
  }
  if (!missingBranch.length) ok(`every repository has ${bold(branch)} (${repos.join(', ')})`);
  else {
    todo(`no ${bold(branch)} branch in ${missingBranch.join(', ')}`);
    if (opts.dryRun) say(dim(`  would offer to create it from each default branch`));
    else if (await p.confirm(`Create ${branch} in ${missingBranch.length === 1 ? missingBranch[0] : `these ${missingBranch.length} repositories`}, from ${missingBranch.length === 1 ? defaults.get(missingBranch[0]!) : 'each default branch'}?`)) {
      for (const repo of missingBranch) {
        await gh.createBranch(repo, branch, defaults.get(repo)!);
        ok(`${repo}: created ${branch} from ${defaults.get(repo)}`);
      }
    } else throw new Error(`TapThat commits to ${branch}; it has to exist in every repository first.`);
  }

  // ── 3. the environment that deploys it ───────────────────────────────────
  heading('Environments');
  const mostCommonDefault = mode([...defaults.values()]) ?? 'main';
  const sourceEnv = environmentDeploying(envs, mostCommonDefault) ?? (envNames.includes('production') ? 'production' : envs.find((e) => e.name !== opts.playground)?.name);
  if (!sourceEnv) throw new Error('No environment to start from.');
  let devEnv = environmentDeploying(envs.filter((e) => e.name !== opts.playground), branch);
  let devCreated = false;
  if (devEnv) ok(`${bold(devEnv)} deploys ${branch}`);
  else {
    const existing = envNames.includes(branch) ? branch : null;
    todo(existing ? `environment ${bold(existing)} does not deploy ${branch}` : `no environment deploys ${branch}`);
    const question = existing
      ? `Point every service in ${existing} at ${branch}?`
      : `Create environment ${bold(branch)} as a copy of ${bold(sourceEnv)}, deploying ${branch}?`;
    if (opts.dryRun) say(dim(`  would ask: ${question}`));
    else if (await p.confirm(question)) {
      const name = existing ?? branch;
      if (!existing) {
        await rw.createEnvironment(name, sourceEnv);
        await waitForServices(rw, project, name, envs.find((e) => e.name === sourceEnv)!.services.length);
        devCreated = true;
        ok(`created ${name} from ${sourceEnv}`);
      }
      const services = await load(name);
      await rw.editServices(name, services.filter(isRepoService).map((s) => [s.name, 'source.branch', branch]), `Deploy ${branch}`);
      ok(`${name}'s services deploy ${branch}`);
      devEnv = name;
    } else throw new Error(`The playground copies from the environment that deploys ${branch}; there has to be one.`);
  }
  const devName = devEnv ?? sourceEnv;
  let devServices = devEnv ? await load(devEnv) : envs.find((e) => e.name === sourceEnv)!.services;

  if (devCreated) {
    // A duplicate has the services but not their public domains.
    const source = envs.find((e) => e.name === sourceEnv)!.services;
    for (const s of devServices) {
      const had = source.find((x) => x.name === s.name)?.domains.length;
      if (had && !s.domains.length) {
        const url = await rw.createDomain(s.name, devName, Number(s.variables.PORT) || 8080);
        ok(`${s.name}: domain ${url ?? 'created'}`);
      }
    }
    devServices = await load(devName);
    warn(`${devName} starts with empty databases. Run your project's own database setup there (roles, migrations) before the first Start session.`);
  }

  // ── 4. the site ──────────────────────────────────────────────────────────
  heading('Site');
  const withDomains = new Set(devServices.filter((s) => s.domains.length).map((s) => s.name));
  const candidates = devServices.filter((s) => isRepoService(s) && withDomains.has(s.name));
  if (!candidates.length) throw new Error(`No service in ${devName} has a public domain to review.`);
  const site =
    opts.site ??
    (await p.select(
      'Which site do reviewers comment on?',
      candidates.map((s) => ({ value: s.name, label: `${s.name}  ${dim(s.domains[0] ?? '')}` })),
      suggestSite(devServices, withDomains) ?? undefined,
    ));
  const siteSpec = devServices.find((s) => s.name === site);
  if (siteSpec) ok(`${bold(site)} ${dim(siteSpec.domains[0] ?? '')}`);
  if (!siteSpec?.source.repo) throw new Error(`${site} is not a service built from a GitHub repository in ${devName}.`);

  // ── 5. the plan ──────────────────────────────────────────────────────────
  heading('Plan');
  const facts = new Map<string, RepoFacts>();
  const byRepo = new Map<string, RepoFacts>();
  const factsOf = async (name: string) => {
    const repo = devServices.find((s) => s.name === name)!.source.repo!;
    // A dry run leaves a missing branch missing: read what it would be created from.
    const ref = opts.dryRun && missingBranch.includes(repo) ? (defaults.get(repo) ?? branch) : branch;
    if (!byRepo.has(repo)) byRepo.set(repo, await gh.repoFacts(repo, ref));
    facts.set(name, byRepo.get(repo)!);
    return byRepo.get(repo)!;
  };
  const runs = (f: RepoFacts) => !!(f.scripts.dev || f.scripts.start);
  // A site that can't run as a dev server is a gateway in front of the real ones.
  let edge: EdgeOptions | undefined;
  if (!runs(await factsOf(site))) {
    for (const s of devServices.filter(isRepoService)) await factsOf(s.name);
    edge = { publicServices: [...withDomains].filter((n) => facts.has(n)).sort(), runnable: (n) => runs(facts.get(n) ?? { scripts: {}, lockfile: null }) };
  } else {
    const planTopology = planWorkspace({ services: devServices, site, branch, repoFacts: new Map() }).topology;
    for (const name of planTopology.included) await factsOf(name);
  }
  const plan = planWorkspace({ services: devServices, site, branch, repoFacts: facts, edge });
  const topo = plan.topology;
  say(`  The ${bold(opts.playground)} environment runs:`);
  if (topo.edge) say(`    ${cyan(site)}  as it runs in ${devName}, in front of the dev servers`);
  say(`    ${cyan(WORKSPACE)}  ${topo.included.map((n) => `${n} ${dim(`:${plan.ports.get(n)}`)}`).join(', ')} as live dev servers, and the agent`);
  if (topo.proxied) say(`    ${dim(`${topo.proxied} on the workspace's own domain`)}`);
  const alsoKept = topo.kept.filter((n) => n !== site || !topo.edge);
  if (alsoKept.length) say(`    ${alsoKept.join(', ')}  ${dim('as they run in ' + devName)}`);
  if (topo.dropped.length) say(`    ${dim(`not needed: ${topo.dropped.join(', ')}`)}`);
  for (const w of plan.warnings) warn(w);

  const actions: Action[] = [];
  const pgName = topo.postgres;
  const redisName = topo.redis;
  let devPasswordChanges = false;

  // dev's Postgres: the copy source, reached through a TCP proxy.
  if (pgName) {
    const raw = devServices.find((s) => s.name === pgName)!.variables;
    const rendered = await rw.rendered(pgName, devName);
    if (isLiteralTemplate(raw.POSTGRES_PASSWORD)) {
      devPasswordChanges = true;
      actions.push({
        label: `${devName}/${pgName}: replace the guessable superuser password (Railway stored its secret() template as text)`,
        run: () => rotatePostgres(rw, devName, pgName),
        outside: true,
      });
    }
    if (!rendered.RAILWAY_TCP_PROXY_DOMAIN) {
      actions.push({
        label: `${devName}/${pgName}: open a TCP proxy, so the playground can copy from it (strong password; the copy logs in as the superuser)`,
        run: async () => {
          await rw.createTcpProxy(pgName, devName, 5432);
          const up = await waitFor('waiting for the proxy', async () => ((await rw.rendered(pgName, devName)).RAILWAY_TCP_PROXY_DOMAIN ? true : null), 120_000, 3000);
          if (!up) throw new Error(`The TCP proxy on ${devName}/${pgName} did not appear. Run the installer again in a minute.`);
        },
        outside: true,
      });
    }
  }
  if (redisName) pushRedisFix(actions, rw, devName, devServices.find((s) => s.name === redisName)!, true);

  // tapthat.config.json in the primary repository: the site's, or behind a gateway the main app's.
  const siteRepo = devServices.find((s) => s.name === plan.primary)!.source.repo!;
  const existingText = await gh.file(siteRepo, 'tapthat.config.json', branch);
  let config: unknown = plan.config;
  if (existingText) {
    try {
      config = JSON.parse(existingText);
    } catch {
      throw new Error(`${siteRepo}/tapthat.config.json on ${branch} is not valid JSON. Fix it, or delete it to have one generated.`);
    }
    ok(`${siteRepo} has tapthat.config.json on ${branch} ${dim('(kept as it is)')}`);
  } else {
    actions.push({
      label: `commit a generated tapthat.config.json to ${siteRepo} on ${branch}`,
      run: () => gh.putFile(siteRepo, 'tapthat.config.json', branch, `${JSON.stringify(plan.config, null, 2)}\n`, 'Add tapthat.config.json (TapThat playground)'),
    });
  }

  // The playground.
  const playgroundEnv = envs.find((e) => e.name === opts.playground);
  let playground = playgroundEnv?.services ?? null;
  const playgroundCreated = !playground;
  if (!playground) {
    actions.push({
      label: `create environment ${bold(opts.playground)} as a copy of ${devName}, keeping ${[...topo.kept].join(', ') || 'nothing else'}`,
      run: async () => {
        await rw.createEnvironment(opts.playground, devName);
        playground = await waitForServices(rw, project!, opts.playground, devServices.length);
        for (const s of playground.filter((s) => !topo.kept.includes(s.name))) {
          await rw.deleteService(s.name, opts.playground);
        }
        playground = await load(opts.playground);
        // Railway can store its secret() template as text in the copy, even when dev's is fine.
        const pg = pgName && playground.find((s) => s.name === pgName);
        if (pg && isLiteralTemplate(pg.variables.POSTGRES_PASSWORD)) {
          await rotatePostgres(rw, opts.playground, pgName!);
          ok(`${opts.playground}/${pgName}: replaced the guessable superuser password Railway gave the copy`);
        }
      },
    });
  } else {
    ok(`environment ${bold(opts.playground)} exists`);
    // A kept service the playground lacks only matters if the config passes on a variable that uses it.
    for (const name of topo.kept.filter((n) => !playground!.some((s) => s.name === n))) {
      const used = usesOf(config, devServices, topo.included, name);
      if (used.length) warn(`${opts.playground} has no ${name}, but the config passes on ${used.join(', ')}, which ${used.length === 1 ? 'uses' : 'use'} it. Add ${name} to ${opts.playground}, or change the config.`);
    }
    const pg = pgName && playground.find((s) => s.name === pgName);
    if (pg && isLiteralTemplate(pg.variables.POSTGRES_PASSWORD)) {
      actions.push({
        label: `${opts.playground}/${pgName}: replace the guessable superuser password`,
        run: () => rotatePostgres(rw, opts.playground, pgName!),
      });
    }
    const redis = redisName && playground.find((s) => s.name === redisName);
    if (redis) pushRedisFix(actions, rw, opts.playground, redis);
  }

  // Kept services that still point at services the playground doesn't have.
  const rewriteKept = async () => {
    for (const [service, vars] of keptRewrites(playground!, topo, plan.ports)) {
      await rw.setPlain(service, opts.playground, vars);
      await rw.redeploy(service, opts.playground);
    }
  };
  if (!playground) {
    actions.push({ label: `point the kept services at the workspace where they referred to ${[...topo.included, ...topo.dropped].join('/')}`, run: rewriteKept });
  } else {
    const pending = keptRewrites(playground, topo, plan.ports);
    if (pending.size) {
      const what = [...pending].map(([svc, vars]) => `${svc} (${Object.keys(vars).join(', ')})`).join('; ');
      actions.push({ label: `point ${what} at the workspace instead of services the playground leaves out`, run: rewriteKept });
    }
  }

  // The workspace service.
  const workspace = playground?.find((s) => s.source.image?.includes('tapthat-server')) ?? playground?.find((s) => s.name === WORKSPACE);
  const wsName = workspace?.name ?? WORKSPACE;
  if (!workspace) {
    actions.push({
      label: `add the ${bold(WORKSPACE)} service (${IMAGE}) with a volume at /workspace`,
      run: async () => {
        const linkedEnv = await linkedEnvironment(rw);
        // Read now: dev may have been created earlier in this run.
        const others = ((await rw.project()) ?? project!).environments.map((e) => e.name).filter((e) => e !== opts.playground);
        const hadIt = new Set<string>();
        for (const e of others) if ((await load(e)).some((s) => s.name === WORKSPACE)) hadIt.add(e);
        await rw.linkTo(project!, opts.playground);
        try {
          await rw.addImageService(WORKSPACE, IMAGE);
          await waitForServices(rw, project!, opts.playground, 1, (s) => s.some((x) => x.name === WORKSPACE));
          await rw.linkTo(project!, opts.playground, WORKSPACE);
          await rw.addVolume('/workspace');
        } finally {
          // Leave the folder linked the way it was.
          if (linkedEnv) await rw.linkTo(project!, linkedEnv).catch(() => undefined);
        }
        // The workspace belongs in the playground only; remove any copy this just made elsewhere.
        for (const e of others) {
          if (!hadIt.has(e) && (await load(e)).some((s) => s.name === WORKSPACE)) {
            await rw.deleteService(WORKSPACE, e);
            ok(`removed the ${WORKSPACE} copy Railway also created in ${e}`);
          }
        }
      },
    });
  } else ok(`${opts.playground} has the ${wsName} service`);
  if (workspace?.deploy?.healthcheckPath !== '/__tapthat/healthz' || !workspace || Number(workspace.deploy?.healthcheckTimeout) < 900) {
    actions.push({
      label: `${wsName}: health check /__tapthat/healthz with 15 minutes to boot (the first boot installs every repo)`,
      run: () =>
        rw.editServices(
          opts.playground,
          [
            [wsName, 'deploy.healthcheckPath', '/__tapthat/healthz'],
            [wsName, 'deploy.healthcheckTimeout', '900'],
          ],
          'TapThat workspace health check',
        ),
    });
  }

  // The workspace's variables.
  const current = workspace?.variables ?? {};
  const base = baseVariables(siteRepo, plan.primary, topo);
  const { set: missing, unknown } = missingVariables(configPlaceholders(config), base, plan.variables, current);
  for (const name of unknown) warn(`the config reads ${name}, which the installer cannot work out: set it on ${wsName} by hand`);
  const generated: Record<string, () => string> = {};
  if (!current.TAPTHAT_TOKEN) generated.TAPTHAT_TOKEN = token;
  if (!current.TAPTHAT_ENCRYPTION_KEY) generated.TAPTHAT_ENCRYPTION_KEY = key32;
  const devPg = pgName ? await rw.rendered(pgName, devName) : {};
  const devUrlNow = devDatabaseUrl(devPg);
  const devUrlStale = !!pgName && (devPasswordChanges || !devUrlNow || current.TAPTHAT_DEV_DATABASE_URL !== devUrlNow);
  const needsGitToken = !current.TAPTHAT_GIT_TOKEN;
  const varCount = Object.keys(missing).length + Object.keys(generated).length + (devUrlStale ? 1 : 0);
  if (varCount) {
    actions.push({
      label: `${wsName}: set ${varCount} variable${varCount === 1 ? '' : 's'} ${dim(`(${[...Object.keys(missing), ...Object.keys(generated), ...(devUrlStale ? ['TAPTHAT_DEV_DATABASE_URL'] : [])].slice(0, 6).join(', ')}${varCount > 6 ? ', …' : ''})`)}`,
      run: async () => {
        const plain: Record<string, string> = {};
        for (const [k, v] of Object.entries(missing)) {
          if (plan.secretKeys.has(k)) await rw.setSecret(wsName, opts.playground, k, v);
          else plain[k] = v;
        }
        await rw.setPlain(wsName, opts.playground, plain);
        for (const [k, make] of Object.entries(generated)) await rw.setSecret(wsName, opts.playground, k, make());
        if (devUrlStale) {
          const url = devDatabaseUrl(await rw.rendered(pgName!, devName));
          if (!url) throw new Error(`${devName}/${pgName} has no TCP proxy yet; run the installer again in a minute.`);
          await rw.setSecret(wsName, opts.playground, 'TAPTHAT_DEV_DATABASE_URL', url);
        }
      },
    });
  }

  // The GitHub token the workspace clones and pushes with: asked for now, so the confirmation covers it.
  let gitToken: string | null = null;
  const includedRepos = topo.included.map((n) => devServices.find((s) => s.name === n)!.source.repo!);
  if (needsGitToken) {
    todo(`${wsName} needs a GitHub token that can push to ${includedRepos.join(', ')}`);
    if (opts.dryRun) say(dim('  would ask for it'));
    else {
      say(dim(`  Create a fine-grained token: https://github.com/settings/personal-access-tokens/new`));
      say(dim(`  Resource owner: ${includedRepos[0]!.split('/')[0]} · Repositories: ${includedRepos.map((r) => r.split('/')[1]).join(', ')} · Contents: Read and write`));
      for (let attempt = 0; ; attempt++) {
        gitToken = opts.gitTokenStdin ? await readAllStdin() : await p.secret('Paste the token');
        const denied = [];
        for (const repo of includedRepos) if (!(await canPush(gitToken, repo))) denied.push(repo);
        if (!denied.length) {
          ok(`the token can push to ${includedRepos.join(', ')}`);
          break;
        }
        fail(`the token cannot push to ${denied.join(', ')}`);
        if (opts.gitTokenStdin || attempt >= 2) throw new Error('No working GitHub token.');
      }
      const t = gitToken;
      actions.push({ label: `${wsName}: store the GitHub token`, run: () => rw.setSecret(wsName, opts.playground, 'TAPTHAT_GIT_TOKEN', t!) });
    }
  }

  if (!workspace?.domains.length) {
    actions.push({
      label: `${wsName}: a public domain`,
      run: async () => {
        await rw.createDomain(wsName, opts.playground, SIDECAR_PORT);
      },
    });
  }
  // A copied environment has no public domains, and behind a gateway the gateway is the site.
  if (topo.edge && !playground?.find((s) => s.name === site)?.domains.length) {
    actions.push({
      label: `${site}: a public domain, the site reviewers open`,
      run: async () => {
        await rw.createDomain(site, opts.playground, Number(siteSpec.variables.PORT) || SIDECAR_PORT);
      },
    });
  }

  // ── 6. confirm and apply ─────────────────────────────────────────────────
  heading(actions.length ? 'Changes' : 'Everything is in place');
  actions.forEach((a, i) => say(`  ${dim(`${i + 1}.`)} ${a.label}`));
  if (opts.dryRun) {
    say(`\n${dim('Dry run: nothing was changed.')}`);
    return 0;
  }
  if (actions.length) {
    if (!(await p.confirm(`Make these ${actions.length} change${actions.length === 1 ? '' : 's'}?`))) {
      say('Nothing was changed.');
      return 1;
    }
    for (const a of actions) {
      await a.run();
      ok(a.label);
    }
  }

  // ── 7. deploy, first copy, and what to put in the extension ──────────────
  heading('Workspace');
  const finalServices = await load(opts.playground);
  const ws = finalServices.find((s) => s.name === wsName);
  if (!ws) throw new Error(`${opts.playground} has no ${wsName} service after setup.`);
  const url = ws.domains[0] ? originOf(ws.domains[0]) : null;
  if (!url) throw new Error(`${wsName} has no public domain.`);
  const wsVars = await rw.rendered(wsName, opts.playground);
  const healthy = async () => (await getJson(`${url}/__tapthat/healthz`)) !== null;
  if (actions.some((a) => !a.outside) || !(await healthy())) {
    await rw.redeploy(wsName, opts.playground);
    say(dim(`  deploying ${wsName}; the first boot clones and installs every repo`));
    await sleep(15_000 * PACE);
  }
  const up = await waitFor(`waiting for ${url}`, async () => ((await healthy()) ? true : null), 20 * 60_000, 10_000);
  if (!up) throw new Error(`${wsName} did not become healthy in 20 minutes. Its deploy logs say why: railway logs -s ${wsName} -e ${opts.playground}`);
  ok(`${url} is up`);

  const auth = { authorization: `Bearer ${wsVars.TAPTHAT_TOKEN}` };
  const session = await getJson<{ session: { state: string } | null; last: unknown }>(`${url}/__tapthat/api/session`, auth);
  // A first copy that failed (the last run stopped there) is cancelled and tried again.
  const retry = !!session && session.session?.state === 'failed' && !session.last && !!pgName && !devCreated;
  if (retry) {
    say(dim('  the last data copy failed; cancelling it to try again'));
    const cancelled = await fetch(`${url}/__tapthat/api/session/discard`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"reviewer":"installer"}' });
    if (!cancelled.ok) throw new Error(`Cancelling the failed session answered ${cancelled.status}: ${await cancelled.text()}`);
  }
  if (session && !session.session && !session.last && pgName && devCreated) {
    say(dim(`  ${devName} is new and has no data yet: set its databases up, then press Start session to copy them`));
  } else if (session && (!session.session || retry) && !session.last && pgName) {
    say(dim(`  first data copy from ${devName}`));
    const started = await fetch(`${url}/__tapthat/api/session/start`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"reviewer":"installer"}' });
    if (started.status !== 202) throw new Error(`Start session answered ${started.status}: ${await started.text()}`);
    const done = await waitFor(
      `copying ${devName}'s data`,
      async () => {
        const s = await getJson<{ session: { state: string; error: string | null } | null }>(`${url}/__tapthat/api/session`, auth);
        return s?.session && (s.session.state === 'active' || s.session.state === 'failed') ? s.session : null;
      },
      20 * 60_000,
    );
    if (!done) throw new Error('The first data copy did not finish in 20 minutes; check the workspace log.');
    if (done.state === 'failed') throw new Error(`The first data copy failed: ${done.error}`);
    await fetch(`${url}/__tapthat/api/session/discard`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"reviewer":"installer"}' });
    ok(`${opts.playground} has ${devName}'s data`);
    if (playgroundCreated) {
      // Their first deploys ran before the playground had data (and migrations).
      for (const s of finalServices.filter((s) => topo.kept.includes(s.name) && isRepoService(s))) await rw.redeploy(s.name, opts.playground);
      ok(`redeployed ${topo.kept.filter((n) => finalServices.find((s) => s.name === n && isRepoService(s))).join(', ')}`);
    }
  }

  const dangling = danglingReferences(finalServices);
  if (dangling.length) warn(`references to services ${opts.playground} does not have: ${dangling.join('; ')}`);

  heading('Done. In the TapThat extension, open Settings and fill in');
  say(`  Server URL   ${bold(url)}`);
  if (process.platform === 'darwin' && process.stdout.isTTY && (await run('pbcopy', [], { input: wsVars.TAPTHAT_TOKEN ?? '' })).code === 0) {
    say(`  Token        ${green('on your clipboard')} ${dim(`(also: railway variable list -s ${wsName} -e ${opts.playground} --kv | grep TAPTHAT_TOKEN)`)}`);
  } else {
    say(`  Token        ${dim(`railway variable list -s ${wsName} -e ${opts.playground} --kv | grep TAPTHAT_TOKEN`)}`);
  }
  const edgeDomain = topo.edge ? finalServices.find((s) => s.name === site)?.domains[0] : undefined;
  const pages = topo.edge ? [...(edgeDomain ? [originOf(edgeDomain)] : []), ...(topo.proxied ? [url] : [])] : [url];
  say(`  Sites        ${pages.join(', ') || dim(`${site}'s domain, once it has one`)}`);
  say(`\n  Then open ${pages[0] ?? url}, press ${bold('Start session')} and comment away. ${dim('Run this installer again any time; it only fixes what is missing.')}`);
  return 0;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** A domain's origin. A local one (the installer's own tests) has no TLS. */
const originOf = (domain: string) => `${/^(localhost|127\.0\.0\.1)[:/]/.test(domain) ? 'http' : 'https'}://${domain}`;

/** `svc.KEY` for each variable the config passes to an included repo whose dev value refers to `service`. */
function usesOf(config: unknown, devServices: EnvService[], included: string[], service: string): string[] {
  const repos = (config as { repos?: Array<{ name?: string; primary?: boolean; devServer?: { env?: Record<string, string> } }> }).repos ?? [];
  const out: string[] = [];
  for (const name of included) {
    const spec = devServices.find((s) => s.name === name);
    const env = repos.find((r) => r.name === name)?.devServer?.env ?? {};
    for (const [key, value] of Object.entries(spec?.variables ?? {})) {
      if (key in env && value.includes(`\${{${service}.`)) out.push(`${name}.${key}`);
    }
  }
  return out;
}

function mode(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

async function linkedEnvironment(rw: Railway): Promise<string | null> {
  const r = await run(process.env.TAPTHAT_RAILWAY_BIN ?? 'railway', ['status'], { cwd: rw.cwd });
  return /Environment:\s+(\S+)/.exec(r.stdout)?.[1] ?? null;
}

/**
 * Railway creates a duplicated environment's services in the background, and
 * this CLI version has been seen to create one with none at all: wait, then
 * refuse to carry on with an environment that is not what it should be.
 */
async function waitForServices(
  rw: Railway,
  project: Project,
  env: string,
  expected: number,
  ready: (s: EnvService[]) => boolean = (s) => s.length >= expected,
): Promise<EnvService[]> {
  const fresh = (await rw.project()) ?? project;
  const got = await waitFor(`waiting for ${env}'s services`, async () => {
    const s = await rw.services(fresh, env).catch(() => null);
    return s && ready(s) ? s : null;
  }, 180_000, 5000);
  if (!got) {
    throw new Error(
      `Railway created ${env} without the services it should have. Delete ${env} in the dashboard ` +
        `(or duplicate it there: environment settings → Duplicate) and run the installer again.`,
    );
  }
  return got;
}

function pushRedisFix(actions: Action[], rw: Railway, env: string, redis: EnvService, outside = false): void {
  const missing = Object.entries(REDIS_TEMPLATE_VARIABLES).filter(([k, v]) => redis.variables[k] !== v && !(k !== 'RAILWAY_RUN_UID' && redis.variables[k]));
  const noPassword = !redis.variables.REDIS_PASSWORD;
  if (!missing.length && !noPassword) return;
  actions.push({
    label: `${env}/${redis.name}: ${[noPassword && 'a password', missing.length && `the template's variables (${missing.map(([k]) => k).join(', ')})`].filter(Boolean).join(' and ')}`,
    run: async () => {
      if (noPassword) await rw.setSecret(redis.name, env, 'REDIS_PASSWORD', token());
      await rw.setPlain(redis.name, env, Object.fromEntries(missing));
      await rw.redeploy(redis.name, env);
    },
    outside,
  });
}

/**
 * Railway sometimes stores its secret() template function as literal text,
 * which makes the superuser password a public constant. Log in with it once,
 * change it inside Postgres, then store the new one.
 */
async function rotatePostgres(rw: Railway, env: string, service: string): Promise<void> {
  const psql = await psqlRunner();
  let vars = await rw.rendered(service, env);
  let temporary = false;
  if (!vars.RAILWAY_TCP_PROXY_DOMAIN) {
    await rw.createTcpProxy(service, env, 5432);
    temporary = true;
    const up = await waitFor('waiting for a temporary TCP proxy', async () => {
      const v = await rw.rendered(service, env);
      return v.RAILWAY_TCP_PROXY_DOMAIN ? v : null;
    }, 120_000, 3000);
    if (!up) throw new Error(`The temporary TCP proxy on ${env}/${service} did not appear.`);
    vars = up;
  }
  const conn = { PGHOST: vars.RAILWAY_TCP_PROXY_DOMAIN!, PGPORT: vars.RAILWAY_TCP_PROXY_PORT!, PGUSER: vars.PGUSER!, PGDATABASE: 'postgres' };
  const old = vars.PGPASSWORD!;
  const fresh = token();
  const reachable = await waitFor('waiting for Postgres', async () => ((await psql({ ...conn, PGPASSWORD: old }, 'select 1')) === 0 ? true : null), 90_000, 3000);
  if (!reachable) throw new Error(`Could not log in to ${env}/${service} with its stored password.`);
  const sql = `\\set ON_ERROR_STOP on\n\\getenv new_pw NEW_PW\nALTER ROLE ${quoteIdent(conn.PGUSER)} PASSWORD :'new_pw';\n`;
  if ((await psql({ ...conn, PGPASSWORD: old, NEW_PW: fresh }, sql)) !== 0) throw new Error(`Changing the password inside ${env}/${service} failed.`);
  await rw.setSecret(service, env, 'POSTGRES_PASSWORD', fresh);
  if ((await psql({ ...conn, PGPASSWORD: fresh }, 'select 1')) !== 0) throw new Error(`${env}/${service}: the new password does not log in.`);
  if ((await psql({ ...conn, PGPASSWORD: old }, 'select 1')) === 0) throw new Error(`${env}/${service}: the old password still logs in.`);
  if (temporary) for (const id of await rw.tcpProxyIds(service, env)) await rw.deleteTcpProxy(id, service, env);
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** psql 15 or newer (for \getenv): the local one, or one in Docker. Values travel in the environment, never argv. */
async function psqlRunner(): Promise<(env: Record<string, string>, sql: string) => Promise<number>> {
  const local = await run('psql', ['--version']);
  const major = Number(/(\d+)\./.exec(local.stdout)?.[1] ?? 0);
  if (local.code === 0 && major >= 15) {
    return async (env, sql) => (await run('psql', ['-qAt', '--file', '-'], { env, input: sql })).code;
  }
  if ((await run('docker', ['info'])).code !== 0) {
    throw new Error('Changing the Postgres password needs psql 15+ or Docker running. Install one and run the installer again.');
  }
  return async (env, sql) =>
    (await run('docker', ['run', '--rm', '-i', ...Object.keys(env).flatMap((k) => ['-e', k]), 'postgres:18-alpine', 'psql', '-qAt', '--file', '-'], { env, input: sql })).code;
}

async function getJson<T = unknown>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

