/**
 * The installer's planning logic: pure functions from what a Railway
 * environment looks like to what its playground should look like. No I/O, so
 * every rule here is tested against a real project's shape.
 */

/** A service as the installer sees it: its name, where it builds from, its raw variables. */
export interface ServiceSpec {
  id: string;
  name: string;
  source: { repo?: string | null; branch?: string | null; image?: string | null };
  deploy?: { preDeployCommand?: string[] | string | null; healthcheckPath?: string | null; healthcheckTimeout?: number | null };
  /** Raw definitions, `${{…}}` references unresolved. */
  variables: Record<string, string>;
}

/** Facts read from each included repository (package.json and lockfiles). */
export interface RepoFacts {
  scripts: Record<string, string>;
  lockfile: 'npm' | 'pnpm' | 'yarn' | null;
}

export const WORKSPACE = 'workspace';
export const IMAGE = 'ghcr.io/ljellevo/tapthat-server:latest';
export const SIDECAR_PORT = 8080;

const CROSS_REF = /\$\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*\}\}/g;
const ANY_REF = /\$\{\{\s*(?:([A-Za-z0-9_-]+)\.)?([A-Za-z0-9_]+)\s*\}\}/g;

export const isDatabase = (s: ServiceSpec, kind?: 'postgres' | 'redis'): boolean => {
  const image = s.source.image ?? '';
  if (kind === 'postgres') return /postgres/i.test(image);
  if (kind === 'redis') return /redis/i.test(image);
  return /postgres|redis|mysql|mongo/i.test(image);
};

export const isRepoService = (s: ServiceSpec): boolean => !!s.source.repo;

/** `api` → `API`, `my-web` → `MY_WEB`: the prefix for a service's variables on the workspace. */
export const prefixOf = (name: string): string => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/** The services a service's variables point at, and how. */
export function referencesOf(s: ServiceSpec): Array<{ service: string; variable: string; key: string }> {
  const out: Array<{ service: string; variable: string; key: string }> = [];
  for (const [key, value] of Object.entries(s.variables)) {
    for (const m of value.matchAll(CROSS_REF)) out.push({ service: m[1]!, variable: m[2]!, key });
  }
  return out;
}

/**
 * The environment whose repo services deploy `branch`, if any. A mixed
 * environment counts when most of its repo services are on the branch.
 */
export function environmentDeploying(
  envs: Array<{ name: string; services: ServiceSpec[] }>,
  branch: string,
): string | null {
  let best: { name: string; share: number } | null = null;
  for (const env of envs) {
    const repos = env.services.filter(isRepoService);
    if (!repos.length) continue;
    const share = repos.filter((s) => s.source.branch === branch).length / repos.length;
    if (share > 0.5 && (!best || share > best.share)) best = { name: env.name, share };
  }
  return best?.name ?? null;
}

/** The site reviewers most likely comment on: a repo service with a public domain, preferring common names. */
const PREFERRED_SITES = ['app', 'web', 'frontend', 'site', 'www', 'client'];

export function suggestSite(services: ServiceSpec[], withDomains: Set<string>): string | null {
  const candidates = services.filter((s) => isRepoService(s) && withDomains.has(s.name));
  // A gateway, where there is one, is the way in to the rest.
  for (const name of ['gateway', ...PREFERRED_SITES]) {
    const hit = candidates.find((s) => s.name === name);
    if (hit) return hit.name;
  }
  return candidates[0]?.name ?? null;
}

export interface Topology {
  site: string;
  /** The site is a gateway in front of the dev servers, and stays as it runs in dev. */
  edge: boolean;
  /** Behind a gateway: a public service the gateway doesn't serve, served on the workspace's own domain. */
  proxied: string | null;
  /** Run inside the workspace, as dev servers: the site and the repo services it calls directly. */
  included: string[];
  /** Stay as their own services in the playground: what the included ones depend on. */
  kept: string[];
  /** Not needed in the playground. */
  dropped: string[];
  postgres: string | null;
  redis: string | null;
}

