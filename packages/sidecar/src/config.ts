import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { detectPlatform } from './guard';

export interface RepoDevServer {
  /** Null when the dev server is started by someone else (npx, Compose). */
  command: string | null;
  url: string;
  /** Skipped when the lockfiles are unchanged since the last successful run. */
  install: string | null;
  /** Runs on every boot and after every data restore, e.g. migrations. Must be idempotent. */
  prepare: string | null;
  /** Extra environment for this server only, `${NAME}` already interpolated. */
  env: Record<string, string>;
}

/**
 * One checkout in the workspace. A single-repo setup is a workspace of one,
 * so everything downstream has exactly one code path.
 */
export interface RepoConfig {
  name: string;
  /** Absolute path of the checkout. */
  root: string;
  url: string | null;
  branch: string;
  primary: boolean;
  /** Told to the agent, so it knows which repository holds what. */
  description: string | null;
  verifyCommand: string | null;
  devServer: RepoDevServer | null;
}

/**
 * A folder that one repository owns and others keep a copy of (Dealroom's
 * `api/shared/contracts` → `app/shared/contracts`). The agent edits the
 * original; the sidecar makes the copies match, the way the team's own sync
 * script would.
 */
export interface MirrorConfig {
  from: { repo: string; path: string };
  to: Array<{ repo: string; path: string }>;
  /** Repositories outside this workspace that also keep a copy, named in notices. */
  alsoUsedBy: string[];
}

export interface Config {
  port: number;
  host: string;
  repoRoot: string;
  /**
   * Where to clone from when repoRoot has no checkout yet — the standalone /
   * PaaS shape, where the container starts with an empty volume. Null on the
   * npx and Compose paths, where the checkout already exists.
   */
  repoUrl: string | null;
  branch: string;
  devServerUrl: string;
  allowedOrigins: string[];
  agent: {
    command: string;
    args: string[] | null;
    allowedTools: string;
    model: string | null;
    timeoutMs: number;
    maxCommentsPerBatch: number;
    /** House rules added to the prompt, one sentence each. */
    rules: string[];
  };
  git: {
    enabled: boolean;
    /**
     * `commit`: every batch is committed on the checked-out branch (npx, Compose).
     * `session`: batches collect on a session branch and reach `branch` only on
     * Commit to dev — the playground-environment flow.
     */
    mode: 'commit' | 'session';
    /** Session mode: the order repos are pushed on Commit, e.g. the API before the app. */
    deployOrder: string[];
    push: boolean;
    remote: string;
    allowDirty: boolean;
    author: { name: string; email: string };
  };
  verifyCommand: string | null;
  killSwitch: boolean;
  auth: { mode: 'token' | 'none' };
  /**
   * Front the dev server so the whole thing is reachable on one port. Needed on
   * hosts that expose a single HTTP port per service; off by default because on
   * Compose and npx the dev server already has its own.
   */
  proxy: { enabled: boolean; target: string | null };
  /** Let the sidecar own the dev server's lifecycle (standalone/PaaS shape). */
  devServer: { start: boolean; command: string | null; install: string | null; readyTimeoutMs: number };
  limits: { batchesPerHour: number; batchesPerHourPerCredential: number };
  /** Where the checkouts live side by side; the agent's working directory. */
  workspaceRoot: string;
  /** Primary first. Always at least one. */
  repos: RepoConfig[];
  mirrors: MirrorConfig[];
}

interface RawRepo {
  name?: string;
  path?: string;
  url?: string;
  branch?: string;
  primary?: boolean;
  description?: string;
  verifyCommand?: string;
  devServer?: { command?: string; url?: string; install?: string; prepare?: string; env?: Record<string, string> };
}

interface RawFile extends Partial<Omit<Config, 'repos' | 'mirrors' | 'workspaceRoot'>> {
  workspace?: { root?: string };
  repos?: RawRepo[];
  mirrors?: Array<{ from?: string; to?: string[]; alsoUsedBy?: string[] }>;
}

const REPO_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

/** `${NAME}` from the environment. Unset names are reported, never silently empty. */
function interpolate(value: string, env: NodeJS.ProcessEnv, missing: Set<string>): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => {
    const found = env[name];
    if (found === undefined) missing.add(name);
    return found ?? '';
  });
}

function parseRef(ref: string | undefined): { repo: string; path: string } | null {
  const match = /^([^:]+):(.+)$/.exec(ref ?? '');
  return match ? { repo: match[1]!, path: match[2]!.replace(/^\/+|\/+$/g, '') } : null;
}

export const CONFIG_FILENAME = 'tapthat.config.json';

