import {
  isTerminal,
  SSE_DONE_EVENT,
  type ApiError,
  type BatchAccepted,
  type BatchEvent,
  type BatchRequest,
  type BatchStatus,
  type CredentialInfo,
  type Health,
  type RevertAccepted,
  type SessionOutcome,
  type SessionResponse,
  type SidecarInfo,
} from 'tapthat-shared';

/**
 * The extension's only door to the sidecar. Used by the content script and the
 * options page alike, and free of chrome.* so it can be tested against a real
 * sidecar in Node.
 *
 * It runs in the content script rather than the service worker on purpose: an
 * MV3 worker is killed after ~30s idle, and a 10-40s agent run sits right on
 * that line. The content script lives as long as the tab.
 */
export class SidecarError extends Error {
  constructor(
    readonly status: number,
    /** The sidecar's machine-readable code, or 'network' when it was unreachable. */
    readonly code: string,
    message: string,
    readonly body: ApiError | null = null,
  ) {
    super(message);
  }
}

export interface WatchHandlers {
  onEvent(event: BatchEvent): void;
  onDone(status: BatchStatus): void;
  /** Contact lost; the watcher keeps retrying. Called again with null once it recovers. */
  onTrouble?(error: SidecarError | null): void;
}

export interface WatchOptions {
  /** Events up to and including this seq have already been seen (resume after reload). */
  afterSeq?: number;
  pollMs?: number;
}

export interface ClientOptions {
  baseUrl: string;
  token: string | null;
  fetch?: typeof fetch;
  /** Injectable for tests; defaults to the global, and polling is used without one. */
  EventSource?: typeof EventSource | null;
}

export type Client = ReturnType<typeof createClient>;

export function createClient(opts: ClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const ES = opts.EventSource === undefined ? (globalThis.EventSource ?? null) : opts.EventSource;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch {
      throw new SidecarError(0, 'network', `Can't reach the sidecar at ${base}.`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // In proxy mode a wrong path lands on the app, which answers with HTML.
      throw new SidecarError(
        res.status,
        'not_a_sidecar',
        `${base} answered, but not like a TapThat sidecar. In proxy mode the URL ends in /__tapthat.`,
      );
    }
    if (!res.ok) {
      const err = (parsed ?? { error: 'http_error' }) as ApiError;
      throw new SidecarError(res.status, err.error, err.message ?? `Sidecar returned ${res.status}.`, err);
    }
    return parsed as T;
  }

  const enc = encodeURIComponent;

  function watch(batchId: string, eventsToken: string | null, handlers: WatchHandlers, options: WatchOptions = {}) {
    let lastSeq = options.afterSeq ?? -1;
    let stopped = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const deliver = (event: BatchEvent) => {
      if (event.seq <= lastSeq) return;
      lastSeq = event.seq;
      handlers.onEvent(event);
    };
    const finish = (status: BatchStatus) => {
      if (stopped) return;
      for (const event of status.events) deliver(event);
      stop();
      handlers.onDone(status);
    };

    /**
     * Polling is the fallback, and against a 10-40s job it is indistinguishable
     * from streaming. The full event log comes back on every GET, so it also
     * resumes for free.
     */
    const poll = async () => {
      if (stopped) return;
      try {
        const status = await call<BatchStatus>('GET', `/api/batches/${enc(batchId)}`);
        if (failures) handlers.onTrouble?.(null);
        failures = 0;
        if (isTerminal(status.state)) {
          finish(status);
          return;
        }
        for (const event of status.events) deliver(event);
      } catch (err) {
        failures++;
        const error = err instanceof SidecarError ? err : new SidecarError(0, 'network', String(err));
        if (error.status === 404) {
          stop();
          handlers.onTrouble?.(new SidecarError(404, 'not_found', 'The sidecar no longer knows this batch.'));
          return;
        }
        handlers.onTrouble?.(error);
      }
      if (!stopped) {
        const delay = Math.min((options.pollMs ?? 1000) * 2 ** Math.min(failures, 4), 15_000);
        timer = setTimeout(() => void poll(), delay);
      }
    };

    const stream = () => {
      const url = `${base}/api/batches/${enc(batchId)}/events?t=${enc(eventsToken!)}`;
      source = new ES!(url);
      source.onmessage = (e) => {
        failures = 0;
        deliver(JSON.parse(e.data) as BatchEvent);
      };
      source.addEventListener(SSE_DONE_EVENT, (e) => finish(JSON.parse((e as MessageEvent).data) as BatchStatus));
      source.onerror = () => {
        // EventSource retries on its own (with Last-Event-ID). A CLOSED source
        // means it gave up — expired token, CORS, a proxy that buffers — so fall
        // back to polling rather than leaving the reviewer on a dead spinner.
        failures++;
        if (source?.readyState === 2 || failures > 3) {
          source?.close();
          source = null;
          failures = 0;
          void poll();
        }
      };
    };

    function stop() {
      stopped = true;
      source?.close();
      source = null;
      clearTimeout(timer);
    }

    if (ES && eventsToken) stream();
    else void poll();
    return stop;
  }

  return {
    baseUrl: base,
    health: () => call<Health>('GET', '/healthz'),
    info: () => call<SidecarInfo>('GET', '/api/config'),
    saveCredential: (credential: string) => call<CredentialInfo>('POST', '/api/credentials', { credential }),
    deleteCredential: (handle: string) => call<void>('DELETE', `/api/credentials/${enc(handle)}`),
    submit: (request: BatchRequest) => call<BatchAccepted>('POST', '/api/batches', request),
    get: (batchId: string) => call<BatchStatus>('GET', `/api/batches/${enc(batchId)}`),
    revert: (batchId: string) => call<RevertAccepted>('POST', `/api/batches/${enc(batchId)}/revert`),
    session: () => call<SessionResponse>('GET', '/api/session'),
    startSession: (reviewer: string | null) => call<SessionResponse>('POST', '/api/session/start', { reviewer: reviewer ?? undefined }),
    commitSession: (reviewer: string | null) => call<SessionOutcome>('POST', '/api/session/commit', { reviewer: reviewer ?? undefined }),
    discardSession: (reviewer: string | null) => call<SessionOutcome>('POST', '/api/session/discard', { reviewer: reviewer ?? undefined }),
    wake: () => call<{ asleep: boolean }>('POST', '/wake'),
    sleep: () => call<{ asleep: boolean }>('POST', '/api/sleep'),
    watch,
  };
}
