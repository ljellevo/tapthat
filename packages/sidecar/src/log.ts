const secrets = new Set<string>();

/**
 * Registers a value that must never appear in output. Credentials reach this
 * process in plaintext and flow near both the logger and the agent's stdout, so
 * redaction is centralised rather than left to each call site.
 */
export function addSecret(value: string): void {
  if (value && value.length >= 8) secrets.add(value);
}

export function forgetSecret(value: string): void {
  secrets.delete(value);
}

export function scrub(text: string): string {
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join('[redacted]');
  }
  // Belt and braces: catch key shapes that were never registered, e.g. one the
  // agent echoed back from a file it read.
  return out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[redacted]');
}

export function log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...fields });
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${scrub(line)}\n`);
}