export function defaults(cwd: string): Config {
  return {
    port: 7420,
    host: '127.0.0.1',
    repoRoot: cwd,
    repoUrl: null,
    branch: 'dev',
    devServerUrl: 'http://localhost:5173',
    allowedOrigins: [],
    agent: {
      command: 'claude',
      args: null,
      allowedTools: 'Read,Edit,Write,Glob,Grep',
      model: null,
      timeoutMs: 180_000,
      maxCommentsPerBatch: 20,
      rules: [],
    },
    git: {
      enabled: true,
      mode: 'commit',
      deployOrder: [],
      push: false,
      remote: 'origin',
      allowDirty: false,
      author: { name: 'TapThat', email: 'tapthat@localhost' },
    },
    verifyCommand: null,
    killSwitch: false,
    auth: { mode: 'token' },
    proxy: { enabled: false, target: null },
    devServer: { start: false, command: null, install: null, readyTimeoutMs: 120_000 },
    limits: { batchesPerHour: 60, batchesPerHourPerCredential: 20 },
    workspaceRoot: cwd,
    repos: [],
    mirrors: [],
  };
}

function num(raw: string | undefined, fallback: number, problems: string[], name: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    problems.push(`${name}: expected a number, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  return n;
}

export interface LoadResult {
  config: Config;
  problems: string[];
  /** Absolute path of the file that was read, or null when none existed. */
  source: string | null;
}

/**
 * env > file > default. Every problem is collected rather than thrown on the
 * first one — a misconfigured sidecar should tell you everything that is wrong
 * in one go, not make you fix it one line per restart.
 */
export async function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<LoadResult> {
  const problems: string[] = [];
  const base = defaults(cwd);
  let source: string | null = null;

  const path = resolve(cwd, CONFIG_FILENAME);
  let fromFile: RawFile = {};
  try {
    fromFile = JSON.parse(await readFile(path, 'utf8')) as RawFile;
    source = path;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      problems.push(`${CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const { repos: rawRepos, mirrors: rawMirrors, workspace: rawWorkspace, ...flat } = fromFile;
  const config: Config = {
    ...base,
    ...flat,
    agent: { ...base.agent, ...fromFile.agent },
    git: { ...base.git, ...fromFile.git, author: { ...base.git.author, ...fromFile.git?.author } },
    auth: { ...base.auth, ...fromFile.auth },
    proxy: { ...base.proxy, ...fromFile.proxy },
    devServer: { ...base.devServer, ...fromFile.devServer },
    limits: { ...base.limits, ...fromFile.limits },
  };

  // PORT is injected by every PaaS; honour it so a container needs no extra wiring.
  config.port = num(env.TAPTHAT_PORT ?? env.PORT, config.port, problems, 'TAPTHAT_PORT');
  if (env.TAPTHAT_HOST) config.host = env.TAPTHAT_HOST;
  // On a PaaS the platform's edge is the only client, and it cannot reach
  // loopback — the default would deploy a service that never passes a health
  // check. `::` is dual-stack, which private networks like Railway's need.
  else if (!fromFile.host && detectPlatform(env)) config.host = '::';
  if (env.TAPTHAT_BRANCH) config.branch = env.TAPTHAT_BRANCH;
  if (env.TAPTHAT_DEV_SERVER) config.devServerUrl = env.TAPTHAT_DEV_SERVER;
  if (env.TAPTHAT_REPO_ROOT) config.repoRoot = env.TAPTHAT_REPO_ROOT;
  if (env.TAPTHAT_REPO_URL) config.repoUrl = env.TAPTHAT_REPO_URL;
  if (env.TAPTHAT_INSTALL_COMMAND) config.devServer.install = env.TAPTHAT_INSTALL_COMMAND;
  if (env.TAPTHAT_GIT_PUSH === '1') config.git.push = true;
  if (env.TAPTHAT_GIT_PUSH === '0') config.git.push = false;
  if (env.TAPTHAT_GIT_REMOTE) config.git.remote = env.TAPTHAT_GIT_REMOTE;
  if (env.TAPTHAT_GIT_MODE === 'session' || env.TAPTHAT_GIT_MODE === 'commit') config.git.mode = env.TAPTHAT_GIT_MODE;
  if (env.TAPTHAT_AGENT_COMMAND) config.agent.command = env.TAPTHAT_AGENT_COMMAND;
  if (env.TAPTHAT_AGENT_MODEL) config.agent.model = env.TAPTHAT_AGENT_MODEL;
  if (env.TAPTHAT_ALLOWED_ORIGINS) {
    config.allowedOrigins = env.TAPTHAT_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (env.TAPTHAT_VERIFY_COMMAND) config.verifyCommand = env.TAPTHAT_VERIFY_COMMAND;
  if (env.TAPTHAT_KILL_SWITCH === '1') config.killSwitch = true;
  if (env.TAPTHAT_PROXY === '1') config.proxy.enabled = true;
  if (env.TAPTHAT_START_DEV_SERVER === '1') config.devServer.start = true;
  if (env.TAPTHAT_DEV_COMMAND) config.devServer.command = env.TAPTHAT_DEV_COMMAND;
  if (env.TAPTHAT_AUTH_MODE === 'none') config.auth.mode = 'none';

  config.repoRoot = isAbsolute(config.repoRoot) ? config.repoRoot : resolve(cwd, config.repoRoot);
  buildWorkspace(config, { rawRepos, rawMirrors, rawWorkspace }, cwd, env, problems);

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    problems.push(`port: ${config.port} is not a valid port (override with TAPTHAT_PORT)`);
  }
  if (!config.branch) {
    problems.push('branch: must not be empty (override with TAPTHAT_BRANCH)');
  }
  for (const origin of config.allowedOrigins) {
    try {
      const parsed = new URL(origin);
      if (`${parsed.protocol}//${parsed.host}` !== origin) {
        problems.push(`allowedOrigins: "${origin}" should be a bare origin, e.g. ${parsed.protocol}//${parsed.host}`);
      }
    } catch {
      problems.push(`allowedOrigins: "${origin}" is not a valid origin (override with TAPTHAT_ALLOWED_ORIGINS)`);
    }
  }
  if (config.proxy.enabled || config.devServer.start) {
    // Every dev server needs its own port, and none may take the sidecar's.
    const seen = new Map<number, string>();
    const targets = config.repos
      .filter((r) => r.devServer)
      .map((r) => ({ name: r.name, url: r.primary ? (config.proxy.target ?? r.devServer!.url) : r.devServer!.url }));
    for (const target of targets) {
      const label = config.repos.length > 1 ? `repos[${target.name}].devServer.url` : 'devServerUrl';
      try {
        const dev = new URL(target.url);
        const devPort = Number(dev.port || (dev.protocol === 'https:' ? 443 : 80));
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(dev.hostname);
        if (!loopback) continue;
        if (devPort === config.port) {
          problems.push(
            `${label}: ${dev.origin} is the sidecar's own port (${config.port}). ` +
              'Give the dev server a different port, e.g. TAPTHAT_DEV_SERVER=http://localhost:3001',
          );
        } else if (seen.has(devPort)) {
          problems.push(`${label}: port ${devPort} is also used by ${seen.get(devPort)}'s dev server`);
        }
        seen.set(devPort, target.name);
      } catch {
        problems.push(`${label}: "${target.url}" is not a valid URL (override with TAPTHAT_DEV_SERVER)`);
      }
    }
  }
  if (config.agent.timeoutMs < 1000) {
    problems.push(`agent.timeoutMs: ${config.agent.timeoutMs} is too short to be useful`);
  }
  if (config.repoUrl && /^https?:\/\/[^/]*@/.test(config.repoUrl)) {
    problems.push(
      'repoUrl: contains credentials. Put the token in TAPTHAT_GIT_TOKEN instead — a URL with a token in it ends up in .git/config and in error messages.',
    );
  }
  if (config.devServer.start && !config.devServer.command) {
    problems.push('devServer.command: required when devServer.start is true (TAPTHAT_DEV_COMMAND)');
  }
  // Unauthenticated + reachable off-box is a repo-write primitive for anyone who
  // finds the port, so the two settings are only allowed to disagree on loopback.
  if (config.auth.mode === 'none' && config.host !== '127.0.0.1' && config.host !== 'localhost') {
    problems.push(
      `auth.mode "none" is only allowed when host is loopback, but host is "${config.host}". ` +
        'This endpoint accepts instructions that modify your repository.',
    );
  }

  return { config, problems, source };
}

/**
 * Normalizes the file's `repos`/`mirrors` into the workspace model. Without
 * `repos`, the classic single-repo settings become a workspace of one, so an
 * existing config means exactly what it meant before.
 */
function buildWorkspace(
  config: Config,
  raw: { rawRepos?: RawRepo[]; rawMirrors?: RawFile['mirrors']; rawWorkspace?: RawFile['workspace'] },
  cwd: string,
  env: NodeJS.ProcessEnv,
  problems: string[],
): void {
  const primaryDevServer = (): RepoDevServer => ({
    command: config.devServer.command,
    url: config.devServerUrl,
    install: config.devServer.install,
    prepare: null,
    env: {},
  });

  if (!raw.rawRepos?.length) {
    config.workspaceRoot = config.repoRoot;
    config.repos = [
      {
        name: basename(config.repoRoot),
        root: config.repoRoot,
        url: config.repoUrl,
        branch: config.branch,
        primary: true,
        description: null,
        verifyCommand: config.verifyCommand,
        devServer: primaryDevServer(),
      },
    ];
    if (raw.rawMirrors?.length) problems.push('mirrors: only meaningful with more than one repo in `repos`');
    config.mirrors = [];
    return;
  }

  const rootSetting = env.TAPTHAT_WORKSPACE_ROOT ?? raw.rawWorkspace?.root;
  config.workspaceRoot = rootSetting
    ? isAbsolute(rootSetting) ? rootSetting : resolve(cwd, rootSetting)
    : dirname(config.repoRoot);

  const primaryIndex = Math.max(0, raw.rawRepos.findIndex((r) => r.primary));
  const missing = new Set<string>();
  const names = new Set<string>();

  const repos = raw.rawRepos.map((r, i): RepoConfig => {
    const name = r.name ?? '';
    if (!REPO_NAME.test(name)) problems.push(`repos[${i}].name: "${name}" must be a simple name like "api"`);
    if (names.has(name)) problems.push(`repos: "${name}" is listed twice`);
    names.add(name);
    const primary = i === primaryIndex;

    // The primary repository is where the config came from, so the classic
    // settings (and their env overrides) describe it. File values fill the gaps.
    const devRaw = r.devServer;
    const env_ = Object.fromEntries(
      Object.entries(devRaw?.env ?? {}).map(([k, v]) => [k, interpolate(String(v), env, missing)]),
    );
    const devServer: RepoDevServer | null = primary
      ? {
          command: env.TAPTHAT_DEV_COMMAND ?? devRaw?.command ?? config.devServer.command,
          url: env.TAPTHAT_DEV_SERVER ?? devRaw?.url ?? config.devServerUrl,
          install: env.TAPTHAT_INSTALL_COMMAND ?? devRaw?.install ?? config.devServer.install,
          prepare: devRaw?.prepare ?? null,
          env: env_,
        }
      : devRaw
        ? {
            command: devRaw.command ?? null,
            url: devRaw.url ?? '',
            install: devRaw.install ?? null,
            prepare: devRaw.prepare ?? null,
            env: env_,
          }
        : null;
    if (devServer && !devServer.url) problems.push(`repos[${name}].devServer.url: required`);

    const root = primary
      ? config.repoRoot
      : r.path
        ? isAbsolute(r.path) ? r.path : resolve(config.workspaceRoot, r.path)
        : join(config.workspaceRoot, name);
    const url = primary ? (env.TAPTHAT_REPO_URL ?? r.url ?? config.repoUrl) : (r.url ?? null);
    if (url && /^https?:\/\/[^/]*@/.test(url)) {
      problems.push(`repos[${name}].url: contains credentials. Put the token in TAPTHAT_GIT_TOKEN instead.`);
    }

    return {
      name,
      root,
      url,
      branch: primary ? (env.TAPTHAT_BRANCH ?? r.branch ?? config.branch) : (r.branch ?? config.branch),
      primary,
      description: r.description ?? null,
      verifyCommand: primary ? (env.TAPTHAT_VERIFY_COMMAND ?? r.verifyCommand ?? config.verifyCommand) : (r.verifyCommand ?? null),
      devServer,
    };
  });

  // Only a server the sidecar will start needs its environment filled in.
  if (config.devServer.start && missing.size) {
    problems.push(`devServer.env: ${[...missing].map((n) => `\${${n}}`).join(', ')} not set in the environment`);
  }

  const primary = repos[primaryIndex]!;
  config.repos = [primary, ...repos.filter((r) => r !== primary)];
  config.repoUrl = primary.url;
  config.branch = primary.branch;
  config.verifyCommand = primary.verifyCommand;
  if (primary.devServer) {
    config.devServerUrl = primary.devServer.url;
    config.devServer.command = primary.devServer.command;
    config.devServer.install = primary.devServer.install;
  }

  const unknownOrder = config.git.deployOrder.filter((n) => !names.has(n));
  if (unknownOrder.length) problems.push(`git.deployOrder: unknown repo ${unknownOrder.map((u) => `"${u}"`).join(', ')}`);

  config.mirrors = (raw.rawMirrors ?? []).flatMap((m, i) => {
    const from = parseRef(m.from);
    const to = (m.to ?? []).map(parseRef);
    const refs = [from, ...to];
    if (!from || !to.length || to.some((t) => !t)) {
      problems.push(`mirrors[${i}]: expected { "from": "repo:path", "to": ["repo:path", …] }`);
      return [];
    }
    const unknown = refs.filter((ref) => ref && !names.has(ref.repo)).map((ref) => ref!.repo);
    if (unknown.length) {
      problems.push(`mirrors[${i}]: unknown repo ${unknown.map((u) => `"${u}"`).join(', ')}`);
      return [];
    }
    return [{ from, to: to as Array<{ repo: string; path: string }>, alsoUsedBy: m.alsoUsedBy ?? [] }];
  });
}
