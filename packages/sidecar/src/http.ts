import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  isTerminal,
  SSE_DONE_EVENT,
  type BatchAccepted,
  type BatchEvent,
  type BatchRequest,
  type BatchStatus,
  type CredentialInfo,
  type Health,
  type RevertAccepted,
  type SidecarInfo,
} from '@tapthat/shared';
import { makeAgentRunner, type Credential } from './agent';
import type { Audit } from './audit';
import type { Config } from './config';
import { CredentialError, issue, resolve as resolveCredential } from './credentials';
import { runJob } from './job';
import { createProxy } from './proxy';
import { Queue } from './queue';
import type { Repo } from './repo';
import type { Store, StoredBatch } from './store';
import { makeVerifier } from './verify';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Keeps idle SSE connections alive through PaaS edges that drop quiet sockets. */
const SSE_HEARTBEAT_MS = 15_000;
/** eventsToken is batch-scoped and short-lived: long enough to watch a run, not to keep. */
const EVENTS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Every sidecar route is also served under this prefix, and in proxy mode it is
 * the only way in. The app behind the proxy owns the rest of the path space —
 * a Next.js app with its own /api/* routes would otherwise be shadowed by ours.
 */
export const ROUTE_PREFIX = '/__tapthat';

/** The sidecar path a request addresses, or null when it belongs to the dev server. */
export function sidecarPath(pathname: string, proxying: boolean): string | null {
  if (pathname === ROUTE_PREFIX || pathname.startsWith(`${ROUTE_PREFIX}/`)) {
    return pathname.slice(ROUTE_PREFIX.length) || '/';
  }
  if (proxying) return null;
  return pathname;
}

export interface ServerDeps {
  config: Config;
  repo: Repo;
  store: Store;
  encryptionKey: Buffer | null;
  token: string | null;
  envCredential: Credential | null;
  version: string;
  /** `claude --version` as probed at boot, or null when the CLI is missing. */
  agentVersion?: string | null;
  audit?: Audit;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new CredentialError('Request body too large.', 413);
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CredentialError('Request body is not valid JSON.', 400);
  }
}

function toStatus(batch: StoredBatch, queueDepth: number): BatchStatus {
  const { eventsToken: _token, credentialRef: _ref, ...wire } = batch;
  return { ...wire, queueDepth };
}

