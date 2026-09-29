/**
 * `tapthat-server install` end to end, against stand-ins: a fake Railway CLI
 * and a fake GitHub CLI over JSON state (fake-railway.mjs, fake-gh.mjs), and a
 * local HTTP server playing the deployed workspace and GitHub's push check.
 *
 * The project starts as Dealroom's shape with only `production` and no `dev`
 * branch anywhere; the installer must converge it, and a second run must
 * change nothing.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const work = mkdtempSync(join(tmpdir(), 'tapthat-installer-'));

await esbuild.build({
  entryPoints: [join(pkgRoot, 'src', 'cli.ts')],
  outfile: join(work, 'cli.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'bundle', logLevel: 'silent',
});
for (const f of ['fake-railway.mjs', 'fake-gh.mjs']) chmodSync(join(here, f), 0o755);

let failed = 0;
let total = 0;
function check(label, ok, detail) {
  total++;
  if (!ok) { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
const eq = (label, actual, expected) =>
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

// ── the workspace and GitHub, played by one local server ─────────────────────
const sidecar = { session: null, last: null, tokens: new Set(), starts: 0, discards: 0 };
const server = createServer((req, res) => {
  const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (req.url.endsWith('/info/refs?service=git-receive-pack')) {
    const token = Buffer.from((req.headers.authorization ?? '').replace('Basic ', ''), 'base64').toString().split(':')[1];
    return send(token === 'good-token' ? 200 : 403, {});
  }
  if (req.url === '/__tapthat/healthz') return send(200, { ok: true });
  sidecar.tokens.add(req.headers.authorization);
  if (req.url === '/__tapthat/api/session' && req.method === 'GET') {
    if (sidecar.session?.state === 'starting') sidecar.session.state = 'active';
    return send(200, { mode: 'session', session: sidecar.session, last: sidecar.last });
  }
  if (req.url === '/__tapthat/api/session/start') {
    sidecar.starts++;
    sidecar.session = { state: 'starting', error: null };
    return send(202, {});
  }
  if (req.url === '/__tapthat/api/session/discard') {
    sidecar.discards++;
    sidecar.session = null;
    sidecar.last = { outcome: 'discarded' };
    return send(200, {});
  }
  send(404, {});
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `127.0.0.1:${server.address().port}`;

// ── the project ──────────────────────────────────────────────────────────────
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'dealroom-dev.json'), 'utf8')).services;

function freshRailway() {
  const names = {};
  const services = {};
  for (const s of fixture) {
    names[s.id] = s.name;
    const variables = Object.fromEntries(Object.entries(s.variables).map(([k, v]) => [k, { value: v }]));
    if (s.name === 'auth') variables.APP_URL = { value: 'https://${{app.RAILWAY_PUBLIC_DOMAIN}}' };
    if (s.name === 'postgres') {
      Object.assign(variables, { POSTGRES_PASSWORD: { value: 'random-strong-password' }, POSTGRES_USER: { value: 'postgres' }, POSTGRES_DB: { value: 'railway' } });
    }
    if (s.name === 'redis') for (const k of ['REDISHOST', 'REDISPASSWORD', 'REDIS_URL', 'REDISUSER', 'REDISPORT', 'RAILWAY_RUN_UID']) delete variables[k];
    services[s.id] = {
      source: s.source.repo ? { repo: s.source.repo, branch: 'main' } : { image: s.source.image },
      networking: { serviceDomains: ['app', 'admin', 'homepage', 'api'].includes(s.name) ? { [`${s.name}-production.up.railway.app`]: {} } : {} },
      variables,
      deploy: s.deploy ?? {},
    };
  }
  return {
    project: { id: 'proj-1', name: 'dealroom' },
    linked: { env: 'production', service: null },
    names,
    envs: { production: { services } },
    proxies: {}, volumes: [], deploys: [], log: [],
  };
}

function freshGitHub() {
  const repos = {};
  for (const s of fixture.filter((s) => s.source.repo)) repos[s.source.repo] ??= { default: 'main', branches: { main: {} } };
  repos['dealroom-no/app'].branches.main = {
    'package.json': JSON.stringify({ scripts: { dev: 'next dev', typecheck: 'tsc --noEmit' } }),
    'package-lock.json': '{}',
  };
  repos['dealroom-no/api'].branches.main = {
    'package.json': JSON.stringify({ scripts: { dev: 'tsx watch src', typecheck: 'tsc --noEmit', 'migrate:deploy': 'prisma migrate deploy' } }),
    'package-lock.json': '{}',
  };
  return { repos, log: [] };
}

const railwayFile = join(work, 'railway.json');
const ghFile = join(work, 'gh.json');
const readState = () => ({ rw: JSON.parse(readFileSync(railwayFile, 'utf8')), gh: JSON.parse(readFileSync(ghFile, 'utf8')) });

function install(args, { stdin = '', env = {} } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(work, 'cli.mjs'), 'install', ...args], {
      cwd: work,
      env: {
        ...process.env,
        NO_COLOR: '1',
        TAPTHAT_RAILWAY_BIN: join(here, 'fake-railway.mjs'),
        TAPTHAT_GH_BIN: join(here, 'fake-gh.mjs'),
        TAPTHAT_GITHUB_URL: `http://${origin}`,
        TAPTHAT_INSTALL_PACE: '0.001',
        FAKE_RAILWAY_STATE: railwayFile,
        FAKE_GH_STATE: ghFile,
        FAKE_RAILWAY_WORKSPACE_DOMAIN: origin,
        ...env,
      },
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.stdin.end(stdin);
    child.on('exit', (code) => done({ code, output }));
  });
}
const MUTATING = /^(variable set|environment (new|edit)|service delete|add |volume add|domain |tcp-proxy (create|delete)|redeploy|link )|-X (POST|PUT)/;
const mutations = (log) => log.filter((l) => MUTATING.test(l));

const reset = () => {
  writeFileSync(railwayFile, JSON.stringify(freshRailway()));
  writeFileSync(ghFile, JSON.stringify(freshGitHub()));
  Object.assign(sidecar, { session: null, last: null, tokens: new Set(), starts: 0, discards: 0 });
};
const flags = ['--yes', '--branch', 'dev', '--site', 'app', '--git-token-stdin'];

console.log('a dry run changes nothing');
{
  reset();
  const r = await install(['--dry-run', ...flags]);
  check('exits 0', r.code === 0, r.output);
  const { rw, gh } = readState();
  eq('no Railway writes', mutations(rw.log), []);
  eq('no GitHub writes', mutations(gh.log), []);
  check('it says what it would do', /no dev branch/.test(r.output) && /no environment deploys dev/.test(r.output), r.output);
}

console.log('a fresh project converges');
const first = await (async () => {
  reset();
  return install(flags, { stdin: 'good-token', env: { FAKE_RAILWAY_ADD_EVERYWHERE: '1' } });
})();
if (process.env.SHOW_OUTPUT) console.log(first.output);
{
  check('exits 0', first.code === 0, first.output);
  const { rw, gh } = readState();
  const svc = (env, name) => rw.envs[env]?.services[Object.entries(rw.names).find(([, n]) => n === name)?.[0]];
  const names = (env) => Object.keys(rw.envs[env]?.services ?? {}).map((id) => rw.names[id]).sort();
  const vars = (env, name) => Object.fromEntries(Object.entries(svc(env, name)?.variables ?? {}).map(([k, v]) => [k, v.value]));

  check('dev exists in every repository', Object.values(gh.repos).every((r) => r.branches.dev));
  eq('a dev environment, copied from production', names('dev'), names('production').filter((n) => n !== 'workspace'));
  check('…whose services deploy dev', ['app', 'api', 'auth'].every((n) => svc('dev', n).source.branch === 'dev'));
  check('…while production still deploys main', svc('production', 'app').source.branch === 'main');
  check('…with the public domains production has', Object.keys(svc('dev', 'app').networking.serviceDomains).length === 1);
  check('dev\'s Postgres has a TCP proxy', rw.proxies['dev/postgres']?.length === 1);
  eq('dev\'s Redis has its template variables', [vars('dev', 'redis').REDIS_URL, vars('dev', 'redis').RAILWAY_RUN_UID],
    ['redis://${{REDISUSER}}:${{REDIS_PASSWORD}}@${{REDISHOST}}:${{REDISPORT}}', '0']);
  check('…and a password', !!vars('dev', 'redis').REDIS_PASSWORD);

  eq('the playground keeps only what the site needs, plus the workspace', names('tapthat'), ['auth', 'payment', 'postgres', 'redis', 'storage', 'workspace']);
  check('the workspace was not left in other environments', !names('production').includes('workspace') && !names('dev').includes('workspace'));
  eq('a kept service points at the workspace instead of the dropped site', vars('tapthat', 'auth').APP_URL, 'https://${{workspace.RAILWAY_PUBLIC_DOMAIN}}');
  const ws = svc('tapthat', 'workspace');
  eq('the workspace runs the image', ws.source.image, 'ghcr.io/ljellevo/tapthat-server:latest');
  eq('…with its health check', [ws.deploy.healthcheckPath, ws.deploy.healthcheckTimeout], ['/__tapthat/healthz', 900]);
  eq('…a volume at /workspace', rw.volumes, [{ env: 'tapthat', service: 'workspace', mount: '/workspace' }]);
  eq('…and a domain', Object.keys(ws.networking.serviceDomains), [origin]);
  const w = vars('tapthat', 'workspace');
  eq('the sidecar is switched on', [w.TAPTHAT_ENABLE, w.TAPTHAT_PROXY, w.PORT], ['1', '1', '8080']);
  eq('it clones the site', w.TAPTHAT_REPO_URL, 'https://github.com/dealroom-no/app.git');
  eq('it has the GitHub token it was given', w.TAPTHAT_GIT_TOKEN, 'good-token');
  check('it has generated secrets', w.TAPTHAT_TOKEN?.length >= 32 && Buffer.from(w.TAPTHAT_ENCRYPTION_KEY, 'base64').length === 32);
  check('it copies from dev through the proxy', /^postgresql:\/\/postgres:random-strong-password@shuttle\.proxy\.rlwy\.net:\d+\/postgres$/.test(w.TAPTHAT_DEV_DATABASE_URL), w.TAPTHAT_DEV_DATABASE_URL);
  eq('the API\'s variables are there, rewritten', w.API_PLATFORM_DATABASE_URL,
    'postgresql://dealroom_platform:${{API_PLATFORM_DB_PASSWORD}}@${{postgres.PGHOST}}:${{postgres.PGPORT}}/dealroom_platform');
  eq('…with its own secrets copied from dev', w.API_PLATFORM_DB_PASSWORD, '<secret:PLATFORM_DB_PASSWORD>');

  const committed = gh.repos['dealroom-no/app'].branches.dev['tapthat.config.json'];
  check('a config was committed to the site on dev', !!committed);
  const cfg = JSON.parse(committed ?? '{}');
  eq('…in session mode, API first', cfg.git, { mode: 'session', deployOrder: ['api', 'app'] });
  eq('…copying data on Start session', cfg.session?.snapshot?.stopServers, ['api']);
  check('main was not touched', !gh.repos['dealroom-no/app'].branches.main['tapthat.config.json']);

  eq('no data copy from a dev that was just created empty', sidecar.starts, 0);
  check('…and it says what to do instead', /has no data yet/.test(first.output), first.output);
  check('kept services were pointed at the workspace and redeployed', rw.deploys.includes('tapthat/auth'));
  eq('the folder is linked as it was', rw.linked.env, 'production');
  check('no secret was printed', !first.output.includes('good-token') && !first.output.includes(w.TAPTHAT_TOKEN) && !first.output.includes('random-strong-password'));
  check('it ends with the extension settings', first.output.includes(`Server URL   http://${origin}`), first.output);
}

console.log('with an existing dev, the playground gets its data');
{
  reset();
  const state = JSON.parse(readFileSync(railwayFile, 'utf8'));
  state.envs.dev = JSON.parse(JSON.stringify(state.envs.production));
  for (const s of Object.values(state.envs.dev.services)) if (s.source.repo) s.source.branch = 'dev';
  writeFileSync(railwayFile, JSON.stringify(state));
  const gh = JSON.parse(readFileSync(ghFile, 'utf8'));
  for (const r of Object.values(gh.repos)) r.branches.dev = r.branches.main;
  writeFileSync(ghFile, JSON.stringify(gh));
  const r = await install(flags, { stdin: 'good-token' });
  check('exits 0', r.code === 0, r.output);
  const { rw } = readState();
  const token = rw.envs.tapthat.services['svc-workspace'].variables.TAPTHAT_TOKEN.value;
  eq('the first data copy ran, and was closed', [sidecar.starts, sidecar.discards], [1, 1]);
  eq('…with the workspace\'s token', [...sidecar.tokens], [`Bearer ${token}`]);
  check('kept services redeployed after it', ['tapthat/storage', 'tapthat/payment'].every((d) => rw.deploys.includes(d)));
  check('no environment or branch was created', !rw.log.some((l) => l.startsWith('environment new dev')));
}

console.log('a second run changes nothing');
{
  const before = readState();
  const r = await install(flags);
  check('exits 0', r.code === 0, r.output);
  const after = readState();
  eq('no Railway writes', mutations(after.rw.log.slice(before.rw.log.length)), []);
  eq('no GitHub writes', mutations(after.gh.log.slice(before.gh.log.length)), []);
  check('says so', r.output.includes('Everything is in place'), r.output);
  eq('no second data copy', sidecar.starts, 1);
}

console.log('behind a gateway, every service runs in the workspace');
{
  reset();
  // Dealroom with resources/railway/gateway in front of homepage and app, which
  // have no domains of their own any more; admin keeps its own.
  const state = JSON.parse(readFileSync(railwayFile, 'utf8'));
  const prod = state.envs.production.services;
  const idOf = (name) => Object.entries(state.names).find(([, n]) => n === name)[0];
  state.names['svc-gateway'] = 'gateway';
  prod['svc-gateway'] = {
    source: { repo: 'dealroom-no/resources', branch: 'main' },
    networking: { serviceDomains: { 'gateway-production.up.railway.app': {} } },
    variables: {
      PORT: { value: '8080' },
      APP_UPSTREAM: { value: '${{app.RAILWAY_PRIVATE_DOMAIN}}:3000' },
      HOMEPAGE_UPSTREAM: { value: '${{homepage.RAILWAY_PRIVATE_DOMAIN}}:3001' },
    },
    deploy: {},
  };
  for (const name of ['app', 'homepage', 'api']) prod[idOf(name)].networking.serviceDomains = {};
  prod[idOf('api')].variables.WEB_ORIGIN = { value: 'https://${{gateway.RAILWAY_PUBLIC_DOMAIN}}' };
  state.envs.dev = JSON.parse(JSON.stringify(state.envs.production));
  for (const s of Object.values(state.envs.dev.services)) if (s.source.repo) s.source.branch = 'dev';
  writeFileSync(railwayFile, JSON.stringify(state));
  const gh = JSON.parse(readFileSync(ghFile, 'utf8'));
  for (const repo of ['admin', 'homepage', 'auth', 'payment', 'storage']) {
    gh.repos[`dealroom-no/${repo}`].branches.main = {
      'package.json': JSON.stringify({ scripts: { dev: 'tsx watch src/main.ts', typecheck: 'tsc --noEmit' } }),
      'package-lock.json': '{}',
    };
  }
  // resources: Caddyfiles and documentation, nothing to run.
  gh.repos['dealroom-no/resources'].branches.main = { 'package.json': JSON.stringify({ scripts: { typecheck: 'tsc' } }) };
  for (const r of Object.values(gh.repos)) r.branches.dev = r.branches.main;
  writeFileSync(ghFile, JSON.stringify(gh));

  const edgeFlags = ['--yes', '--branch', 'dev', '--site', 'gateway', '--git-token-stdin'];
  const r = await install(edgeFlags, { stdin: 'good-token' });
  if (process.env.SHOW_OUTPUT) console.log(r.output);
  check('exits 0', r.code === 0, r.output);
  const { rw, gh: after } = readState();
  const names = (env) => Object.keys(rw.envs[env]?.services ?? {}).map((id) => rw.names[id]).sort();
  const vars = (env, name) => Object.fromEntries(Object.entries(rw.envs[env].services[Object.entries(rw.names).find(([, n]) => n === name)[0]].variables).map(([k, v]) => [k, v.value]));
  eq('the playground is the gateway, the databases and the workspace', names('tapthat'), ['gateway', 'postgres', 'redis', 'workspace']);
  eq('the gateway points at the dev servers in the workspace',
    [vars('tapthat', 'gateway').APP_UPSTREAM, vars('tapthat', 'gateway').HOMEPAGE_UPSTREAM],
    ['${{workspace.RAILWAY_PRIVATE_DOMAIN}}:3000', '${{workspace.RAILWAY_PRIVATE_DOMAIN}}:3001']);
  const cfg = JSON.parse(after.repos['dealroom-no/app'].branches.dev['tapthat.config.json'] ?? '{}');
  eq('the config, committed to the main app, names all seven', (cfg.repos ?? []).map((x) => x.name).sort(),
    ['admin', 'api', 'app', 'auth', 'homepage', 'payment', 'storage']);
  check('…and nothing was committed to the gateway\'s repository', !after.repos['dealroom-no/resources'].branches.dev['tapthat.config.json']);
  eq('…with the workspace\'s own domain serving admin', cfg.proxy, { target: 'http://localhost:3400' });
  const w = vars('tapthat', 'workspace');
  eq('the extension may run on both sites', w.TAPTHAT_ALLOWED_ORIGINS, 'https://${{gateway.RAILWAY_PUBLIC_DOMAIN}},https://${{RAILWAY_PUBLIC_DOMAIN}}');
  eq('the API\'s link to the site stays the gateway\'s', w.API_WEB_ORIGIN, 'https://${{gateway.RAILWAY_PUBLIC_DOMAIN}}');
  check('the token was checked against every repository', /can push to dealroom-no\/app, .*dealroom-no\/storage/.test(r.output), r.output);
  check('the gateway gets a domain in the playground, and is listed first', r.output.includes('Sites        https://gateway-tapthat.up.railway.app, http://'), r.output);

  const again = await install(edgeFlags);
  const later = readState();
  check('a second run exits 0', again.code === 0, again.output);
  eq('…and changes nothing', mutations(later.rw.log.slice(rw.log.length)), []);
}

console.log('failures stop early and say why');
{
  reset();
  let r = await install(flags, { stdin: 'bad-token' });
  check('a token that cannot push is refused', r.code === 1 && /cannot push to dealroom-no\/app, dealroom-no\/api/.test(r.output), r.output);
  eq('…before anything in the playground changed', Object.keys(readState().rw.envs).includes('tapthat'), false);

  reset();
  r = await install(flags, { stdin: 'good-token', env: { FAKE_RAILWAY_EMPTY_DUPLICATE: '1' } });
  check('an environment Railway creates empty is caught', r.code === 1 && /without the services it should have/.test(r.output), r.output);

  reset();
  r = await install(['--platform', 'render', ...flags]);
  check('another platform is refused', r.code === 1 && /Only Railway/.test(r.output), r.output);

  reset();
  const state = JSON.parse(readFileSync(railwayFile, 'utf8'));
  state.linked.env = null;
  writeFileSync(railwayFile, JSON.stringify(state));
  r = await install(flags);
  check('an unlinked folder without a terminal says to link it', r.code === 1 && /railway link/.test(r.output), r.output);
}

console.log('a guessable Postgres password is found');
{
  reset();
  const state = JSON.parse(readFileSync(railwayFile, 'utf8'));
  for (const s of Object.values(state.envs.production.services)) if (s.variables.POSTGRES_PASSWORD) s.variables.POSTGRES_PASSWORD.value = 'secret(32, "abc")';
  // A dev environment already exists here, so the dry run reaches the plan.
  state.envs.dev = JSON.parse(JSON.stringify(state.envs.production));
  for (const s of Object.values(state.envs.dev.services)) if (s.source.repo) s.source.branch = 'dev';
  writeFileSync(railwayFile, JSON.stringify(state));
  const gh = JSON.parse(readFileSync(ghFile, 'utf8'));
  for (const r of Object.values(gh.repos)) r.branches.dev = r.branches.main;
  writeFileSync(ghFile, JSON.stringify(gh));
  const r = await install(['--dry-run', ...flags]);
  check('the dry run lists replacing it', /replace the guessable superuser password/.test(r.output), r.output);
}

server.close();
rmSync(work, { recursive: true, force: true });
console.log(failed === 0 ? `PASS — ${total} installer checks` : `FAIL — ${failed} of ${total} installer checks`);
process.exit(failed === 0 ? 0 : 1);
