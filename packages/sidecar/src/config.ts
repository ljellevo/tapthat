import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export interface Config {
  port: number;
  host: string;
  repoRoot: string;
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
}

export const CONFIG_FILENAME = 'tapthat.config.json';

export function defaults(cwd: string): Config {
  return {
    port: 7420,
    host: '127.0.0.1',
    repoRoot: cwd,
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
  };

  config.port = num(env.TAPTHAT_PORT, config.port, problems, 'TAPTHAT_PORT');
  if (env.TAPTHAT_HOST) config.host = env.TAPTHAT_HOST;
  if (env.TAPTHAT_BRANCH) config.branch = env.TAPTHAT_BRANCH;
  if (env.TAPTHAT_DEV_SERVER) config.devServerUrl = env.TAPTHAT_DEV_SERVER;
  if (env.TAPTHAT_REPO_ROOT) config.repoRoot = env.TAPTHAT_REPO_ROOT;
  if (env.TAPTHAT_ALLOWED_ORIGINS) {
    config.allowedOrigins = env.TAPTHAT_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (env.TAPTHAT_VERIFY_COMMAND) config.verifyCommand = env.TAPTHAT_VERIFY_COMMAND;
  if (env.TAPTHAT_KILL_SWITCH === '1') config.killSwitch = true;

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
  if (config.agent.timeoutMs < 1000) {
    problems.push(`agent.timeoutMs: ${config.agent.timeoutMs} is too short to be useful`);
  }

  return { config, problems, source };
}
