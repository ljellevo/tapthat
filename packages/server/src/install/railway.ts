import type { ServiceSpec } from './model';
import { must, parseJson, run } from './sh';

/** A service in one environment, with what the installer needs beyond its spec. */
export interface EnvService extends ServiceSpec {
  domains: string[];
}

export interface Project {
  id: string;
  name: string;
  environments: Array<{ id: string; name: string }>;
  services: Array<{ id: string; name: string }>;
}

interface StatusJson {
  id: string;
  name: string;
  environments: { edges: Array<{ node: { id: string; name: string } }> };
  services: { edges: Array<{ node: { id: string; name: string } }> };
}

interface EnvConfigJson {
  services?: Record<
    string,
    {
      source?: { repo?: string; branch?: string; image?: string };
      networking?: { serviceDomains?: Record<string, unknown>; customDomains?: Record<string, unknown> };
      variables?: Record<string, { value?: string } | null>;
      deploy?: { preDeployCommand?: string[] | string; healthcheckPath?: string; healthcheckTimeout?: number };
    }
  >;
}

/**
 * The Railway CLI, as the installer uses it. Every write names its
 * environment explicitly (`-e`), so the linked environment never decides
 * where a change lands; secrets go over stdin, never as arguments.
 */
export class Railway {
  constructor(
    readonly cwd: string,
    private readonly bin = process.env.TAPTHAT_RAILWAY_BIN ?? 'railway',
  ) {}

  private cli(args: string[], input?: string) {
    return must(this.bin, args, { cwd: this.cwd, input });
  }

  async version(): Promise<string | null> {
    const r = await run(this.bin, ['--version'], { cwd: this.cwd });
    return r.code === 0 ? (/(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null) : null;
  }

  async loggedIn(): Promise<boolean> {
    return (await run(this.bin, ['whoami'], { cwd: this.cwd })).code === 0;
  }

  async login(): Promise<boolean> {
    return (await run(this.bin, ['login'], { cwd: this.cwd, interactive: true })).code === 0;
  }

  /** Lets the person pick a project in Railway's own picker. */
  async link(): Promise<boolean> {
    return (await run(this.bin, ['link'], { cwd: this.cwd, interactive: true })).code === 0;
  }

  async project(): Promise<Project | null> {
    const r = await run(this.bin, ['status', '--json'], { cwd: this.cwd });
    if (r.code !== 0) return null;
    const s = parseJson<StatusJson>(r.stdout, 'railway status');
    return {
      id: s.id,
      name: s.name,
      environments: s.environments.edges.map((e) => e.node),
      services: s.services.edges.map((e) => e.node),
    };
  }

  /** Every service in an environment with its raw (unresolved) variables. */
  async services(project: Project, env: string): Promise<EnvService[]> {
    const cfg = parseJson<EnvConfigJson>(await this.cli(['environment', 'config', '-e', env, '--json']), 'railway environment config');
    const names = new Map(project.services.map((s) => [s.id, s.name]));
    return Object.entries(cfg.services ?? {})
      .map(([id, s]) => ({
        id,
        name: names.get(id) ?? id,
        source: { repo: s.source?.repo ?? null, branch: s.source?.branch ?? null, image: s.source?.image ?? null },
        deploy: {
          preDeployCommand: s.deploy?.preDeployCommand ?? null,
          healthcheckPath: s.deploy?.healthcheckPath ?? null,
          healthcheckTimeout: s.deploy?.healthcheckTimeout ?? null,
        },
        variables: Object.fromEntries(
          Object.entries(s.variables ?? {}).flatMap(([k, v]) => (v && typeof v.value === 'string' ? [[k, v.value]] : [])),
        ),
        domains: [...Object.keys(s.networking?.serviceDomains ?? {}), ...Object.keys(s.networking?.customDomains ?? {})],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Variables as the service sees them, references resolved (includes RAILWAY_*). */
  async rendered(service: string, env: string): Promise<Record<string, string>> {
    const text = await this.cli(['variable', 'list', '-s', service, '-e', env, '--json']);
    const listed = parseJson<Record<string, string> | Array<{ name?: string; key?: string; value: string }>>(text, 'railway variable list');
    if (!Array.isArray(listed)) return listed;
    return Object.fromEntries(listed.map((v) => [v.name ?? v.key ?? '', v.value]));
  }

  /** Values without secrets: references and plain settings, several at once. */
  async setPlain(service: string, env: string, vars: Record<string, string>): Promise<void> {
    const pairs = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
    if (pairs.length) await this.cli(['variable', 'set', ...pairs, '-s', service, '-e', env, '--skip-deploys']);
  }

  async setSecret(service: string, env: string, key: string, value: string): Promise<void> {
    await this.cli(['variable', 'set', key, '--stdin', '-s', service, '-e', env, '--skip-deploys'], value);
  }

  async createEnvironment(name: string, duplicate: string): Promise<void> {
    // Not --json: with it, this CLI version created the environment without its services.
    await this.cli(['environment', 'new', name, '--duplicate', duplicate]);
  }

  async editServices(env: string, changes: Array<[service: string, path: string, value: string]>, message: string): Promise<void> {
    if (!changes.length) return;
    await this.cli(['environment', 'edit', '-e', env, ...changes.flatMap((c) => ['--service-config', ...c]), '-m', message]);
  }

  async deleteService(service: string, env: string): Promise<void> {
    await this.cli(['service', 'delete', '-s', service, '-e', env, '--yes']);
  }

  /** `railway add` and `volume add` act on the linked environment and service. */
  async linkTo(project: Project, env: string, service?: string): Promise<void> {
    await this.cli(['link', '-p', project.id, '-e', env, ...(service ? ['-s', service] : [])]);
  }

  async addImageService(name: string, image: string): Promise<void> {
    await this.cli(['add', '-s', name, '-i', image]);
  }

  async addVolume(mountPath: string): Promise<void> {
    await this.cli(['volume', 'add', '-m', mountPath]);
  }

  async createDomain(service: string, env: string, port: number): Promise<string | null> {
    const out = await this.cli(['domain', '-s', service, '-e', env, '--port', String(port)]);
    return /https:\/\/\S+/.exec(out)?.[0] ?? null;
  }

  async createTcpProxy(service: string, env: string, port: number): Promise<void> {
    await this.cli(['tcp-proxy', 'create', '--port', String(port), '-s', service, '-e', env]);
  }

  async tcpProxyIds(service: string, env: string): Promise<string[]> {
    const out = await this.cli(['tcp-proxy', 'list', '-s', service, '-e', env, '--json']);
    const d = parseJson<{ proxies?: Array<{ id: string }> } | Array<{ id: string }>>(out, 'railway tcp-proxy list');
    return (Array.isArray(d) ? d : (d.proxies ?? [])).map((p) => p.id);
  }

  async deleteTcpProxy(id: string, service: string, env: string): Promise<void> {
    await this.cli(['tcp-proxy', 'delete', id, '--yes', '-s', service, '-e', env]);
  }

  /** Whether this CLI has the commands the installer relies on. */
  async capable(): Promise<boolean> {
    return (await run(this.bin, ['environment', 'config', '--help'], { cwd: this.cwd })).code === 0;
  }

  async redeploy(service: string, env: string, fromSource = false): Promise<void> {
    await this.cli(['redeploy', '-s', service, '-e', env, '--yes', ...(fromSource ? ['--from-source'] : [])]);
  }
}
