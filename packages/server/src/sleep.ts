import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/** The public route that wakes a sleeping workspace, under the sidecar's prefix. */
export const WAKE_PATH = '/__tapthat/wake';

/** Marks a response as the asleep page, so the page's own polling can tell it from the app. */
const ASLEEP_HEADER = 'x-tapthat-asleep';

const CHECK_EVERY_MS = 60_000;

export interface SleeperDeps {
  /** Stopped after this long without use. */
  afterMs: number;
  /** The dev servers' ports: watched for traffic while awake, held while asleep. */
  ports: number[];
  stopServers: () => Promise<void>;
  startServers: () => void;
  /** Remote connections to `ports`, or null where the platform can't tell (not Linux). */
  connections?: (ports: number[]) => Promise<Set<string> | null>;
  now?: () => number;
}

/**
 * Stops every dev server after a stretch without use, and starts them again on
 * request. Most of a playground's life is idle, and its dev servers are most of
 * its memory; what is left asleep is this process.
 *
 * Use is what reaches the dev servers or the sidecar. Traffic that comes past the
 * sidecar (a gateway calling a dev server's port directly) is seen as a change
 * in the set of connections to those ports: a new page load opens one, and an
 * upstream pool closes its idle ones within minutes. An open tab's hot-reload
 * socket changes nothing, so a tab left open overnight does not keep it awake.
 *
 * While asleep, the sidecar holds the dev servers' ports and answers with a page
 * that wakes the workspace on a click, never on its own: a forgotten tab
 * reloading itself must not undo the sleep.
 */
export class Sleeper {
  private lastUse: number;
  private asleep = false;
  private holders: Server[] = [];
  private seen: Set<string> | null = null;
  private busy: Array<() => boolean> = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Sleep and wake run one at a time, in the order asked. */
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly connections: (ports: number[]) => Promise<Set<string> | null>;

  constructor(private readonly deps: SleeperDeps) {
    this.now = deps.now ?? Date.now;
    this.connections = deps.connections ?? remoteConnections;
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
    const current = await this.connections(this.deps.ports);
    if (current && this.seen && !sameSet(current, this.seen)) this.touch();
    this.seen = current;
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
      this.seen = null;
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

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Established connections to `ports` from outside this machine, by socket
 * inode, read from /proc/net. Loopback is left out: those are the dev servers
 * calling each other, and the sidecar's own proxy, which touches on its own.
 */
export async function remoteConnections(ports: number[]): Promise<Set<string> | null> {
  const wanted = new Set(ports);
  const found = new Set<string>();
  let readable = false;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
      readable = true;
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const conn = parseProcNetLine(line);
      if (conn && conn.established && !conn.loopback && wanted.has(conn.localPort)) found.add(conn.inode);
    }
  }
  return readable ? found : null;
}

/** One row of /proc/net/tcp or tcp6. */
export function parseProcNetLine(
  line: string,
): { localPort: number; established: boolean; loopback: boolean; inode: string } | null {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 10) return null;
  const [local, remote, state, inode] = [fields[1]!, fields[2]!, fields[3]!, fields[9]!];
  const localPort = parseInt(local.split(':')[1] ?? '', 16);
  const remoteHost = remote.split(':')[0] ?? '';
  if (!Number.isFinite(localPort)) return null;
  return {
    localPort,
    established: state === '01',
    // 127.0.0.1 (also as ::ffff:127.0.0.1) and ::1, as the kernel writes them.
    loopback: remoteHost.endsWith('0100007F') || remoteHost === '00000000000000000000000001000000',
    inode,
  };
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