/**
 * Which services the playground needs. The site, plus the repo services it
 * reaches over the private network, run inside the workspace; everything those
 * depend on (databases, other services, transitively) stays as its own
 * service. A reference to another service's *public* domain is a link, not a
 * dependency: it is pointed at the workspace instead.
 *
 * With `edge`, the site is a gateway (a proxy that can't run as a dev server)
 * in front of the real sites. It stays as it runs in dev, pointed at the
 * workspace, and every repo service it reaches runs as a dev server, and so
 * does everything those reach in turn: every one of them can be changed. So do
 * the other public services, which the workspace's own domain serves.
 */
export function topology(services: ServiceSpec[], site: string, edge?: EdgeOptions): Topology {
  const byName = new Map(services.map((s) => [s.name, s]));
  const siteSpec = byName.get(site);
  if (!siteSpec) throw new Error(`No service named "${site}".`);
  // The repo services a service calls over the private network.
  const privateRepoRefs = (spec: ServiceSpec) =>
    referencesOf(spec).flatMap((r) => {
      const target = byName.get(r.service);
      return r.variable === 'RAILWAY_PRIVATE_DOMAIN' && target && isRepoService(target) ? [target.name] : [];
    });

  let included = [site];
  let proxied: string | null = null;
  if (edge) {
    const others = edge.publicServices.filter((n) => n !== site && edge.runnable(n));
    included = [];
    const queue = [...privateRepoRefs(siteSpec), ...others];
    while (queue.length) {
      const name = queue.shift()!;
      if (included.includes(name) || name === site || !edge.runnable(name)) continue;
      included.push(name);
      queue.push(...privateRepoRefs(byName.get(name)!));
    }
    if (!included.length) throw new Error(`${site} reaches no service that can run as a dev server.`);
    proxied = others[0] ?? null;
  } else {
    for (const name of privateRepoRefs(siteSpec)) if (!included.includes(name)) included.push(name);
  }

  const kept = new Set<string>(edge ? [site] : []);
  const queue = [...included, ...(edge ? [site] : [])];
  while (queue.length) {
    const spec = byName.get(queue.shift()!);
    if (!spec) continue;
    for (const ref of referencesOf(spec)) {
      if (ref.variable === 'RAILWAY_PUBLIC_DOMAIN') continue;
      const target = byName.get(ref.service);
      if (!target || included.includes(target.name) || kept.has(target.name)) continue;
      kept.add(target.name);
      queue.push(target.name);
    }
  }

  const pgs = services.filter((s) => isDatabase(s, 'postgres')).map((s) => s.name);
  const redises = services.filter((s) => isDatabase(s, 'redis')).map((s) => s.name);
  const postgres = pgs.find((n) => kept.has(n)) ?? null;
  const redis = redises.find((n) => kept.has(n)) ?? null;
  return {
    site,
    edge: !!edge,
    proxied,
    included,
    kept: [...kept].sort(),
    dropped: services.map((s) => s.name).filter((n) => !included.includes(n) && !kept.has(n)).sort(),
    postgres,
    redis,
  };
}

/**
 * The repository that holds tapthat.config.json and is cloned first: the site,
 * or behind a gateway the likeliest main app among what runs in the workspace.
 */
export function primaryOf(topo: Topology): string {
  if (!topo.edge) return topo.site;
  const candidates = topo.included.filter((n) => n !== topo.proxied);
  return PREFERRED_SITES.find((n) => candidates.includes(n)) ?? candidates[0] ?? topo.included[0]!;
}

