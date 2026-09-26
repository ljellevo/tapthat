import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Written to stdin, then closed. How secrets reach a CLI: never as an argument. */
  input?: string;
  env?: Record<string, string | undefined>;
  /** Hand the terminal to the command (interactive logins and pickers). */
  interactive?: boolean;
}

export function run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: opts.interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (e) => done({ code: 127, stdout, stderr: stderr || String(e.message) }));
    child.on('exit', (code) => done({ code: code ?? 1, stdout, stderr }));
    if (!opts.interactive) child.stdin?.end(opts.input ?? '');
  });
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly result: RunResult,
  ) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-6).join('\n');
    super(`${command} failed${detail ? `:\n${detail}` : ''}`);
  }
}

/** Runs and throws on a non-zero exit. The label never includes values passed on stdin. */
export async function must(command: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const result = await run(command, args, opts);
  if (result.code !== 0) throw new CommandError(`${command} ${args.filter((a) => !a.startsWith('-')).slice(0, 3).join(' ')}`, result);
  return result.stdout;
}

/** Parses a CLI's JSON output, tolerating banners printed before it. */
export function parseJson<T>(text: string, what: string): T {
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error(`${what}: expected JSON, got ${JSON.stringify(text.slice(0, 200))}`);
  try {
    return JSON.parse(text.slice(start)) as T;
  } catch {
    throw new Error(`${what}: could not parse its JSON output`);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
