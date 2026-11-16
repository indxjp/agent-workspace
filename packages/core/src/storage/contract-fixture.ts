import { expect } from 'vitest';
import { type ObjectPage, type ObjectStore, type ObjectStoreProvider } from './object-store.js';
import { streamToBytes } from './streams.js';
export const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
export const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

/** What a suite's `setup()` hands back: a fresh provider, and how to tear it down afterward. */
export interface ObjectStoreContractFixture {
  readonly provider: ObjectStoreProvider;
  readonly teardown: () => Promise<void>;
  /** A signed URL can be fetched over HTTP from here (SeaweedFS, a live cloud), not just parsed. */
  readonly signedUrlsFetchable?: boolean;
  /**
   * The backend refuses to sign a window that is already over, with {@link SignedUrlUnsupportedError},
   * instead of signing a link the provider then refuses (Google Cloud Storage: its SDK will not sign
   * an expiry in the past). Only such a fixture may pass the expiry case that way.
   */
  readonly refusesExpiredSigning?: true;
  /**
   * Writes `bytes` at the backend's own full `key`, past every guard, the way a foreign tool (a
   * cloud console) would. Absent where only this module can write (the in-memory reference).
   */
  readonly plantRaw?: (key: string, bytes: Uint8Array) => Promise<void>;
  /**
   * The backend keeps no content type of its own (a connected folder has no sidecar), so it reports
   * the type its file name implies instead of the one a caller wrote.
   */
  readonly contentTypeFromName?: true;
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const asText = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);

/**
 * Compare two byte sequences by content. Plain `toEqual` is not enough here: the local-filesystem
 * backend hands back a `Buffer`, a future S3 backend would hand back whatever its SDK returns, and
 * Vitest's `toEqual` treats a `Buffer` and a plain `Uint8Array` holding identical bytes as
 * unequal because their constructors differ. Wrapping both sides in `Buffer.from` normalises that
 * away without weakening the assertion — `Buffer.from` copies the underlying bytes, so this still
 * fails on a single differing byte or a different length.
 */
export function expectBytesEqual(actual: Uint8Array | undefined, expected: Uint8Array): void {
  expect(actual).toBeDefined();
  expect(Buffer.from(actual as Uint8Array)).toEqual(Buffer.from(expected));
}

/** Every key one listing reports, all pages of it: one level, or every file beneath (`recursive`). */
export async function keysOf(
  store: ObjectStore,
  prefix: string,
  recursive = false,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | null = null;
  do {
    const page: ObjectPage = await store.listPage(prefix, {
      recursive,
      ...(cursor === null ? {} : { cursor }),
    });
    keys.push(...page.entries.map((entry) => entry.key));
    cursor = page.cursor;
  } while (cursor !== null);
  return keys;
}

/** The object at `key` as UTF-8 text, or `null` when there is none. */
export async function textAt(store: ObjectStore, key: string): Promise<string | null> {
  const found = await store.read(key);
  return found === null ? null : asText(await streamToBytes(found.body));
}

export type WithObjectStore = (
  run: (store: ObjectStore, fixture: ObjectStoreContractFixture) => Promise<void>,
) => Promise<void>;
