#!/usr/bin/env node
/**
 * A stand-in for the Railway CLI, for the installer's tests: the subset of
 * commands the installer uses, over a JSON state file (FAKE_RAILWAY_STATE).
 * Every call is appended to the state's `log`, without stdin.
 *
 * FAKE_RAILWAY_ADD_EVERYWHERE=1 makes `add` create the service in every
 * environment, as a project-level service would.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.FAKE_RAILWAY_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const die = (msg) => {
  process.stderr.write(`${msg}\n`);
  save();
  process.exit(1);
};
const opt = (...names) => {
  for (const n of names) {
    const i = args.indexOf(n);
    if (i >= 0) return args[i + 1];
  }
  return undefined;
};
const has = (n) => args.includes(n);
const stdin = () => readFileSync(0, 'utf8');

state.log.push(args.join(' '));

const envOf = (name = opt('-e', '--environment') ?? state.linked.env) => state.envs[name] ?? die(`Environment "${name}" not found`);
const idOf = (name) => Object.entries(state.names).find(([, n]) => n === name)?.[0];
const svcOf = (env, name = opt('-s', '--service') ?? state.linked.service) => {
  const id = idOf(name);
  return (id && env.services[id]) || die(`Service "${name}" not found`);
};

function render(envName, svcName) {
  const env = state.envs[envName];
  const vars = (name) => {
    const s = env.services[idOf(name)];
    if (!s) return {};
    const own = Object.fromEntries(Object.entries(s.variables).map(([k, v]) => [k, v.value]));
    own.RAILWAY_PRIVATE_DOMAIN = `${name}.railway.internal`;
    const domain = Object.keys(s.networking?.serviceDomains ?? {})[0];
    if (domain) own.RAILWAY_PUBLIC_DOMAIN = domain;
    const proxy = state.proxies[`${envName}/${name}`]?.[0];
    if (proxy) Object.assign(own, { RAILWAY_TCP_PROXY_DOMAIN: proxy.domain, RAILWAY_TCP_PROXY_PORT: String(proxy.port) });
    return own;
  };
  const resolve = (value, owner, depth = 0) =>
    depth > 5
      ? value
      : value.replace(/\$\{\{\s*(?:([A-Za-z0-9_-]+)\.)?([A-Za-z0-9_]+)\s*\}\}/g, (_, svc, key) => {
          const from = svc ?? owner;
          const raw = vars(from)[key];
          return raw === undefined ? '' : resolve(raw, from, depth + 1);
        });
  return Object.fromEntries(Object.entries(vars(svcName)).map(([k, v]) => [k, resolve(v, svcName)]));
}

const [a, b] = args;
if (a === '--version') out('railway 5.62.1\n');
else if (a === 'whoami') out('Logged in as test\n');
else if (a === 'environment' && b === 'config' && has('--help')) out('help\n');
else if (a === 'status') {
  if (!state.linked.env) die('No linked project found. Run railway link');
  if (has('--json')) {
    out({
      id: state.project.id,
      name: state.project.name,
      environments: { edges: Object.keys(state.envs).map((n) => ({ node: { id: `env-${n}`, name: n } })) },
      services: { edges: Object.entries(state.names).map(([id, name]) => ({ node: { id, name } })) },
    });
  } else out(`Project: ${state.project.name}\nEnvironment: ${state.linked.env}\nService: ${state.linked.service ?? 'None'}\n`);
} else if (a === 'environment' && b === 'config') out({ services: envOf().services, volumes: {} });
else if (a === 'environment' && b === 'new') {
  const name = args[2];
  if (state.envs[name]) die(`Environment ${name} already exists`);
  const src = envOf(opt('--duplicate', '-d'));
  state.envs[name] = process.env.FAKE_RAILWAY_EMPTY_DUPLICATE ? { services: {} } : JSON.parse(JSON.stringify(src));
  // Domains and proxies belong to the environment they were made in.
  for (const s of Object.values(state.envs[name].services)) s.networking = { serviceDomains: {} };
} else if (a === 'environment' && b === 'edit') {
  const env = envOf();
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--service-config') continue;
    const [svc, path, value] = args.slice(i + 1, i + 4);
    let node = svcOf(env, svc);
    const parts = path.split('.');
    for (const p of parts.slice(0, -1)) node = node[p] ??= {};
    node[parts.at(-1)] = /^\d+$/.test(value) ? Number(value) : value;
  }
} else if (a === 'variable' && b === 'list') {
  out(render(opt('-e') ?? state.linked.env, opt('-s') ?? state.linked.service));
} else if (a === 'variable' && b === 'set') {
  const s = svcOf(envOf());
  if (has('--stdin')) s.variables[args[2]] = { value: stdin() };
  else for (const pair of args.slice(2, args.findIndex((x, i) => i >= 2 && x.startsWith('-')))) {
    s.variables[pair.slice(0, pair.indexOf('='))] = { value: pair.slice(pair.indexOf('=') + 1) };
  }
} else if (a === 'service' && b === 'delete') {
  const env = envOf();
  const id = idOf(opt('-s'));
  if (!env.services[id]) die('Service not found');
  delete env.services[id];
} else if (a === 'link') {
  state.linked = { env: opt('-e'), service: opt('-s') ?? null };
} else if (a === 'add') {
  const name = opt('-s');
  const id = `svc-${name}`;
  state.names[id] = name;
  const make = () => ({ source: { image: opt('-i') }, networking: { serviceDomains: {} }, variables: {}, deploy: {} });
  if (process.env.FAKE_RAILWAY_ADD_EVERYWHERE) for (const env of Object.values(state.envs)) env.services[id] = make();
  else envOf(state.linked.env).services[id] = make();
} else if (a === 'volume' && b === 'add') {
  state.volumes.push({ env: state.linked.env, service: state.linked.service, mount: opt('-m') });
} else if (a === 'domain') {
  const envName = opt('-e');
  const svc = svcOf(envOf(envName));
  const domain = (opt('-s') === 'workspace' && process.env.FAKE_RAILWAY_WORKSPACE_DOMAIN) || `${opt('-s')}-${envName}.up.railway.app`;
  svc.networking.serviceDomains[domain] = { port: Number(opt('--port')) };
  out(`Service Domain created:\n  URL: https://${domain}\n`);
} else if (a === 'tcp-proxy' && b === 'create') {
  const key = `${opt('-e')}/${opt('-s')}`;
  (state.proxies[key] ??= []).push({ id: `proxy-${key}`, domain: 'shuttle.proxy.rlwy.net', port: 40000 + state.log.length });
} else if (a === 'tcp-proxy' && b === 'list') out({ proxies: state.proxies[`${opt('-e')}/${opt('-s')}`] ?? [] });
else if (a === 'tcp-proxy' && b === 'delete') {
  const key = `${opt('-e')}/${opt('-s')}`;
  state.proxies[key] = (state.proxies[key] ?? []).filter((p) => p.id !== args[2]);
} else if (a === 'redeploy') {
  svcOf(envOf());
  state.deploys.push(`${opt('-e')}/${opt('-s')}`);
} else die(`fake railway: unsupported command: ${args.join(' ')}`);

save();
