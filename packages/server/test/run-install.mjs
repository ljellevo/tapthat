/**
 * The installer's planning, against the shape of a real project: Dealroom's
 * `dev` environment (test/fixtures/dealroom-dev.json, secrets replaced by
 * placeholders). Pure functions, no Railway.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const bundle = await esbuild.build({
  stdin: {
    contents: `export * from './src/install/model'; export { loadConfig } from './src/config';`,
    resolveDir: pkgRoot, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'bundle', write: false,
});
const modDir = mkdtempSync(join(tmpdir(), 'tapthat-install-mod-'));
writeFileSync(join(modDir, 'mod.mjs'), bundle.outputFiles[0].text);
const m = await import(join(modDir, 'mod.mjs'));

let failed = 0;
let total = 0;
function check(label, ok, detail) {
  total++;
  if (!ok) { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
const eq = (label, actual, expected) =>
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

const { services } = JSON.parse(readFileSync(join(here, 'fixtures', 'dealroom-dev.json'), 'utf8'));
const npm = (scripts) => ({ scripts, lockfile: 'npm' });

console.log('topology');
{
  const t = m.topology(services, 'app');
  eq('the site and the API it calls run in the workspace', t.included, ['app', 'api']);
  eq('what they depend on stays, transitively', t.kept, ['auth', 'payment', 'postgres', 'redis', 'storage']);
  eq('the rest is dropped (a public-domain link is not a dependency)', t.dropped, ['admin', 'homepage', 'webhooks']);
  eq('the Postgres to copy', t.postgres, 'postgres');
  eq('the Redis to flush', t.redis, 'redis');
  let threw = false;
  try { m.topology(services, 'nope'); } catch { threw = true; }
  check('an unknown site is an error', threw);
}

console.log('choosing');
{
  eq('the site suggestion prefers app among services with domains',
    m.suggestSite(services, new Set(['admin', 'app', 'homepage', 'api'])), 'app');
  eq('with no preferred name, the first with a domain', m.suggestSite(services, new Set(['homepage'])), 'homepage');
  eq('databases are never suggested', m.suggestSite(services, new Set(['postgres'])), null);
  const onDev = services;
  const onMain = services.map((s) => (s.source.repo ? { ...s, source: { ...s.source, branch: 'main' } } : s));
  eq('the environment deploying a branch',
    m.environmentDeploying([{ name: 'production', services: onMain }, { name: 'dev', services: onDev }], 'dev'), 'dev');
  eq('none when no environment deploys it',
    m.environmentDeploying([{ name: 'production', services: onMain }], 'dev'), null);
  const mixed = onMain.map((s) => (s.name === 'app' ? { ...s, source: { ...s.source, branch: 'dev' } } : s));
  eq('one service on the branch does not make an environment', m.environmentDeploying([{ name: 'p', services: mixed }], 'dev'), null);
}

console.log('rewriting');
{
  const ports = new Map([['app', 3000], ['api', 3100]]);
  const inc = ['app', 'api'];
  const r = (v, owner = 'api') => m.rewriteValue(v, owner, inc, ports);
  eq('an included service over the private network becomes localhost', r('http://${{api.RAILWAY_PRIVATE_DOMAIN}}:3100', 'app'), 'http://localhost:3100');
  eq('a kept service keeps its private domain', r('http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:3200'), 'http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:3200');
  eq('any public domain becomes the workspace\'s', r('https://${{app.RAILWAY_PUBLIC_DOMAIN}}'), 'https://${{RAILWAY_PUBLIC_DOMAIN}}');
  eq('a dropped service\'s public domain too', r('https://${{admin.RAILWAY_PUBLIC_DOMAIN}}'), 'https://${{RAILWAY_PUBLIC_DOMAIN}}');
  eq('an own variable becomes the workspace\'s prefixed copy',
    r('postgresql://dealroom_platform:${{PLATFORM_DB_PASSWORD}}@${{postgres.PGHOST}}:${{postgres.PGPORT}}/dealroom_platform'),
    'postgresql://dealroom_platform:${{API_PLATFORM_DB_PASSWORD}}@${{postgres.PGHOST}}:${{postgres.PGPORT}}/dealroom_platform');
  eq('another included service\'s variable becomes its prefixed copy', r('${{api.TOKEN}}', 'app'), '${{API_TOKEN}}');
  eq('a suffix survives', r('${{redis.REDIS_URL}}?family=0'), '${{redis.REDIS_URL}}?family=0');
  eq('an own PORT becomes the dev port', r('http://localhost:${{PORT}}'), 'http://localhost:3100');
  eq('prefixes are env-var safe', m.prefixOf('my-web.app'), 'MY_WEB_APP');
}

console.log('ports');
{
  eq('literal ports are kept', [...m.assignPorts(services, ['app', 'api'])], [['app', 3000], ['api', 3100]]);
  const clash = [{ name: 'a', source: {}, variables: { PORT: '8080' } }, { name: 'b', source: {}, variables: {} }];
  eq('the sidecar\'s port is never handed out', [...m.assignPorts(clash, ['a', 'b'])], [['a', 3000], ['b', 3001]]);
}

console.log('the workspace plan');
const plan = m.planWorkspace({
  services, site: 'app', branch: 'dev',
  repoFacts: new Map([
    ['app', npm({ dev: 'next dev', typecheck: 'tsc --noEmit' })],
    ['api', npm({ dev: 'tsx watch src/server.ts', typecheck: 'tsc --noEmit', 'migrate:deploy': 'prisma migrate deploy' })],
  ]),
});
{
  const { config, variables, secretKeys } = plan;
  const [app, api] = config.repos;
  eq('the site is the primary repo', [app.name, app.primary, app.url], ['app', true, undefined]);
  eq('the API is cloned from its GitHub repo', [api.name, api.url], ['api', 'https://github.com/dealroom-no/api.git']);
  eq('session mode, dependencies pushed first', config.git, { mode: 'session', deployOrder: ['api', 'app'] });
  eq('the app reaches the API on localhost, with no workspace variable', app.devServer.env, { DEALROOM_API_URL: 'http://localhost:3100' });
  eq('dev servers on their dev ports', [app.devServer.url, api.devServer.url], ['http://localhost:3000', 'http://localhost:3100']);
  eq('the repo\'s migrate script is the prepare step', api.devServer.prepare, 'npm run migrate:deploy');
  check('the app, without migrations, has no prepare', !('prepare' in app.devServer));
  eq('typecheck is the verify command', [app.verifyCommand, api.verifyCommand], ['npm run typecheck', 'npm run typecheck']);
  check('schema edits are forbidden when a repo migrates', config.agent?.rules?.[0]?.includes('schemas'));
  eq('platform variables are left to the platform', ['PORT', 'NODE_ENV', 'HOSTNAME'].filter((k) => k in api.devServer.env), []);
  eq('API variables reach the api process through the workspace',
    api.devServer.env.PLATFORM_DATABASE_URL, '${API_PLATFORM_DATABASE_URL}');
  eq('…with references rewritten', variables.API_PLATFORM_DATABASE_URL,
    'postgresql://dealroom_platform:${{API_PLATFORM_DB_PASSWORD}}@${{postgres.PGHOST}}:${{postgres.PGPORT}}/dealroom_platform');
  eq('the API\'s own secret is copied under its prefix', variables.API_PLATFORM_DB_PASSWORD, '<secret:PLATFORM_DB_PASSWORD>');
  check('literal values are written without being printed', secretKeys.has('API_TENANCY_MASTER_KEY') && secretKeys.has('API_PLATFORM_DB_PASSWORD'));
  check('references are not secrets', !secretKeys.has('API_PLATFORM_DATABASE_URL'));
  eq('CORS points at the workspace', variables.API_WEB_ORIGIN, 'https://${{RAILWAY_PUBLIC_DOMAIN}}');
  eq('kept services are still called over the private network', variables.API_AUTH_SERVICE_URL, 'http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:3200');
  eq('the copy target is the playground\'s superuser', variables.TAPTHAT_PLAYGROUND_DATABASE_URL,
    'postgresql://${{postgres.PGUSER}}:${{postgres.PGPASSWORD}}@${{postgres.PGHOST}}:${{postgres.PGPORT}}/postgres');
  eq('the snapshot: copy from dev, flush the API\'s Redis, stop what uses Postgres', config.session.snapshot, {
    source: '${TAPTHAT_DEV_DATABASE_URL}', target: '${TAPTHAT_PLAYGROUND_DATABASE_URL}',
    redis: '${API_REDIS_URL}', stopServers: ['api'],
  });
  eq('no warnings for a well-formed project', plan.warnings, []);
}

console.log('the generated config loads');
{
  const dir = mkdtempSync(join(tmpdir(), 'tapthat-install-cfg-'));
  writeFileSync(join(dir, 'tapthat.config.json'), JSON.stringify(plan.config, null, 2));
  mkdirSync(join(dir, '.git'));
  const env = {};
  for (const k of Object.keys(plan.variables)) env[k] = 'x';
  Object.assign(env, { TAPTHAT_DEV_DATABASE_URL: 'postgresql://a@b/c', TAPTHAT_PLAYGROUND_DATABASE_URL: 'postgresql://a@d/c', TAPTHAT_REPO_URL: 'https://github.com/dealroom-no/app.git' });
  const { problems, config } = await m.loadConfig(dir, env);
  eq('no problems', problems, []);
  eq('both repos, the site first', config?.repos.map((r) => r.name), ['app', 'api']);
  eq('the snapshot is on', !!config?.session.snapshot, true);
  rmSync(dir, { recursive: true, force: true });
}

console.log('warnings');
{
  const p = m.planWorkspace({
    services, site: 'app', branch: 'dev',
    repoFacts: new Map([['app', { scripts: {}, lockfile: 'pnpm' }], ['api', npm({ start: 'node dist' })]]),
  });
  check('a repo without a dev script is flagged', p.warnings.some((w) => w.startsWith('app:') && w.includes('"dev"')));
  check('a non-npm lockfile is flagged', p.warnings.some((w) => w.includes('pnpm')));
  eq('start is the fallback dev command', p.config.repos[1].devServer.command, 'npm start');
  eq('without a migrate script, the pre-deploy command is the prepare step', p.config.repos[1].devServer.prepare,
    'node_modules/.bin/prisma migrate deploy --schema=shared/db-platform/prisma/schema.prisma');
  const noDb = services.filter((s) => s.name !== 'postgres');
  const q = m.planWorkspace({ services: noDb, site: 'app', branch: 'dev', repoFacts: new Map() });
  check('no Postgres: no snapshot, and a warning', !q.config.session && q.warnings.some((w) => w.includes('Postgres')));
}

console.log('the playground around the workspace');
{
  const topo = m.topology(services, 'app');
  const ports = m.assignPorts(services, topo.included);
  const auth = { name: 'auth', source: { repo: 'o/auth' }, variables: {
    APP_URL: 'https://${{app.RAILWAY_PUBLIC_DOMAIN}}/login',
    API_URL: 'http://${{api.RAILWAY_PRIVATE_DOMAIN}}:3100',
    API_TOKEN: '${{api.SERVICE_TOKEN}}',
    DB: '${{postgres.PGHOST}}',
    ADMIN: 'https://${{admin.RAILWAY_PUBLIC_DOMAIN}}',
  } };
  const pg = services.find((s) => s.name === 'postgres');
  const rewrites = m.keptRewrites([auth, pg], topo, ports);
  eq('a kept service reaches the site through the workspace\'s domain', rewrites.get('auth').APP_URL, 'https://${{workspace.RAILWAY_PUBLIC_DOMAIN}}/login');
  eq('…and an included API through the workspace\'s private domain', rewrites.get('auth').API_URL, 'http://${{workspace.RAILWAY_PRIVATE_DOMAIN}}:3100');
  eq('…and its variables through the workspace\'s copies', rewrites.get('auth').API_TOKEN, '${{workspace.API_SERVICE_TOKEN}}');
  eq('…and a dropped service\'s link through the workspace too', rewrites.get('auth').ADMIN, 'https://${{workspace.RAILWAY_PUBLIC_DOMAIN}}');
  check('references to kept services are untouched', !('DB' in rewrites.get('auth')));
  check('services without dangling references need nothing', !rewrites.has('postgres'));
  eq('dangling references are listed', m.danglingReferences([{ name: 'x', source: {}, variables: { A: '${{gone.B}}', C: '${{x.D}}' } }]), ['x.A → gone']);
}

console.log('workspace variables');
{
  const base = m.baseVariables('dealroom-no/app', 'app');
  eq('the site repo is cloned into the workspace', [base.TAPTHAT_REPO_URL, base.TAPTHAT_REPO_ROOT], ['https://github.com/dealroom-no/app.git', '/workspace/repos/app']);
  const placeholders = m.configPlaceholders(plan.config);
  check('placeholders are what the config reads', placeholders.includes('API_PLATFORM_DATABASE_URL') && placeholders.includes('TAPTHAT_DEV_DATABASE_URL'));
  check('…not the references Railway resolves', !placeholders.some((p) => p.includes('{')));

  const fresh = m.missingVariables(placeholders, base, plan.variables, {});
  check('a fresh workspace gets everything', 'API_PLATFORM_DATABASE_URL' in fresh.set && 'TAPTHAT_ENABLE' in fresh.set && 'TAPTHAT_PLAYGROUND_DATABASE_URL' in fresh.set);
  check('…including what those refer to', 'API_PLATFORM_DB_PASSWORD' in fresh.set);
  check('…except what the installer generates or asks for', !('TAPTHAT_TOKEN' in fresh.set) && !('TAPTHAT_DEV_DATABASE_URL' in fresh.set));
  eq('…and nothing is unknown', fresh.unknown, []);

  // Dealroom's hand-made config and workspace: their own names, which are followed, not replaced.
  const handMade = placeholders.filter((p) => p !== 'API_PLATFORM_DB_PASSWORD');
  const current = { ...fresh.set };
  delete current.API_PLATFORM_DB_PASSWORD;
  current.API_PLATFORM_DATABASE_URL = 'postgresql://p:${{PLATFORM_DB_PASSWORD}}@h/db';
  current.PLATFORM_DB_PASSWORD = 'x';
  const again = m.missingVariables(handMade, base, plan.variables, current);
  eq('a complete workspace needs nothing, whatever its own names', again, { set: {}, unknown: [] });
  delete current.PLATFORM_DB_PASSWORD;
  eq('a name it refers to that nobody can derive is reported', m.missingVariables(handMade, base, plan.variables, current).unknown, ['PLATFORM_DB_PASSWORD']);
  eq('a placeholder nobody can derive is reported', m.missingVariables(['MYSTERY'], base, {}, {}).unknown, ['MYSTERY']);

  eq('the copy source is URL-encoded', m.devDatabaseUrl({ PGUSER: 'postgres', PGPASSWORD: 'a b/c', RAILWAY_TCP_PROXY_DOMAIN: 'x.proxy.rlwy.net', RAILWAY_TCP_PROXY_PORT: '123' }),
    'postgresql://postgres:a%20b%2Fc@x.proxy.rlwy.net:123/postgres');
  eq('…and needs a TCP proxy', m.devDatabaseUrl({ PGUSER: 'postgres', PGPASSWORD: 'x' }), null);
}

console.log('behind a gateway');
{
  // Dealroom with resources/railway/gateway in front: homepage and app on one
  // domain, admin on its own, app and homepage private.
  const gateway = { id: 'svc-gateway', name: 'gateway', source: { repo: 'dealroom-no/resources', branch: 'dev', image: null }, variables: {
    PORT: '8080',
    APP_UPSTREAM: '${{app.RAILWAY_PRIVATE_DOMAIN}}:3000',
    HOMEPAGE_UPSTREAM: '${{homepage.RAILWAY_PRIVATE_DOMAIN}}:3001',
  } };
  const onGateway = [...services.map((s) => {
    const v = { ...s.variables };
    if (s.name === 'api') v.WEB_ORIGIN = 'https://${{gateway.RAILWAY_PUBLIC_DOMAIN}}';
    if (s.name === 'homepage') v.NEXT_PUBLIC_APP_URL = 'https://${{gateway.RAILWAY_PUBLIC_DOMAIN}}';
    return { ...s, variables: v };
  }), gateway];
  // resources holds Caddyfiles and documentation, no dev script.
  const runnable = (n) => !['gateway', 'webhooks', 'postgres', 'redis'].includes(n);
  const edge = { publicServices: ['admin', 'gateway', 'webhooks'], runnable };
  const facts = new Map(onGateway.filter((s) => runnable(s.name)).map((s) => [s.name, npm({ dev: 'x', typecheck: 'tsc' })]));

  const t = m.topology(onGateway, 'gateway', edge);
  eq('every repo service behind it, and the other public site, runs in the workspace',
    [...t.included].sort(), ['admin', 'api', 'app', 'auth', 'homepage', 'payment', 'storage']);
  eq('the gateway stays, with the databases', t.kept, ['gateway', 'postgres', 'redis']);
  eq('what nothing reaches is dropped', t.dropped, ['webhooks']);
  eq('admin, public on its own, is served on the workspace\'s domain', t.proxied, 'admin');
  eq('a service that cannot run as a dev server is kept, not included',
    m.topology(onGateway, 'gateway', { ...edge, runnable: (n) => runnable(n) && n !== 'payment' }).kept, ['gateway', 'payment', 'postgres', 'redis']);

  const p = m.planWorkspace({ services: onGateway, site: 'gateway', branch: 'dev', repoFacts: facts, edge });
  eq('the main app is the primary repo, and first', [p.primary, p.config.repos[0].name, p.config.repos[0].primary], ['app', 'app', true]);
  eq('dependencies are pushed first', p.config.git.deployOrder, [...t.included].reverse());
  check('…auth before api before the sites', p.config.git.deployOrder.indexOf('auth') < p.config.git.deployOrder.indexOf('api')
    && p.config.git.deployOrder.indexOf('api') < p.config.git.deployOrder.indexOf('app'));
  eq('the workspace\'s proxy fronts admin', p.config.proxy, { target: 'http://localhost:3400' });
  eq('a link to the gateway stays the gateway\'s', p.variables.API_WEB_ORIGIN, 'https://${{gateway.RAILWAY_PUBLIC_DOMAIN}}');
  eq('a link to admin becomes the workspace\'s domain', p.variables.API_ADMIN_ORIGIN, 'https://${{RAILWAY_PUBLIC_DOMAIN}}');
  eq('auth, now a dev server too, is called on localhost', p.config.repos.find((r) => r.name === 'api').devServer.env.AUTH_SERVICE_URL, 'http://localhost:3200');
  eq('both services on Postgres stop during a copy', p.config.session.snapshot.stopServers, ['api', 'auth']);
  eq('no warnings', p.warnings, []);

  const kept = m.keptRewrites(onGateway, t, p.ports);
  eq('the gateway is pointed at the dev servers in the workspace', kept.get('gateway'), {
    APP_UPSTREAM: '${{workspace.RAILWAY_PRIVATE_DOMAIN}}:3000',
    HOMEPAGE_UPSTREAM: '${{workspace.RAILWAY_PRIVATE_DOMAIN}}:3001',
  });
  const base = m.baseVariables('dealroom-no/app', p.primary, t);
  eq('pages come from the gateway and the workspace', base.TAPTHAT_ALLOWED_ORIGINS, 'https://${{gateway.RAILWAY_PUBLIC_DOMAIN}},https://${{RAILWAY_PUBLIC_DOMAIN}}');
  eq('the primary is cloned first', base.TAPTHAT_REPO_ROOT, '/workspace/repos/app');
  const noOther = m.topology(onGateway, 'gateway', { ...edge, publicServices: ['gateway'] });
  eq('with nothing else public, the workspace serves only the sidecar',
    [noOther.proxied, m.baseVariables('o/app', 'app', noOther).TAPTHAT_PROXY, m.baseVariables('o/app', 'app', noOther).TAPTHAT_ALLOWED_ORIGINS],
    [null, '0', 'https://${{gateway.RAILWAY_PUBLIC_DOMAIN}}']);
  const midMove = m.planWorkspace({ services: onGateway, site: 'gateway', branch: 'dev', repoFacts: facts,
    edge: { ...edge, publicServices: ['admin', 'app', 'gateway', 'homepage'] } });
  check('sites still public besides the one served are named in a warning',
    midMove.warnings.some((w) => w.startsWith('app, homepage:')), midMove.warnings.join('; '));

  const dir = mkdtempSync(join(tmpdir(), 'tapthat-install-edge-'));
  writeFileSync(join(dir, 'tapthat.config.json'), JSON.stringify(p.config, null, 2));
  mkdirSync(join(dir, '.git'));
  const env = Object.fromEntries(Object.keys(p.variables).map((k) => [k, 'x']));
  Object.assign(env, { TAPTHAT_DEV_DATABASE_URL: 'postgresql://a@b/c', TAPTHAT_PLAYGROUND_DATABASE_URL: 'postgresql://a@d/c', TAPTHAT_PROXY: '1', TAPTHAT_START_DEV_SERVER: '1' });
  const loaded = await m.loadConfig(dir, env);
  eq('the generated config loads, the proxy on admin\'s port', loaded.problems, []);
  rmSync(dir, { recursive: true, force: true });
}

console.log('Railway quirks');
{
  check('a literal secret() template is detected', m.isLiteralTemplate('secret(32, "abcdefghijklmnopqrstuvwxyz")'));
  check('a random password is not', !m.isLiteralTemplate('Xk2_9aQ') && !m.isLiteralTemplate(undefined));
  check('Redis gets a root UID for its volume', m.REDIS_TEMPLATE_VARIABLES.RAILWAY_RUN_UID === '0');
}

rmSync(modDir, { recursive: true, force: true });
console.log(failed === 0 ? `PASS — ${total} installer planning checks` : `FAIL — ${failed} of ${total} installer planning checks`);
process.exit(failed === 0 ? 0 : 1);
