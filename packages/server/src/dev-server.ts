import { spawn, type ChildProcess } from 'node:child_process';

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
): DevServerHandle {
  // The platform's PORT belongs to the sidecar. Most dev scripts read PORT
  // (`next dev --port ${PORT:-3000}`), so passing it through would put the dev
  // server on the sidecar's port and leave devServerUrl pointing at nothing.
  const port = new URL(devServerUrl).port;
  const env = { ...process.env, ...extraEnv, PORT: port || undefined };
  // Its own process group: `npm run dev` is a shell, npm, and the real server
  // underneath, and stopping only the shell would leave the server holding its
  // port and its database connections.
  const launch = () => spawn(command, { cwd, shell: true, stdio: 'inherit', env, detached: true });

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

  constructor(private readonly specs: DevServerSpec[]) {}

  get names(): string[] {
    return this.specs.map((s) => s.name);
  }

  start(name: string): void {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec || this.handles.has(name)) return;
    console.log(`[tapthat] starting ${name}: ${spec.command}`);
    this.handles.set(name, startDevServer(spec.command, spec.cwd, spec.url, spec.env, `${name} dev server`));
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

/** Polls until the dev server answers, so boot does not race it. */
export async function waitForDevServer(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}