/** The port a service listens on: its literal PORT, or the next free one. */
export function assignPorts(services: ServiceSpec[], included: string[]): Map<string, number> {
  const ports = new Map<string, number>();
  const taken = new Set<number>([SIDECAR_PORT]);
  for (const name of included) {
    const port = Number(services.find((s) => s.name === name)?.variables.PORT);
    if (Number.isInteger(port) && port > 0 && !taken.has(port)) {
      ports.set(name, port);
      taken.add(port);
    }
  }
  let next = 3000;
  for (const name of included) {
    if (ports.has(name)) continue;
    while (taken.has(next)) next++;
    ports.set(name, next);
    taken.add(next);
  }
  return ports;
}

/** Variables the platform or the sidecar sets for a dev server itself. */
const SKIPPED = /^(PORT|HOSTNAME|NODE_ENV|RAILWAY_[A-Z_]+)$/;

/** Behind a gateway, what `topology()` needs to know about the other services. */
export interface EdgeOptions {
  /** Repo services with a public domain of their own in dev. */
  publicServices: string[];
  /** Whether a service can run as a dev server: its repository has a dev or start script. */
  runnable: (name: string) => boolean;
}

/** Where a gateway sits, for rewriting links to public domains. */
type Edge = { site: string; proxied: string | null };
const edgeOf = (topo: Topology): Edge | undefined => (topo.edge ? { site: topo.site, proxied: topo.proxied } : undefined);

/**
 * A link to a service's public domain, in the playground: the workspace's own
 * domain (`self`); behind a gateway, the gateway's, except for the service the
 * workspace's domain itself serves.
 */
function publicDomainRef(service: string, self: string, edge?: Edge): string {
  if (!edge || service === edge.proxied) return self;
  return `\${{${edge.site}.RAILWAY_PUBLIC_DOMAIN}}`;
}

/**
 * One included service's variable, rewritten for life inside the workspace:
 * - another included service's private domain → localhost and its dev port
 * - any public domain → the workspace's own (the playground has one site), or
 *   behind a gateway the gateway's; a link to the gateway itself stays
 * - another included service's variable → the workspace's copy of it
 * - its own variables (`${{X}}`) → the workspace's copy (`${{API_X}}`)
 * - kept services, databases and shared variables → unchanged; they exist in
 *   the playground under the same names
 */
export function rewriteValue(
  value: string,
  owner: string,
  included: string[],
  ports: Map<string, number>,
  edge?: Edge,
): string {
  const out = value.replace(
    /(https?:\/\/)?\$\{\{\s*([A-Za-z0-9_-]+)\.RAILWAY_PRIVATE_DOMAIN\s*\}\}(:\d+)?/g,
    (whole, scheme: string | undefined, service: string) =>
      included.includes(service) ? `${scheme ?? ''}localhost:${ports.get(service)}` : whole,
  );
  // One pass, so a rewritten reference is never rewritten again.
  return out.replace(ANY_REF, (whole, service: string | undefined, variable: string) => {
    if (service) {
      if (variable === 'RAILWAY_PUBLIC_DOMAIN') return service === edge?.site ? whole : publicDomainRef(service, '${{RAILWAY_PUBLIC_DOMAIN}}', edge);
      return included.includes(service) ? `\${{${prefixOf(service)}_${variable}}}` : whole;
    }
    if (variable === 'PORT') return String(ports.get(owner));
    // The workspace's own RAILWAY_* variables (its domain, mostly) stand in for the service's.
    if (variable.startsWith('RAILWAY_')) return whole;
    return `\${{${prefixOf(owner)}_${variable}}}`;
  });
}

export interface WorkspacePlan {
  topology: Topology;
  /** The repository that holds tapthat.config.json. */
  primary: string;
  ports: Map<string, number>;
  /** Workspace service variables, raw (Railway resolves the references). */
  variables: Record<string, string>;
  /** Variables that hold secrets and must be written through stdin. */
  secretKeys: Set<string>;
  /** The committed tapthat.config.json. */
  config: Record<string, unknown>;
  warnings: string[];
}