export function createHttpServer(deps: ServerDeps): Server {
  const { config, repo, store } = deps;
  const audit: Audit = deps.audit ?? (() => {});
  const queue = new Queue();
  const proxy = config.proxy.enabled ? createProxy(config.proxy.target ?? config.devServerUrl) : null;
  /** Open SSE responses per batch. */
  const streams = new Map<string, Set<ServerResponse>>();

  /** Exact-match only — no wildcards, no prefix matching. */
  const originAllowed = (origin: string | undefined): boolean =>
    !!origin && config.allowedOrigins.includes(origin);

  /**
   * The extension's own pages (options) send Origin: chrome-extension://<id>.
   * The Origin gate exists to stop an arbitrary web page from driving the
   * sidecar with a leaked token; an extension can set any header it likes, so
   * gating extension origins would add friction and no protection. These
   * requests still need the token, and a batch still needs an allowlisted page.
   */
  const extensionOrigin = (origin: string | undefined): boolean => !!origin && origin.startsWith('chrome-extension://');

  function applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (originAllowed(origin)) {
      res.setHeader('access-control-allow-origin', origin!);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, last-event-id');
      res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('access-control-max-age', '600');
    }
  }

  function authorized(req: IncomingMessage): boolean {
    if (config.auth.mode === 'none') return true;
    if (!deps.token) return false;
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    return presented.length > 0 && safeEqual(presented, deps.token);
  }

  // ── events ───────────────────────────────────────────────────────────────

  /** Appends to the batch's log with the next seq, persists, and fans out to SSE. */
  function appendEvent(batchId: string, event: Omit<BatchEvent, 'seq' | 'at' | 'batchId'>): void {
    const batch = store.getBatch(batchId);
    if (!batch) return;
    const full: BatchEvent = {
      ...event,
      batchId,
      seq: (batch.events.at(-1)?.seq ?? -1) + 1,
      at: new Date().toISOString(),
    };
    batch.events.push(full);
    if (full.type === 'started') batch.state = 'running';
    store.putBatch(batch);
    for (const res of streams.get(batchId) ?? []) writeEvent(res, full);
  }

  function writeEvent(res: ServerResponse, event: BatchEvent): void {
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  function writeDone(res: ServerResponse, batch: StoredBatch): void {
    res.write(`event: ${SSE_DONE_EVENT}\ndata: ${JSON.stringify(toStatus(batch, queue.depth(config.branch)))}\n\n`);
    res.end();
  }

  function finishStreams(batchId: string): void {
    const batch = store.getBatch(batchId);
    const open = streams.get(batchId);
    if (!batch || !open) return;
    for (const res of open) writeDone(res, batch);
    streams.delete(batchId);
  }

  function handleEvents(req: IncomingMessage, res: ServerResponse, batchId: string, url: URL): void {
    const batch = store.getBatch(batchId);
    const presented = url.searchParams.get('t') ?? '';
    // EventSource cannot send an Authorization header, so the stream is gated by
    // the batch-scoped token handed out when the batch was accepted.
    const fresh = batch && Date.now() - Date.parse(batch.createdAt) < EVENTS_TOKEN_TTL_MS;
    if (!batch || !fresh || !presented || !safeEqual(presented, batch.eventsToken)) {
      json(res, 401, { error: 'unauthorized', message: 'Missing, invalid or expired events token.' });
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Stops nginx-style edges from buffering the stream into one late burst.
      'x-accel-buffering': 'no',
    });

    const lastHeader = req.headers['last-event-id'];
    const last = Number(Array.isArray(lastHeader) ? lastHeader[0] : (lastHeader ?? -1));
    for (const event of batch.events) {
      if (event.seq > (Number.isFinite(last) ? last : -1)) writeEvent(res, event);
    }

    if (isTerminal(batch.state)) {
      writeDone(res, batch);
      return;
    }

    const set = streams.get(batchId) ?? new Set<ServerResponse>();
    set.add(res);
    streams.set(batchId, set);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    res.on('close', () => {
      clearInterval(heartbeat);
      set.delete(res);
      if (!set.size) streams.delete(batchId);
    });
  }

  // ── routes ───────────────────────────────────────────────────────────────

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    if (path === '/healthz' && req.method === 'GET') {
      const status = await repo.status().catch(() => null);
      json(res, 200, {
        status: config.killSwitch ? 'degraded' : 'ok',
        version: deps.version,
        repo: {
          branch: await repo.branch().catch(() => null),
          head: await repo.head().catch(() => null),
          clean: status ? status.dirty.length === 0 && status.untracked.length === 0 : null,
        },
        devServer: { reachable: await devServerReachable(), url: config.devServerUrl },
        queue: { depth: queue.depth(config.branch), running: queue.isRunning(config.branch) },
        agent: { cliVersion: deps.agentVersion ?? null, envCredential: !!deps.envCredential },
        killSwitch: config.killSwitch,
      } satisfies Health);
      return;
    }

    const eventsMatch = /^\/api\/batches\/([^/]+)\/events$/.exec(path);
    if (eventsMatch && req.method === 'GET') {
      if (req.headers.origin && !originAllowed(req.headers.origin)) {
        json(res, 403, { error: 'origin_not_allowed' });
        return;
      }
      handleEvents(req, res, decodeURIComponent(eventsMatch[1]!), url);
      return;
    }

    // Everything past here is a repo-write primitive or touches credentials.
    if (!authorized(req)) {
      audit('auth.rejected', { path, origin: req.headers.origin ?? null });
      json(res, 401, { error: 'unauthorized', message: 'Missing or invalid bearer token.' });
      return;
    }
    // The Origin check is a second, independent gate: a token that leaks is not
    // enough on its own to drive this from an arbitrary page.
    if (req.headers.origin && !originAllowed(req.headers.origin) && !extensionOrigin(req.headers.origin)) {
      audit('origin.rejected', { path, origin: req.headers.origin });
      json(res, 403, { error: 'origin_not_allowed', message: `Origin ${req.headers.origin} is not in allowedOrigins.` });
      return;
    }

    if (path === '/api/config' && req.method === 'GET') {
      json(res, 200, {
        version: deps.version,
        branch: config.branch,
        allowedOrigins: config.allowedOrigins,
        proxy: config.proxy.enabled,
        push: config.git.push,
      } satisfies SidecarInfo);
      return;
    }

    if (path === '/api/credentials' && req.method === 'POST') {
      const body = (await readBody(req)) as { credential?: string };
      if (typeof body.credential !== 'string') {
        json(res, 400, { error: 'bad_request', message: 'Expected { credential: "sk-ant-…" }.' });
        return;
      }
      const info = issue(body.credential, deps.encryptionKey, store);
      audit('credential.issued', { handle: info.handle, kind: info.kind, fingerprint: info.fingerprint });
      // Validated lazily, on first use: there is no free no-op call to check a key
      // with, and a paid one on every paste would be a cost the reviewer never sees.
      json(res, 200, { ...info, validated: false } satisfies CredentialInfo);
      return;
    }

    if (path.startsWith('/api/credentials/') && req.method === 'DELETE') {
      const handle = decodeURIComponent(path.slice('/api/credentials/'.length));
      if (store.deleteCredential(handle)) audit('credential.revoked', { handle });
      res.writeHead(204).end();
      return;
    }

    if (path === '/api/batches' && req.method === 'POST') {
      await handleSubmit(req, res);
      return;
    }

    const batchMatch = /^\/api\/batches\/([^/]+)$/.exec(path);
    if (batchMatch && req.method === 'GET') {
      const batch = store.getBatch(decodeURIComponent(batchMatch[1]!));
      if (!batch) {
        json(res, 404, { error: 'not_found' });
        return;
      }
      json(res, 200, toStatus(batch, queue.depth(config.branch)));
      return;
    }

    const revertMatch = /^\/api\/batches\/([^/]+)\/revert$/.exec(path);
    if (revertMatch && req.method === 'POST') {
      await handleRevert(res, decodeURIComponent(revertMatch[1]!));
      return;
    }

    json(res, 404, { error: 'not_found' });
  }

  function reject(res: ServerResponse, status: number, body: { error: string; message?: string }, batchId?: string) {
    audit('batch.rejected', { batchId: batchId ?? null, status, error: body.error });
    json(res, status, body);
  }

  async function handleSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (config.killSwitch) {
      reject(res, 503, { error: 'kill_switch', message: 'The sidecar is accepting no new work.' });
      return;
    }

    const batch = (await readBody(req)) as BatchRequest;
    if (!batch?.batchId || !Array.isArray(batch.comments) || !batch.page) {
      reject(res, 400, { error: 'bad_request', message: 'Expected { batchId, page, comments }.' });
      return;
    }

    // Idempotency: a retry after a dropped response must not run the agent twice.
    const existing = store.getBatch(batch.batchId);
    if (existing) {
      json(res, 409, { error: 'duplicate', batchId: existing.batchId, state: existing.state });
      return;
    }

    // The page the comments came from must itself be allowlisted — the Origin
    // header alone says where the request came from, not what it describes.
    if (config.allowedOrigins.length > 0) {
      let pageOrigin: string | null = null;
      try {
        pageOrigin = new URL(batch.page.url).origin;
      } catch {
        /* handled below */
      }
      if (!pageOrigin || !config.allowedOrigins.includes(pageOrigin)) {
        reject(res, 403, {
          error: 'page_not_allowed',
          message: `Comments were captured on ${pageOrigin ?? batch.page.url}, which is not in allowedOrigins.`,
        }, batch.batchId);
        return;
      }
    }

    let credential: Credential | null = deps.envCredential;
    let credentialRef = 'env';
    if (batch.credentialHandle) {
      credential = resolveCredential(batch.credentialHandle, deps.encryptionKey, store);
      credentialRef = batch.credentialHandle;
    }
    if (!credential) {
      reject(res, 401, {
        error: 'no_credential',
        message: 'No credential supplied and none configured on the sidecar.',
      }, batch.batchId);
      return;
    }

    // Two ceilings: one per credential, so an extension stuck in a loop burns its
    // own budget and not the whole team's, and one global, as a backstop.
    const windowStart = Date.now() - 60 * 60 * 1000;
    if (store.recentBatchTimes(windowStart, credentialRef).length >= config.limits.batchesPerHourPerCredential) {
      reject(res, 429, {
        error: 'rate_limited',
        message: `Limit of ${config.limits.batchesPerHourPerCredential} batches per hour for this credential reached.`,
      }, batch.batchId);
      return;
    }
    if (store.recentBatchTimes(windowStart).length >= config.limits.batchesPerHour) {
      reject(res, 429, {
        error: 'rate_limited',
        message: `Limit of ${config.limits.batchesPerHour} batches per hour reached.`,
      }, batch.batchId);
      return;
    }

    const record: StoredBatch = {
      batchId: batch.batchId,
      state: 'queued',
      createdAt: new Date().toISOString(),
      baseSha: await repo.head().catch(() => null),
      branch: config.branch,
      pageUrl: batch.page.url,
      commentIds: batch.comments.map((c) => c.id),
      events: [],
      eventsToken: `ev_${randomUUID().replace(/-/g, '')}`,
      credentialRef,
      result: null,
      error: null,
    };
    store.putBatch(record);
    const ahead = queue.depth(config.branch);
    appendEvent(record.batchId, { type: 'accepted', message: `${batch.comments.length} comment(s)` });
    appendEvent(record.batchId, {
      type: 'queued',
      message: ahead ? `${ahead} job${ahead === 1 ? '' : 's'} ahead` : 'next in line',
    });
    audit('batch.accepted', {
      batchId: record.batchId,
      credential: credentialRef,
      comments: batch.comments.length,
      page: batch.page.url,
      client: batch.client ?? null,
    });

    json(res, 202, {
      batchId: record.batchId,
      state: record.state,
      queueDepth: ahead,
      baseSha: record.baseSha,
      branch: record.branch,
      eventsToken: record.eventsToken,
    } satisfies BatchAccepted);

    // Runs after the response: the extension watches for progress.
    void runQueued(batch, record, credential);
  }

  async function runQueued(batch: BatchRequest, record: StoredBatch, credential: Credential): Promise<void> {
    const started = Date.now();
    const emit = (event: Omit<BatchEvent, 'seq' | 'at'>) => {
      const { batchId: _id, ...rest } = event;
      appendEvent(record.batchId, rest);
    };

    try {
      const result = await queue.run(config.branch, async () => {
        const outcome = await runJob(
          batch,
          {
            repo,
            config: {
              allowDirty: config.git.allowDirty,
              git: { enabled: config.git.enabled, author: config.git.author },
              timeoutMs: config.agent.timeoutMs,
              maxCommentsPerBatch: config.agent.maxCommentsPerBatch,
            },
            runAgent: makeAgentRunner({
              config,
              credential,
              onMessage: (text) => emit({ batchId: record.batchId, type: 'agent-message', message: text.slice(0, 500) }),
            }),
            verify: makeVerifier(config.verifyCommand, config.repoRoot),
          },
          emit,
        );
        // Still inside the queue slot: a push racing the next job's commit would
        // push a half-finished history.
        if (outcome.sha && config.git.push) await push();
        return outcome;
      });

      const current = store.getBatch(record.batchId);
      if (!current) return;
      current.state = result.state;
      current.result = {
        summary: result.summary ?? '',
        filesChanged: result.filesChanged,
        sha: result.sha,
        durationMs: Date.now() - started,
      };
      current.error = result.error ?? null;
      store.putBatch(current);
    } catch (err) {
      const current = store.getBatch(record.batchId);
      if (!current) return;
      current.state = 'failed';
      current.error = { kind: 'agent', message: err instanceof Error ? err.message : String(err) };
      store.putBatch(current);
      appendEvent(record.batchId, { type: 'failed', message: current.error.message });
    }

    const final = store.getBatch(record.batchId);
    audit('batch.finished', {
      batchId: record.batchId,
      state: final?.state,
      sha: final?.result?.sha ?? null,
      files: final?.result?.filesChanged ?? [],
      error: final?.error?.kind ?? null,
    });
    finishStreams(record.batchId);

    async function push(): Promise<void> {
      try {
        await repo.push(config.git.remote, config.branch);
        emit({ batchId: record.batchId, type: 'pushed', message: `${config.git.remote}/${config.branch}` });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ batchId: record.batchId, type: 'push-failed', message });
      }
    }
  }

  async function handleRevert(res: ServerResponse, batchId: string): Promise<void> {
    const batch = store.getBatch(batchId);
    if (!batch) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const sha = batch.result?.sha;
    if (!sha || batch.state === 'reverted') {
      json(res, 409, {
        error: 'nothing_to_revert',
        message: batch.state === 'reverted' ? 'This batch has already been undone.' : 'This batch produced no commit.',
      });
      return;
    }

    // A revert is a git operation on the shared tree, so it takes the same queue
    // slot as a job rather than racing one.
    const outcome = await queue.run(config.branch, async () => {
      if (!(await repo.isClean())) return { kind: 'dirty' as const };
      const reverted = await repo.revert(sha, config.git.author);
      if (reverted.ok && config.git.push) {
        await repo.push(config.git.remote, config.branch).catch(() => {});
      }
      return { kind: 'done' as const, reverted };
    });

    if (outcome.kind === 'dirty') {
      json(res, 409, { error: 'dirty', message: 'The working tree has uncommitted changes; undo refused.' });
      return;
    }
    if (!outcome.reverted.ok) {
      const conflicted = outcome.reverted.conflicts.length > 0;
      json(res, 409, {
        error: conflicted ? 'conflict' : 'revert_failed',
        message: conflicted
          ? 'A later change touched the same lines, so this batch cannot be undone on its own.'
          : `git could not revert this batch: ${outcome.reverted.message}`,
        conflicts: outcome.reverted.conflicts,
      });
      return;
    }

    const current = store.getBatch(batchId)!;
    current.state = 'reverted';
    store.putBatch(current);
    appendEvent(batchId, { type: 'reverted', sha: outcome.reverted.sha });
    audit('batch.reverted', { batchId, sha, revertSha: outcome.reverted.sha });
    json(res, 202, { revertSha: outcome.reverted.sha } satisfies RevertAccepted);
  }

  async function devServerReachable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      await fetch(config.devServerUrl, { signal: controller.signal });
      clearTimeout(timer);
      return true;
    } catch {
      return false;
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = sidecarPath(url.pathname, !!proxy);

    if (path === null) {
      proxy!.web(req, res);
      return;
    }

    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(originAllowed(req.headers.origin) ? 204 : 403).end();
      return;
    }

    handleApi(req, res, path, url).catch((err) => {
      const status = err instanceof CredentialError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 500) console.error(`[tapthat] ${message}`);
      const code = err instanceof CredentialError ? err.code : 'internal';
      if (!res.headersSent) json(res, status, { error: code, message });
    });
  });

  if (proxy) server.on('upgrade', proxy.upgrade);
  return server;
}
