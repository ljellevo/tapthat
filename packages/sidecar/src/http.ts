import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { makeAgentRunner, type Credential } from './agent';
import type { Config } from './config';
import { CredentialError, issue, resolve as resolveCredential } from './credentials';
import { sequencer, type BatchEvent } from './events';
import { runJob, type BatchRequest } from './job';
import { createProxy } from './proxy';
import { Queue } from './queue';
import type { Repo } from './repo';
import type { Store, StoredBatch } from './store';
import { makeVerifier } from './verify';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface ServerDeps {
  config: Config;
  repo: Repo;
  store: Store;
  encryptionKey: Buffer | null;
  token: string | null;
  envCredential: Credential | null;
  version: string;
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

export function createHttpServer(deps: ServerDeps): Server {
  const { config, repo, store } = deps;
  const queue = new Queue();
  const proxy = config.proxy.enabled ? createProxy(config.proxy.target ?? config.devServerUrl) : null;

  /** Exact-match only — no wildcards, no prefix matching. */
  const originAllowed = (origin: string | undefined): boolean =>
    !!origin && config.allowedOrigins.includes(origin);

  function applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (originAllowed(origin)) {
      res.setHeader('access-control-allow-origin', origin!);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
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

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;

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
        killSwitch: config.killSwitch,
      });
      return;
    }

    // Everything past here is a repo-write primitive or touches credentials.
    if (!authorized(req)) {
      json(res, 401, { error: 'unauthorized', message: 'Missing or invalid bearer token.' });
      return;
    }
    // The Origin check is a second, independent gate: a token that leaks is not
    // enough on its own to drive this from an arbitrary page.
    if (req.headers.origin && !originAllowed(req.headers.origin)) {
      json(res, 403, { error: 'origin_not_allowed', message: `Origin ${req.headers.origin} is not in allowedOrigins.` });
      return;
    }

    if (path === '/api/credentials' && req.method === 'POST') {
      const body = (await readBody(req)) as { credential?: string };
      if (typeof body.credential !== 'string') {
        json(res, 400, { error: 'bad_request', message: 'Expected { credential: "sk-ant-…" }.' });
        return;
      }
      json(res, 200, { ...issue(body.credential, deps.encryptionKey, store), validated: false });
      return;
    }

    if (path.startsWith('/api/credentials/') && req.method === 'DELETE') {
      const handle = decodeURIComponent(path.slice('/api/credentials/'.length));
      store.deleteCredential(handle);
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
      const { eventsToken: _omit, ...safe } = batch;
      json(res, 200, { ...safe, queueDepth: queue.depth(config.branch) });
      return;
    }

    const revertMatch = /^\/api\/batches\/([^/]+)\/revert$/.exec(path);
    if (revertMatch && req.method === 'POST') {
      await handleRevert(res, decodeURIComponent(revertMatch[1]!));
      return;
    }

    json(res, 404, { error: 'not_found' });
  }

  async function handleSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (config.killSwitch) {
      json(res, 503, { error: 'kill_switch', message: 'The sidecar is accepting no new work.' });
      return;
    }

    const batch = (await readBody(req)) as BatchRequest;
    if (!batch?.batchId || !Array.isArray(batch.comments) || !batch.page) {
      json(res, 400, { error: 'bad_request', message: 'Expected { batchId, page, comments }.' });
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
        json(res, 403, {
          error: 'page_not_allowed',
          message: `Comments were captured on ${pageOrigin ?? batch.page.url}, which is not in allowedOrigins.`,
        });
        return;
      }
    }

    const windowStart = Date.now() - 60 * 60 * 1000;
    if (store.recentBatchTimes(windowStart).length >= config.limits.batchesPerHour) {
      json(res, 429, {
        error: 'rate_limited',
        message: `Limit of ${config.limits.batchesPerHour} batches per hour reached.`,
      });
      return;
    }

    let credential: Credential | null = deps.envCredential;
    if (batch.credentialHandle) {
      credential = resolveCredential(batch.credentialHandle, deps.encryptionKey, store);
    }
    if (!credential) {
      json(res, 401, {
        error: 'no_credential',
        message: 'No credential supplied and none configured on the sidecar.',
      });
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
      result: null,
      error: null,
    };
    store.putBatch(record);

    json(res, 202, {
      batchId: record.batchId,
      state: record.state,
      queueDepth: queue.depth(config.branch),
      baseSha: record.baseSha,
      branch: record.branch,
      eventsToken: record.eventsToken,
    });

    // Runs after the response: the extension polls for progress.
    void runQueued(batch, record, credential);
  }

  async function runQueued(batch: BatchRequest, record: StoredBatch, credential: Credential): Promise<void> {
    const started = Date.now();
    const emit = sequencer((event: BatchEvent) => {
      const current = store.getBatch(record.batchId);
      if (!current) return;
      current.events.push(event);
      if (event.type === 'started') current.state = 'running';
      store.putBatch(current);
    });

    try {
      const result = await queue.run(config.branch, () =>
        runJob(
          batch,
          {
            repo,
            config: {
              allowDirty: config.git.allowDirty,
              git: { enabled: config.git.enabled, author: config.git.author },
              timeoutMs: config.agent.timeoutMs,
              maxCommentsPerBatch: config.agent.maxCommentsPerBatch,
            },
            runAgent: makeAgentRunner({ config, credential }),
            verify: makeVerifier(config.verifyCommand, config.repoRoot),
          },
          emit,
        ),
      );

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
    }
  }

  async function handleRevert(res: ServerResponse, batchId: string): Promise<void> {
    const batch = store.getBatch(batchId);
    if (!batch) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const sha = batch.result?.sha;
    if (!sha) {
      json(res, 409, { error: 'nothing_to_revert', message: 'This batch produced no commit.' });
      return;
    }
    if (!(await repo.isClean())) {
      json(res, 409, { error: 'dirty', message: 'The working tree has uncommitted changes; revert refused.' });
      return;
    }

    const outcome = await repo.revert(sha);
    if (!outcome.ok) {
      json(res, 409, { error: 'conflict', conflicts: outcome.conflicts });
      return;
    }
    batch.state = 'reverted';
    store.putBatch(batch);
    json(res, 202, { revertSha: outcome.sha });
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
    const ours = url.pathname === '/healthz' || url.pathname.startsWith('/api/');

    if (!ours && proxy) {
      proxy.web(req, res);
      return;
    }

    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(originAllowed(req.headers.origin) ? 204 : 403).end();
      return;
    }

    handleApi(req, res, url).catch((err) => {
      const status = err instanceof CredentialError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 500) console.error(`[tapthat] ${message}`);
      json(res, status, { error: status === 500 ? 'internal' : 'request_failed', message });
    });
  });

  if (proxy) server.on('upgrade', proxy.upgrade);
  return server;
}
