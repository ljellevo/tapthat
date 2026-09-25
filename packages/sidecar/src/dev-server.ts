import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Supervises the dev server when the sidecar owns its lifecycle — the
 * standalone / single-container shape, where there is no neighbouring service to
 * talk to. Dev servers die; a sidecar whose dev server is gone looks healthy and
 * applies changes nobody can see.
 */
export function startDevServer(
  command: string,
  cwd: string,
  devServerUrl: string,
): { child: ChildProcess; stop(): void } {
  // The platform's PORT belongs to the sidecar. Most dev scripts read PORT
  // (`next dev --port ${PORT:-3000}`), so passing it through would put the dev
  // server on the sidecar's port and leave devServerUrl pointing at nothing.
  const port = new URL(devServerUrl).port;
  const env = { ...process.env, PORT: port || undefined };
  const launch = () => spawn(command, { cwd, shell: true, stdio: 'inherit', env });

  let stopped = false;
  let child = launch();

  const onExit = (code: number | null) => {
    if (stopped) return;
    console.error(`[tapthat] dev server exited (${code}); restarting in 2s`);
    setTimeout(() => {
      if (stopped) return;
      child = launch();
      child.on('exit', onExit);
    }, 2000);
  };
  child.on('exit', onExit);

  return {
    get child() {
      return child;
    },
    stop() {
      stopped = true;
      child.kill('SIGTERM');
    },
  };
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