export function planWorkspace(input: {
  services: ServiceSpec[];
  site: string;
  branch: string;
  repoFacts: Map<string, RepoFacts>;
  edge?: EdgeOptions;
}): WorkspacePlan {
  const { services, site, branch } = input;
  const topo = topology(services, site, input.edge);
  const edge = edgeOf(topo);
  const primary = primaryOf(topo);
  const ports = assignPorts(services, topo.included);
  const byName = new Map(services.map((s) => [s.name, s]));
  const warnings: string[] = [];
  const variables: Record<string, string> = {};
  const secretKeys = new Set<string>();

  const repos = [primary, ...topo.included.filter((n) => n !== primary)].map((name) => {
    const spec = byName.get(name)!;
    const facts = input.repoFacts.get(name) ?? { scripts: {}, lockfile: 'npm' };
    const env: Record<string, string> = {};
    for (const [key, raw] of Object.entries(spec.variables)) {
      if (SKIPPED.test(key)) continue;
      const rewritten = rewriteValue(raw, name, topo.included, ports, edge);
      // A value that is now just a URL to another dev server needs no workspace copy.
      if (/^https?:\/\/localhost:\d+[^$]*$/.test(rewritten)) {
        env[key] = rewritten;
        continue;
      }
      const wsKey = `${prefixOf(name)}_${key}`;
      variables[wsKey] = rewritten;
      if (!rewritten.includes('${{')) secretKeys.add(wsKey);
      env[key] = `\${${wsKey}}`;
    }

    const command = facts.scripts.dev ? 'npm run dev' : facts.scripts.start ? 'npm start' : null;
    if (!command) warnings.push(`${name}: package.json has no "dev" or "start" script; set devServer.command by hand`);
    if (facts.lockfile && facts.lockfile !== 'npm') {
      warnings.push(`${name}: uses ${facts.lockfile}; the image has npm only, so install with npm or adjust devServer.install`);
    }
    // Migrations: the repo's own script if it has one, else what Railway runs before each deploy.
    const pre = spec.deploy?.preDeployCommand;
    const prepare = facts.scripts['migrate:deploy']
      ? 'npm run migrate:deploy'
      : (Array.isArray(pre) ? pre.join(' && ') : pre) || null;

    return {
      name,
      ...(name === primary ? { primary: true } : { url: `https://github.com/${spec.source.repo}.git` }),
      description: `The ${name} service (${spec.source.repo}).`,
      ...(facts.scripts.typecheck ? { verifyCommand: 'npm run typecheck' } : {}),
      devServer: {
        command: command ?? 'npm run dev',
        url: `http://localhost:${ports.get(name)}`,
        install: facts.lockfile === 'npm' || !facts.lockfile ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund',
        ...(prepare ? { prepare } : {}),
        env,
      },
    };
  });

  // Dependencies first, so an app never deploys against an API that lacks what it
  // needs. Behind a gateway, what was reached last is what the rest depends on.
  const deployOrder = topo.edge ? [...topo.included].reverse() : [...topo.included.filter((n) => n !== site), site];
  if (topo.edge) {
    const unserved = (input.edge?.publicServices ?? []).filter((n) => n !== site && n !== topo.proxied && topo.included.includes(n));
    if (unserved.length) {
      warnings.push(`${unserved.join(', ')}: public in dev, but the workspace's domain serves only ${topo.proxied}; reach ${unserved.length === 1 ? 'it' : 'them'} through ${site}, or set proxy.target by hand`);
    }
  }

  const session: Record<string, unknown> = {};
  if (topo.postgres) {
    const pg = topo.postgres;
    variables.TAPTHAT_PLAYGROUND_DATABASE_URL =
      `postgresql://\${{${pg}.PGUSER}}:\${{${pg}.PGPASSWORD}}@\${{${pg}.PGHOST}}:\${{${pg}.PGPORT}}/postgres`;
    const redisKey = Object.keys(variables).find((k) => k.endsWith('_REDIS_URL'));
    session.snapshot = {
      source: '${TAPTHAT_DEV_DATABASE_URL}',
      target: '${TAPTHAT_PLAYGROUND_DATABASE_URL}',
      ...(redisKey ? { redis: `\${${redisKey}}` } : {}),
      // Dev servers that talk to the database are stopped while it is replaced.
      stopServers: topo.included.filter((n) => referencesOf(byName.get(n)!).some((r) => r.service === pg)),
    };
  } else {
    warnings.push('No Postgres service found among the dependencies: Start session will copy code but no data.');
  }

  const migrates = repos.some((r) => 'prepare' in r.devServer);
  const config = {
    branch,
    git: { mode: 'session', deployOrder },
    ...(topo.proxied ? { proxy: { target: `http://localhost:${ports.get(topo.proxied)}` } } : {}),
    ...(migrates
      ? {
          agent: {
            rules: [
              'Do not change database schemas or migrations. If a request needs a database change, stop and say exactly what is needed.',
            ],
          },
        }
      : {}),
    repos,
    ...(Object.keys(session).length ? { session } : {}),
  };

  return { topology: topo, primary, ports, variables, secretKeys, config, warnings };
}

