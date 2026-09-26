import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BatchStatus, SessionOutcome, SessionStatus } from 'tapthat-shared';

/** What is persisted of a session; the pending list and per-repo files are derived. */
export type StoredSession = Omit<SessionStatus, 'pending' | 'repos'> & { batchIds: string[] };

export interface StoredCredential {
  handle: string;
  fingerprint: string;
  kind: 'api_key' | 'oauth_token';
  /** AES-256-GCM, base64 iv:tag:ciphertext. Never returned to a client. */
  sealed: string;
  createdAt: string;
}

/**
 * The wire shape minus the live queue depth, plus the SSE token that must never
 * be returned by the status endpoint.
 */
export type StoredBatch = Omit<BatchStatus, 'queueDepth'> & {
  eventsToken: string;
  /** The comments' own words, for the session's commit message. */
  commentTexts?: string[];
  /** Which credential paid for this run ('env' or a handle), for per-credential limits. */
  credentialRef?: string;
};

interface Shape {
  version: 1;
  batches: Record<string, StoredBatch>;
  credentials: Record<string, StoredCredential>;
  session?: StoredSession | null;
  lastSession?: SessionOutcome | null;
}

const EMPTY: Shape = { version: 1, batches: {}, credentials: {}, session: null, lastSession: null };

/** Batches older than this are dropped on boot; git is the durable record. */
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A JSON file, not SQLite.
 *
 * The state here is one in-flight job, a few dozen batches and a handful of
 * credentials, with a single process and a single writer. A native sqlite addon
 * is the most likely thing to break `npx` on an unknown machine, and git already
 * holds anything that actually matters. The interface is deliberately narrow so
 * swapping the backing store later is a one-file change.
 */
export class Store {
  private data: Shape = structuredClone(EMPTY);
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  private constructor(private readonly path: string) {}

  static async open(path: string): Promise<Store> {
    const store = new Store(path);
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Shape;
      if (parsed.version === 1) store.data = { ...structuredClone(EMPTY), ...parsed };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A corrupt state file must not stop the sidecar booting — it holds
        // nothing that cannot be recreated.
        console.error(`[tapthat] ignoring unreadable state at ${path}: ${String(err)}`);
      }
    }
    store.prune();
    return store;
  }

  private prune(): void {
    const cutoff = Date.now() - RETAIN_MS;
    for (const [id, batch] of Object.entries(this.data.batches)) {
      if (Date.parse(batch.createdAt) < cutoff) delete this.data.batches[id];
    }
  }

  /** Write-temp-then-rename, so a crash mid-write cannot truncate the file. */
  private schedule(): void {
    if (this.dirty) return;
    this.dirty = true;
    this.writing = this.writing.then(async () => {
      await new Promise((r) => setTimeout(r, 50));
      this.dirty = false;
      const tmp = `${this.path}.${process.pid}.tmp`;
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(tmp, JSON.stringify(this.data, null, 2));
      await rename(tmp, this.path);
    }).catch((err) => {
      console.error(`[tapthat] failed to persist state: ${String(err)}`);
    });
  }

  async flush(): Promise<void> {
    await this.writing;
  }

  getBatch(id: string): StoredBatch | undefined {
    return this.data.batches[id];
  }

  putBatch(batch: StoredBatch): void {
    this.data.batches[batch.batchId] = batch;
    this.schedule();
  }

  /** Batch creation times within the window, optionally for one credential, for rate limiting. */
  recentBatchTimes(sinceMs: number, credentialRef?: string): number[] {
    return Object.values(this.data.batches)
      .filter((b) => credentialRef === undefined || b.credentialRef === credentialRef)
      .map((b) => Date.parse(b.createdAt))
      .filter((t) => t >= sinceMs);
  }

  getCredential(handle: string): StoredCredential | undefined {
    return this.data.credentials[handle];
  }

  putCredential(credential: StoredCredential): void {
    this.data.credentials[credential.handle] = credential;
    this.schedule();
  }

  deleteCredential(handle: string): boolean {
    if (!this.data.credentials[handle]) return false;
    delete this.data.credentials[handle];
    this.schedule();
    return true;
  }

  getSession(): StoredSession | null {
    return this.data.session ?? null;
  }

  /** Persists the session as it stands; call after every change to it. */
  putSession(session: StoredSession | null): void {
    this.data.session = session;
    this.schedule();
  }

  getLastSession(): SessionOutcome | null {
    return this.data.lastSession ?? null;
  }

  putLastSession(outcome: SessionOutcome): void {
    this.data.lastSession = outcome;
    this.schedule();
  }

  static defaultDir(repoRoot: string): string {
    return process.env.TAPTHAT_STATE_DIR ?? join(repoRoot, '.tapthat');
  }

  static defaultPath(repoRoot: string): string {
    return join(Store.defaultDir(repoRoot), 'state.json');
  }
}
