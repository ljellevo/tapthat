import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/** The public route that wakes a sleeping workspace, under the sidecar's prefix. */
export const WAKE_PATH = '/__tapthat/wake';

/** Marks a response as the asleep page, so the page's own polling can tell it from the app. */
const ASLEEP_HEADER = 'x-tapthat-asleep';

const CHECK_EVERY_MS = 60_000;

/**
 * A request as dev servers log it: `GET /rooms 200 in 41ms` (Next.js), `GET /x
 * 200 3.1 ms` (morgan). A hot-reload socket and a build asset log nothing.
 */
const REQUEST_LINE = /^\s*(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \/\S* \d{3}\b/;
const ANSI = /\x1b\[[0-9;]*m/g;

export function isRequestLine(line: string): boolean {
  return REQUEST_LINE.test(line.replace(ANSI, ''));
}

export interface SleeperDeps {
  /** Stopped after this long without use. */
  afterMs: number;
  /** The dev servers' ports, held while asleep. */
  ports: number[];
  stopServers: () => Promise<void>;
  startServers: () => void;
  /** Told after every change, so a restart can come back the way it was. */
  onChange?: (asleep: boolean) => void;
  now?: () => number;
}

/**
 * Stops every dev server after a stretch without use, and starts them again on
 * request. Most of a playground's life is idle, and its dev servers are most of
 * its memory; what is left asleep is this process.
 *
 * Use is a request: one through the sidecar, or one a dev server logs, which is
 * how traffic that comes past the sidecar (a gateway calling a dev server's port
 * directly) is seen. A hot-reload socket is not use. A tab left open reconnects
 * its socket every few minutes all night, whenever the laptop it is on wakes,
 * and logs no request doing it.
 *
 * While asleep, the sidecar holds the dev servers' ports and answers with a page
 * that wakes the workspace on a click, never on its own: a forgotten tab
 * reloading itself must not undo the sleep.
 */
export class Sleeper {
  private lastUse: number;
  private asleep = false;
  private holders: Server[] = [];
  private busy: Array<() => boolean> = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Sleep and wake run one at a time, in the order asked. */
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly deps: SleeperDeps) {
    this.now = deps.now ?? Date.now;
    this.lastUse = this.now();
  }

  get isAsleep(): boolean {
    return this.asleep;
  }

  get afterMinutes(): number {
    return Math.round(this.deps.afterMs / 60_000);
  }

  /** Something used the workspace just now. */
  touch(): void {
    this.lastUse = this.now();
  }

  /** A line a dev server printed: use, when it is a request. */
  readonly noteOutput = (line: string): void => {
    if (isRequestLine(line)) this.touch();
  };

  /** Never sleeps while this says the workspace is working (a batch, a session step). */
  busyWhen(fn: () => boolean): void {
    this.busy.push(fn);
  }

  start(): void {
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.chain;
    await this.release();
  }

  /** One look at the workspace; sleeps it when it has been idle long enough. */
  async check(): Promise<void> {
    if (this.asleep) return;
    if (this.busy.some((fn) => fn())) this.touch();
    if (this.now() - this.lastUse >= this.deps.afterMs) {
      console.log(`[tapthat] no use for ${this.afterMinutes} minutes`);
      await this.sleep();
    }
  }

  sleep(): Promise<void> {
    return this.enqueue(async () => {
      if (this.asleep) return;
      console.log('[tapthat] asleep: stopping the dev servers');
      this.asleep = true;
      this.deps.onChange?.(true);
      await this.deps.stopServers();
      this.holders = (await Promise.all(this.deps.ports.map((port) => this.hold(port)))).filter((s): s is Server => !!s);
    });
  }

  wake(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.asleep) return;
      console.log('[tapthat] waking: starting the dev servers');
      await this.release();
      this.asleep = false;
      this.deps.onChange?.(false);
      this.touch();
      this.deps.startServers();
    });
  }

  /** Answers a request that reached a sleeping workspace. */
  readonly answer = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === WAKE_PATH && req.method === 'POST') {
      void this.wake();
      res.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ asleep: false }));
      return;
    }
    const wantsPage = req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html');
    res.writeHead(503, {
      'content-type': wantsPage ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '60',
      [ASLEEP_HEADER]: '1',
    });
    res.end(wantsPage ? asleepPage(this.afterMinutes) : 'TapThat: this workspace is asleep. Open it in a browser to wake it.\n');
  };

  /** A hot-reload socket reaching a sleeping workspace: refused, so the tab stops trying. */
  readonly refuse = (_req: IncomingMessage, socket: Duplex): void => {
    socket.destroy();
  };

  private enqueue(op: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(op, op);
    return this.chain;
  }

  /** A stopped dev server's children can hold its port a moment longer, so retry briefly. */
  private async hold(port: number): Promise<Server | null> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const server = createServer(this.answer);
      server.on('upgrade', this.refuse);
      const listening = await new Promise<boolean>((done) => {
        server.once('error', () => done(false));
        server.listen(port, '::', () => done(true));
      });
      if (listening) return server;
      await new Promise((r) => setTimeout(r, 500));
    }
    console.warn(`[tapthat] could not hold port ${port} while asleep; requests to it will fail until something wakes the workspace`);
    return null;
  }

  private async release(): Promise<void> {
    const holders = this.holders;
    this.holders = [];
    await Promise.all(
      holders.map(
        (s) =>
          new Promise<void>((done) => {
            s.close(() => done());
            s.closeAllConnections();
          }),
      ),
    );
  }
}

function asleepPage(minutes: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Asleep</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #18181b; --muted: #71717a; --btn: #18181b; --btn-fg: #fafafa; }
  @media (prefers-color-scheme: dark) { :root { --bg: #09090b; --fg: #fafafa; --muted: #a1a1aa; --btn: #fafafa; --btn-fg: #18181b; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 26rem; padding: 0 16px; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { color: var(--muted); margin: 0 0 1.25rem; }
  button { font: inherit; padding: .5rem 1rem; border: 0; border-radius: 6px; background: var(--btn); color: var(--btn-fg); cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
</style>
</head>
<body>
<main>
  <h1>This workspace is asleep</h1>
  <p id="say">Its dev servers were stopped after ${minutes} minutes without use, to save memory. Waking takes a minute or two.</p>
  <button id="wake">Wake it up</button>
</main>
<script>
  const button = document.getElementById('wake');
  const say = document.getElementById('say');
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Waking up…';
    say.textContent = 'Starting the dev servers. This page reloads by itself when they answer.';
    try { await fetch('${WAKE_PATH}', { method: 'POST' }); } catch {}
  });
  // Looking does not wake it; whoever does, from here or the panel, brings this page back.
  const poll = async () => {
    try {
      const res = await fetch(location.href, { cache: 'no-store', headers: { accept: 'text/html' } });
      if (res.status < 500 && !res.headers.has('${ASLEEP_HEADER}')) return location.reload();
    } catch {}
    setTimeout(poll, 3000);
  };
  setTimeout(poll, 3000);
</script>
</body>
</html>
`;
}