/** The literal text Railway sometimes stores instead of evaluating its secret() template function. */
export const isLiteralTemplate = (value: string | undefined): boolean => !!value && /^secret\(/.test(value.trim());

/** Redis services created outside Railway's template lack the variables every consumer references. */
export const REDIS_TEMPLATE_VARIABLES: Record<string, string> = {
  REDISUSER: 'default',
  REDISPORT: '6379',
  REDISHOST: '${{RAILWAY_PRIVATE_DOMAIN}}',
  REDISPASSWORD: '${{REDIS_PASSWORD}}',
  REDIS_URL: 'redis://${{REDISUSER}}:${{REDIS_PASSWORD}}@${{REDISHOST}}:${{REDISPORT}}',
  // Railway mounts volumes owned by root; Railway's redis image runs as a non-root user.
  RAILWAY_RUN_UID: '0',
};

/**
 * A kept service's variable, rewritten for the playground, where the included
 * services live inside the workspace and the dropped ones do not exist. A
 * reference to a service that is not there resolves to an empty string, so
 * every such reference is pointed at the workspace (a link to a public domain,
 * behind a gateway, at the gateway); the rest is unchanged.
 */
export function rewriteForKept(value: string, topo: Topology, ports: Map<string, number>): string {
  const present = new Set(topo.kept);
  const withPrivate = value.replace(
    /\$\{\{\s*([A-Za-z0-9_-]+)\.RAILWAY_PRIVATE_DOMAIN\s*\}\}(:\d+)?/g,
    (whole, service: string) =>
      topo.included.includes(service) ? `\${{${WORKSPACE}.RAILWAY_PRIVATE_DOMAIN}}:${ports.get(service)}` : whole,
  );
  return withPrivate.replace(CROSS_REF, (whole, service: string, variable: string) => {
    if (present.has(service) || service === WORKSPACE) return whole;
    if (variable === 'RAILWAY_PUBLIC_DOMAIN') return publicDomainRef(service, `\${{${WORKSPACE}.RAILWAY_PUBLIC_DOMAIN}}`, edgeOf(topo));
    if (topo.included.includes(service)) return `\${{${WORKSPACE}.${prefixOf(service)}_${variable}}}`;
    return whole;
  });
}

/** The kept services' variables that must change in the playground: service → key → new raw value. */
export function keptRewrites(playground: ServiceSpec[], topo: Topology, ports: Map<string, number>): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const s of playground) {
    if (!topo.kept.includes(s.name)) continue;
    const changed: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.variables)) {
      const next = rewriteForKept(v, topo, ports);
      if (next !== v) changed[k] = next;
    }
    if (Object.keys(changed).length) out.set(s.name, changed);
  }
  return out;
}

