import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { log, scrub } from './log';

export type AuditEvent =
  | 'auth.rejected'
  | 'origin.rejected'
  | 'credential.issued'
  | 'credential.revoked'
  | 'batch.accepted'
  | 'batch.rejected'
  | 'batch.finished'
  | 'batch.reverted'
  | 'session.started'
  | 'session.failed'
  | 'session.committed'
  | 'session.discarded'
  | 'session.restored';

/**
 * Append-only record of who asked the sidecar to do what. The endpoint is a
 * repo-write primitive, so "what happened and from where" must be answerable
 * after the fact without trawling the agent's chatter. One JSON object per
 * line, scrubbed like every other log line, and mirrored to stdout so a PaaS
 * log view shows it too.
 */
export function createAudit(path: string | null, { mirror = true }: { mirror?: boolean } = {}) {
  let writing: Promise<void> = Promise.resolve();
  return function audit(event: AuditEvent, fields: Record<string, unknown> = {}): void {
    if (mirror) log('info', event, { audit: true, ...fields });
    if (!path) return;
    const line = `${scrub(JSON.stringify({ at: new Date().toISOString(), event, ...fields }))}\n`;
    writing = writing
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, line);
      })
      .catch((err) => log('error', 'audit write failed', { error: String(err) }));
  };
}

export type Audit = ReturnType<typeof createAudit>;
