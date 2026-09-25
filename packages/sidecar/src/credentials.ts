import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { CredentialInfo } from '@tapthat/shared';
import { credentialKind, type Credential } from './agent';
import type { Store, StoredCredential } from './store';

const ALGO = 'aes-256-gcm';

export class CredentialError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Derives the encryption key. TAPTHAT_ENCRYPTION_KEY is env-only on purpose: a
 * key sitting in a committed config file protects nothing.
 *
 * Losing it is recoverable, not a disaster — stored credentials become
 * unreadable and each user pastes theirs again.
 */
export function deriveKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  // Accept either 32 raw bytes base64 or any passphrase, hashed to 32 bytes.
  const decoded = Buffer.from(raw, 'base64');
  return decoded.length === 32 ? decoded : createHash('sha256').update(raw).digest();
}

function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

function unseal(sealed: string, key: Buffer): string {
  const [iv, tag, data] = sealed.split(':');
  if (!iv || !tag || !data) throw new CredentialError('Stored credential is malformed.', 500);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/** Validation is reported by the HTTP layer, which knows whether it ran. */
export type IssuedCredential = Omit<CredentialInfo, 'validated'>;

export function fingerprint(raw: string): string {
  return raw.slice(-4);
}

/**
 * Stores a credential and returns an opaque handle. The raw value never goes
 * back to the browser — chrome.storage.local is inspectable, so the extension
 * holds only the handle and a four-character fingerprint.
 */
export function issue(raw: string, key: Buffer | null, store: Store): IssuedCredential {
  const trimmed = raw.trim();
  const kind = credentialKind(trimmed);
  if (!kind) {
    throw new CredentialError(
      'Unrecognised credential. Expected an API key (sk-ant-…) or an OAuth token from `claude setup-token` (sk-ant-oat01-…).',
      400,
    );
  }
  if (!key) {
    throw new CredentialError(
      'TAPTHAT_ENCRYPTION_KEY is not set, so credentials cannot be stored. Generate one with `openssl rand -base64 32`.',
      503,
    );
  }

  const record: StoredCredential = {
    handle: `cred_${randomUUID().replace(/-/g, '')}`,
    fingerprint: fingerprint(trimmed),
    kind,
    sealed: seal(trimmed, key),
    createdAt: new Date().toISOString(),
  };
  store.putCredential(record);
  return { handle: record.handle, fingerprint: record.fingerprint, kind: record.kind };
}

export function resolve(handle: string, key: Buffer | null, store: Store): Credential {
  const record = store.getCredential(handle);
  if (!record) throw new CredentialError('Unknown credential handle. Paste your key again.', 401);
  if (!key) throw new CredentialError('TAPTHAT_ENCRYPTION_KEY is not set; stored credentials cannot be read.', 503);
  try {
    return { raw: unseal(record.sealed, key), kind: record.kind };
  } catch {
    // Key rotated or the file moved between machines. Recoverable: drop it and
    // let the user re-paste rather than failing every future request.
    store.deleteCredential(handle);
    throw new CredentialError(
      'Stored credential could not be decrypted (the encryption key changed). Paste your key again.',
      401,
    );
  }
}
