import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import type { Readable, Writable } from 'node:stream';

export interface DevServerHandle {
  readonly child: ChildProcess;
  /** Stops the server and everything it started; resolves once it has exited. */
  stop(): Promise<void>;
}

/**
 * Supervises one dev server when the sidecar owns its lifecycle — the
 * standalone / single-container shape, where there is no neighbouring service to
 * talk to. Dev servers die; a sidecar whose dev server is gone looks healthy and
 * applies changes nobody can see.
 */
export function startDevServer(
  command: string,
  cwd: string,
  devServerUrl: string,
  extraEnv: Record<string, string> = {},
  label = 'dev server',
  onLine?: (line: string) => void,
): DevServerHandle {
  // The platform's PORT belongs to the sidecar. Most dev scripts read PORT
  // (`next dev --port ${PORT:-3000}`), so passing it through would put the dev
  // server on the sidecar's port and leave devServerUrl pointing at nothing.
  const port = new URL(devServerUrl).port;
  const env = { ...process.env, ...extraEnv, PORT: port || undefined };
  // Its own process group: `npm run dev` is a shell, npm, and the real server
  // underneath, and stopping only the shell would leave the server holding its
  // port and its database connections.
  // Its output passes through unchanged; it is only read when someone listens,
  // because a pipe instead of the terminal costs a dev server its colours.
  const launch = () => {
    const child = spawn(command, {
      cwd, shell: true, env, detached: true,
      stdio: onLine ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    });
    if (onLine) {
      forwardLines(child.stdout!, process.stdout, onLine);
      forwardLines(child.stderr!, process.stderr, onLine);
    }
    return child;
  };

  let stopped = false;
  let child = launch();

  const onExit = (code: number | null) => {
    if (stopped) return;
    console.error(`[tapthat] ${label} exited (${code}); restarting in 2s`);
    setTimeout(() => {
      if (stopped) return;
      child = launch();
      child.on('exit', onExit);
    }, 2000);
  };
  child.on('exit', onExit);

  const signal = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      child.kill(sig);
    }
  };

  return {
    get child() {
      return child;
    },
    stop() {
      stopped = true;
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise<void>((done) => {
        const force = setTimeout(() => signal('SIGKILL'), 5000);
        child.once('exit', () => {
          clearTimeout(force);
          done();
        });
        signal('SIGTERM');
      });
    },
  };
}

function forwardLines(from: Readable, to: Writable, onLine: (line: string) => void): void {
  let partial = '';
  from.on('data', (chunk: Buffer) => {
    to.write(chunk);
    const lines = (partial + chunk.toString('utf8')).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
}

export interface DevServerSpec {
  name: string;
  command: string;
  cwd: string;
  url: string;
  env: Record<string, string>;
}

/**
 * Every dev server in the workspace — the app the reviewer looks at, and the
 * services behind it. Stopping one by name is what lets a database be restored
 * without a server holding connections to it.
 */
export class DevServers {
  private handles = new Map<string, DevServerHandle>();

  constructor(
    private readonly specs: DevServerSpec[],
    /** Every line any of them prints. */
    private readonly onLine?: (line: string) => void,
  ) {}

  get names(): string[] {
    return this.specs.map((s) => s.name);
  }

  start(name: string): void {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec || this.handles.has(name)) return;
    console.log(`[tapthat] starting ${name}: ${spec.command}`);
    this.handles.set(name, startDevServer(spec.command, spec.cwd, spec.url, spec.env, `${name} dev server`, this.onLine));
  }

  startAll(): void {
    for (const spec of this.specs) this.start(spec.name);
  }

  async stop(name: string): Promise<void> {
    const handle = this.handles.get(name);
    this.handles.delete(name);
    await handle?.stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.names.map((n) => this.stop(n)));
  }

  isRunning(name: string): boolean {
    return this.handles.has(name);
  }
}

/** Polls until the dev server accepts connections, so boot does not race it. */
export async function waitForDevServer(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await listening(url)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Whether something accepts connections at the URL's host and port. A TCP
 * connect, not a request: a request to a dev server compiles a page, and it
 * prints a request line, which a sleeping workspace counts as use.
 */
export function listening(url: string, timeoutMs = 1500): Promise<boolean> {
  const u = new URL(url);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (ok: boolean) => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
