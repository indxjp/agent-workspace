import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ConnectionStoreError,
  openConnectionStore,
  type ConnectionCredential,
  type ConnectionStoreOptions,
} from './connection-store.js';
import type { ObjectStore } from './object-store.js';

export const production = { production: true, allowHosts: [] } as const;
export const local = { production: false, allowHosts: [] } as const;
export const bytes = new Uint8Array([1, 2, 3]);

// Built at runtime so no key-shaped literal sits in the source for a secret scanner to flag.
export const s3Credential = (): Extract<ConnectionCredential, { provider: 's3' }> => ({
  provider: 's3',
  accessKeyId: ['AK', 'IA', randomBytes(8).toString('hex').toUpperCase()].join(''),
  secretAccessKey: randomBytes(20).toString('base64'),
});

export const open = (
  url: string,
  credential: ConnectionCredential,
  options: Partial<ConnectionStoreOptions> = {},
): Promise<ObjectStore> =>
  openConnectionStore(url, credential, {
    writable: false,
    fileRoots: [],
    egress: production,
    ...options,
  });

export async function tempRoot(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-connection-')));
}

export async function codeOf(attempt: Promise<unknown>): Promise<string | undefined> {
  try {
    await attempt;
  } catch (error) {
    return error instanceof ConnectionStoreError ? error.code : String(error);
  }
  return undefined;
}