/** References a kept service still makes to services that are not in the playground. */
export function danglingReferences(playground: ServiceSpec[]): string[] {
  const names = new Set(playground.map((s) => s.name));
  const out: string[] = [];
  for (const s of playground) {
    for (const ref of referencesOf(s)) {
      if (!names.has(ref.service)) out.push(`${s.name}.${ref.key} → ${ref.service}`);
    }
  }
  return out;
}

/** The sidecar's own settings on the workspace service; none of these is a secret. */
export function baseVariables(primaryRepo: string, primary: string, topo?: Topology): Record<string, string> {
  // Behind a gateway, pages come from the gateway's domain, and from the
  // workspace's own only when it serves a site too.
  const edge = topo && edgeOf(topo);
  const origins = edge
    ? [`https://\${{${edge.site}.RAILWAY_PUBLIC_DOMAIN}}`, ...(edge.proxied ? ['https://${{RAILWAY_PUBLIC_DOMAIN}}'] : [])]
    : ['https://${{RAILWAY_PUBLIC_DOMAIN}}'];
  return {
    NODE_ENV: 'development',
    PORT: String(SIDECAR_PORT),
    TAPTHAT_ENABLE: '1',
    TAPTHAT_PROXY: edge && !edge.proxied ? '0' : '1',
    TAPTHAT_START_DEV_SERVER: '1',
    // A playground is idle most of the time, and its dev servers are most of its memory.
    TAPTHAT_SLEEP_AFTER_MINUTES: '30',
    TAPTHAT_WORKSPACE_ROOT: '/workspace/repos',
    TAPTHAT_REPO_ROOT: `/workspace/repos/${primary}`,
    TAPTHAT_REPO_URL: `https://github.com/${primaryRepo}.git`,
    TAPTHAT_ALLOWED_ORIGINS: origins.join(','),
  };
}

/** `${NAME}` placeholders in a config: the workspace variables it reads. */
export function configPlaceholders(config: unknown): string[] {
  const names = new Set<string>();
  for (const m of JSON.stringify(config).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(m[1]!);
  return [...names].sort();
}

/**
 * The workspace variables that are missing: what the config reads, what the
 * sidecar needs, and whatever those refer to on the workspace itself
 * (`${{NAME}}`). A variable that already exists is never changed, but what it
 * refers to is followed, so a hand-made setup is checked by its own names.
 */
export function missingVariables(
  placeholders: string[],
  base: Record<string, string>,
  planned: Record<string, string>,
  current: Record<string, string>,
): { set: Record<string, string>; unknown: string[] } {
  const set: Record<string, string> = {};
  const unknown: string[] = [];
  // Generated or asked for by the installer itself.
  const handled = new Set(['TAPTHAT_TOKEN', 'TAPTHAT_ENCRYPTION_KEY', 'TAPTHAT_GIT_TOKEN', 'TAPTHAT_DEV_DATABASE_URL']);
  const seen = new Set<string>();
  const queue = [...Object.keys(base), ...placeholders, ...Object.keys(planned).filter((k) => k.startsWith('TAPTHAT_'))];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name) || handled.has(name)) continue;
    seen.add(name);
    const value = current[name] ?? base[name] ?? planned[name];
    if (value === undefined) {
      unknown.push(name);
      continue;
    }
    if (!(name in current)) set[name] = value;
    for (const m of value.matchAll(ANY_REF)) {
      if (!m[1] && !m[2]!.startsWith('RAILWAY_')) queue.push(m[2]!);
    }
  }
  return { set, unknown: unknown.sort() };
}

/** The copy source: dev's superuser through dev's TCP proxy, encoded for a URL. */
export function devDatabaseUrl(v: Record<string, string | undefined>): string | null {
  const { PGUSER, PGPASSWORD, RAILWAY_TCP_PROXY_DOMAIN: host, RAILWAY_TCP_PROXY_PORT: port } = v;
  if (!PGUSER || !PGPASSWORD || !host || !port) return null;
  return `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${host}:${port}/postgres`;
}
