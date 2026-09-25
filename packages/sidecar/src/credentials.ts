import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { CredentialInfo } from '@tapthat/shared';
import { credentialKind, type Credential } from './agent';
import type { Store, StoredCredential } from './store';

const ALGO = 'aes-256-gcm';

export class CredentialError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Machine-readable, so the extension can tell "paste your key again" from other failures. */
    readonly code = 'request_failed',
  ) {
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

function aesSeal(plaintext: Buffer, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

function aesOpen(sealed: string, key: Buffer): Buffer {
  const [iv, tag, data] = sealed.split(':');
  if (!iv || !tag || !data) throw new CredentialError('Stored credential is malformed.', 500);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
}

const ENVELOPE = 'v2';

/**
 * Envelope encryption: each credential gets its own random data key, and only
 * that data key is encrypted with the master key. A master-key rotation then
 * means re-wrapping 32-byte keys rather than touching every secret, and no two
 * credentials share a key, so one leaked data key exposes one credential.
 */
export function seal(plaintext: string, masterKey: Buffer): string {
  const dataKey = randomBytes(32);
  return [ENVELOPE, aesSeal(dataKey, masterKey), aesSeal(Buffer.from(plaintext, 'utf8'), dataKey)].join('.');
}

export function unseal(sealed: string, masterKey: Buffer): string {
  if (sealed.startsWith(`${ENVELOPE}.`)) {
    const [, wrapped, data] = sealed.split('.');
    if (!wrapped || !data) throw new CredentialError('Stored credential is malformed.', 500);
    return aesOpen(data, aesOpen(wrapped, masterKey)).toString('utf8');
  }
  // Pre-envelope records, sealed directly with the master key.
  return aesOpen(sealed, masterKey).toString('utf8');
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
  if (!record) throw new CredentialError('Unknown credential handle. Paste your key again.', 401, 'credential_invalid');
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
      'credential_invalid',
    );
  }
}
