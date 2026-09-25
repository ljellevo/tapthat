import { request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { connect } from 'node:net';

/**
 * Forwards everything the sidecar does not own to the dev server, so the whole
 * environment is reachable on one port.
 *
 * This exists for hosts that expose a single HTTP port per service (see the
 * Railway notes in the plan). It also makes the extension same-origin with the
 * page, which removes the CORS preflight path entirely on those hosts.
 *
 * Deliberately built on node:http rather than a proxy library — the sidecar
 * ships with zero runtime dependencies and this is a pipe plus an upgrade
 * handler.
 */
export function createProxy(target: string) {
  const url = new URL(target);
  const targetHost = url.hostname;
  const targetPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));

  function web(req: IncomingMessage, res: ServerResponse): void {
    const upstream = request(
      {
        host: targetHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: url.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    upstream.on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        `TapThat: the dev server at ${target} is not responding.\n` +
          'It may still be starting up — reload in a few seconds.\n',
      );
    });

    req.pipe(upstream);
  }

  /**
   * HMR is a websocket, and HMR is the entire point of the fast path — without
   * forwarding the upgrade, changes land on disk but never reach the browser.
   */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const upstream = connect(targetPort, targetHost, () => {
      const headers = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\r\n');
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    const destroy = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on('error', destroy);
    socket.on('error', destroy);
  }

  return { web, upgrade };
}
