import {
  StorageConnectionCredentialSchema,
  type StorageConnectionCredential,
} from '@indx-workspace/contracts/storage-connections';
import { parseStorageUrl } from '@indx-workspace/contracts/storage-url';
import { z } from 'zod';

/** Where a URL's credential is sent: everything the URL names but its prefix. */
export function credentialTarget(url: string): string | null {
  const parsed = parseStorageUrl(url);
  return parsed.ok ? JSON.stringify({ ...parsed.location, prefix: '' }) : null;
}

// The stored secret is the credential sealed with the target it was supplied for, so a reader can
// never pair it with another endpoint. A secret written before this binding is the bare credential.
const BoundCredentialSchema = z
  .object({ target: z.string(), credential: StorageConnectionCredentialSchema })
  .strict();

type StoredCredential = {
  readonly target: string | null;
  readonly credential: StorageConnectionCredential;
};

export function storedCredential(value: Buffer | undefined): StoredCredential | null {
  if (value === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(value.toString('utf8'));
  } catch {
    return null;
  }
  const bound = BoundCredentialSchema.safeParse(json);
  if (bound.success) return bound.data;
  const bare = StorageConnectionCredentialSchema.safeParse(json);
  return bare.success ? { target: null, credential: bare.data } : null;
}

/**
 * The credential in a stored secret, only when it was bound to `url`'s target: `null` for a secret
 * bound to another target, a bare (pre-binding) credential, a value that is no credential, or a URL
 * naming no target. Nothing here quotes the stored value.
 */
export function boundCredential(
  value: Buffer | undefined,
  url: string,
): StorageConnectionCredential | null {
  const stored = storedCredential(value);
  const target = credentialTarget(url);
  return stored !== null && stored.target !== null && target !== null && stored.target === target
    ? stored.credential
    : null;
}

export function sealedCredential(url: string, credential: StorageConnectionCredential): Buffer {
  // An unparseable URL binds to '', which no URL's target equals: the secret then fails closed.
  const target = credentialTarget(url) ?? '';
  return Buffer.from(JSON.stringify({ target, credential }), 'utf8');
}
