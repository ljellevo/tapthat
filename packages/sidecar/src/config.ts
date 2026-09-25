import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { detectPlatform } from './guard';

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
  };
  git: {
    enabled: boolean;
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
    },
    git: {
      enabled: true,
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
  let fromFile: Partial<Config> = {};
  try {
    fromFile = JSON.parse(await readFile(path, 'utf8')) as Partial<Config>;
    source = path;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      problems.push(`${CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const config: Config = {
    ...base,
    ...fromFile,
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
    try {
      const dev = new URL(config.proxy.target ?? config.devServerUrl);
      const devPort = Number(dev.port || (dev.protocol === 'https:' ? 443 : 80));
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(dev.hostname);
      if (loopback && devPort === config.port) {
        problems.push(
          `devServerUrl: ${dev.origin} is the sidecar's own port (${config.port}). ` +
            'Give the dev server a different port, e.g. TAPTHAT_DEV_SERVER=http://localhost:3001',
        );
      }
    } catch {
      problems.push(`devServerUrl: "${config.devServerUrl}" is not a valid URL (override with TAPTHAT_DEV_SERVER)`);
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
