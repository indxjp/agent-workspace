/**
 * The one `ObjectStore` contract suite W2-plan.md's first acceptance criterion asks for: "write it
 * once, run it against the local-filesystem implementation and against S3/MinIO."
 *
 * ## Adding a backend — the single entry point
 *
 * {@link defineObjectStoreContract} is the entry point, and adding a backend means adding one
 * file next to this one. Nothing in *this* file changes, ever, to admit a new implementation:
 *
 * ```ts
 * // packages/core/src/storage/s3-store.test.ts
 * import { defineObjectStoreContract, type ObjectStoreContractFixture } from './contract.js';
 * import { createS3ObjectStoreProvider } from './s3-store.js';
 *
 * async function setup(): Promise<ObjectStoreContractFixture> {
 *   const bucket = await makeThrowawayBucket();
 *   return { provider: createS3ObjectStoreProvider(bucket), teardown: () => dropBucket(bucket) };
 * }
 *
 * defineObjectStoreContract('S3 (SeaweedFS)', setup);
 * ```
 *
 * A fixture owes the suite two things and no more: a fresh {@link ObjectStoreProvider} that starts
 * empty, and a `teardown` that disposes of whatever backed it. The suite calls `setup()` once per
 * test, so a fixture must not be shared between them. A backend that pages its own listings also
 * calls {@link defineOwnPagingContract}.
 *
 * ## Which backends actually run it, and what is still missing
 *
 * Local filesystem and the in-memory reference run in every CI job. S3 runs against the SeaweedFS
 * S3 server the repository test launcher provisions
 * (`docs/adr/0066-the-s3-contract-suite-runs-against-seaweedfs.md`). Native GCS has an offline
 * protocol fake for ordinary CI and an opt-in `gcs-store.live.test.ts` fixture for the real-service proof. Every one
 * shares only the {@link ObjectStore} interface with this suite; backend-specific setup and cleanup
 * stay in the adjacent test file.
 *
 * Every assertion here is backend-agnostic: it exercises {@link ObjectStore} and
 * {@link ObjectStoreProvider} only — plus `key-safety.ts`'s {@link UnsafeObjectKeyError} and
 * {@link OBJECT_METADATA_SUFFIX}, which name the guard every conforming backend is required to
 * run, not an implementation detail of one.
 */
import { describe, expect, it } from 'vitest';

import { inferContentType } from './content-type.js';
import { OBJECT_METADATA_SUFFIX, toObjectKey, UnsafeObjectKeyError } from './key-safety.js';
import { workspaceFolder } from './object-name.js';
import {
  ObjectConflictError,
  RangeNotSatisfiableError,
  SignedUrlUnsupportedError,
  type ObjectPage,
  type ObjectStore,
  type ObjectStoreProvider,
  type WriteOptions,
} from './object-store.js';
import { bytesToStream, listAll, streamToBytes } from './streams.js';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

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

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const asText = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);

/**
 * Compare two byte sequences by content. Plain `toEqual` is not enough here: the local-filesystem
 * backend hands back a `Buffer`, a future S3 backend would hand back whatever its SDK returns, and
 * Vitest's `toEqual` treats a `Buffer` and a plain `Uint8Array` holding identical bytes as
 * unequal because their constructors differ. Wrapping both sides in `Buffer.from` normalises that
 * away without weakening the assertion — `Buffer.from` copies the underlying bytes, so this still
 * fails on a single differing byte or a different length.
 */
function expectBytesEqual(actual: Uint8Array | undefined, expected: Uint8Array): void {
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

/**
 * The key-safety and tenant-isolation half of {@link defineObjectStoreContract}, which runs it.
 * A backend whose emulator cannot run the whole suite (fake-gcs-server's paging) runs this alone.
 */
export function defineObjectKeyContract(
  label: string,
  setup: () => Promise<ObjectStoreContractFixture>,
): void {
  describe(`ObjectStore keys and tenants — ${label}`, () => {
    async function withStore(
      run: (store: ObjectStore, fixture: ObjectStoreContractFixture) => Promise<void>,
    ): Promise<void> {
      const fixture = await setup();
      try {
        await run(fixture.provider.forWorkspace(WORKSPACE_A), fixture);
      } finally {
        await fixture.teardown();
      }
    }

    describe('objects', () => {
      it('read() and head() are null for a missing child beneath an existing object key', async () => {
        await withStore(async (store) => {
          await store.write('plain-file.txt', utf8('not a folder'), {});
          expect(await store.read('plain-file.txt/missing-child')).toBeNull();
          expect(await store.head('plain-file.txt/missing-child')).toBeNull();
        });
      });

      it('write() then read() round-trips bytes exactly, including a trailing newline', async () => {
        await withStore(async (store) => {
          await store.write('with-newline.txt', utf8('line one\nline two\n'), {});
          await store.write('without-newline.txt', utf8('line one\nline two'), {});
          expect(await textAt(store, 'with-newline.txt')).toBe('line one\nline two\n');
          expect(await textAt(store, 'without-newline.txt')).toBe('line one\nline two');
        });
      });

      it('write() replaces an existing object rather than appending to it', async () => {
        await withStore(async (store) => {
          await store.write('report.txt', utf8('first'), {});
          await store.write('report.txt', utf8('second, longer than "first"'), {});
          await store.write('report.txt', utf8('third'), {});
          expect(await textAt(store, 'report.txt')).toBe('third');
          expect((await store.head('report.txt'))?.sizeBytes).toBe(5);
        });
      });

      it('delete() removes an object, and a second delete() of the same key is not an error', async () => {
        await withStore(async (store) => {
          await store.write('to-delete.txt', utf8('gone soon'), {});
          await store.delete('to-delete.txt');
          expect(await store.head('to-delete.txt')).toBeNull();
          // R-15 §1c, verified against MinIO and local fs alike: deleting a missing key is success.
          await expect(store.delete('to-delete.txt')).resolves.toBeUndefined();
          await expect(store.delete('never-existed-at-all.txt')).resolves.toBeUndefined();
        });
      });

      it('one level of listPage() reports a folder, and a file with its size and content type', async () => {
        await withStore(async (store, { contentTypeFromName }) => {
          await store.write('contracts/agreement.pdf', utf8('pdf bytes'), {});
          await store.write('instructions.md', utf8('# hi'), {});
          const { entries } = await store.listPage('');
          expect(entries).toEqual([
            { kind: 'folder', key: 'contracts' },
            expect.objectContaining({
              kind: 'file',
              key: 'instructions.md',
              sizeBytes: 4,
              contentType:
                contentTypeFromName === true ? inferContentType('instructions.md') : null,
            }),
          ]);
          expect(await keysOf(store, '', true)).toEqual([
            'contracts/agreement.pdf',
            'instructions.md',
          ]);
        });
      });
    });

    it('a recursive listPage() stays beneath its prefix, never in a sibling that starts the same', async () => {
      await withStore(async (store) => {
        for (const key of ['p/deep/in.txt', 'p/in.txt', 'p-sibling/x.txt', 'p.txt', 'pq/x.txt']) {
          await store.write(key, utf8(key), {});
        }
        expect(await keysOf(store, 'p', true)).toEqual(['p/deep/in.txt', 'p/in.txt']);
        expect(await keysOf(store, 'p-sibling', true)).toEqual(['p-sibling/x.txt']);
      });
    });

    it("two workspaces never see each other's keys, even with the identical relative key", async () => {
      const { provider, teardown } = await setup();
      try {
        const storeA = provider.forWorkspace(WORKSPACE_A);
        const storeB = provider.forWorkspace(WORKSPACE_B);
        await storeA.write('shared/name.txt', utf8('workspace A'), {});
        expect(await storeB.head('shared/name.txt')).toBeNull();
        expect(await storeB.read('shared/name.txt')).toBeNull();
        expect(await keysOf(storeB, '', true)).toEqual([]);
        await storeB.write('shared/name.txt', utf8('workspace B'), {});
        expect(await textAt(storeA, 'shared/name.txt')).toBe('workspace A');
        expect(await textAt(storeB, 'shared/name.txt')).toBe('workspace B');
        await storeB.delete('shared/name.txt');
        expect(await textAt(storeA, 'shared/name.txt')).toBe('workspace A');
        expect(await keysOf(storeA, '')).toEqual(['shared']);
        expect(await keysOf(storeA, 'shared', true)).toEqual(['shared/name.txt']);
      } finally {
        await teardown();
      }
    });

    // ── The key a write() was given is the key it wrote to (verification round 1, F2) ─────────

    describe('a key is stored literally, never under some transformed form of itself', () => {
      it('write() writes to the key it was handed, and read()/listPage() name that same key', async () => {
        await withStore(async (store) => {
          await store.write('a/b', utf8('VICTIM BYTES'), {});
          expect(await textAt(store, 'a/b')).toBe('VICTIM BYTES');
          expect(await keysOf(store, 'a')).toEqual(['a/b']);
        });
      });

      it('write() refuses a key that would mean a different key once decoded, and leaves that other key alone', async () => {
        // The counter-example that failed verification round 1: `a%252fb` was accepted, decoded a
        // second and a third time on its way down, and the bytes landed on `a/b` while the API
        // reported writing `a%2fb`. This asserts the consequence, so it holds for any backend.
        await withStore(async (store) => {
          await store.write('a/b', utf8('VICTIM BYTES'), {});
          await expect(store.write('a%252fb', utf8('ATTACKER BYTES'), {})).rejects.toThrow(
            UnsafeObjectKeyError,
          );
          expect(await textAt(store, 'a/b')).toBe('VICTIM BYTES');
          expect(await keysOf(store, '')).toEqual(['a']);
        });
      });
    });

    // ── The reserved metadata name is not a legal key (round 1 F3; round 3 F3/U2) ──────────────
    //
    // Written over a *class* of spellings rather than one constant: every backend refuses all of
    // them identically, including one with no sidecar at all, because "which keys are legal" is one
    // answer for every backend. That a backend's own metadata is out of reach is a structural
    // property of where it puts things, asserted for the local filesystem in its own test file.

    describe('a key containing the reserved metadata marker is refused, however it is spelled', () => {
      const spellings: ReadonlyArray<readonly [label: string, key: string]> = [
        ['the exact-case name round 1 forged with', 'note.txt.__objectstore_meta__.json'],
        ['an upper-case extension', 'note.txt.__objectstore_meta__.JSON'],
        ['a mixed-case marker', 'note.txt.__ObjectStore_Meta__.json'],
        ['an all-upper-case name', 'NOTE.TXT.__OBJECTSTORE_META__.JSON'],
        ['an NTFS default-stream suffix', 'note.txt.__objectstore_meta__.json::$DATA'],
        ['a trailing dot', 'note.txt.__objectstore_meta__.json.'],
        ['the marker alone', '__objectstore_meta__'],
        ['the marker embedded mid-name', `x${OBJECT_METADATA_SUFFIX}y.txt`],
      ];

      for (const [label, poison] of spellings) {
        it(`write() refuses ${label}, and the object it would have shadowed is untouched`, async () => {
          await withStore(async (store) => {
            await store.write('note.txt', utf8('hello'), { contentType: 'text/plain' });
            await expect(
              store.write(poison, utf8('{"contentType":"text/html"}'), {}),
            ).rejects.toThrow(UnsafeObjectKeyError);
            // F3's evidence lines, asserted as consequences rather than as a rule firing: the
            // victim's content type, its bytes, and a listing with nothing extra or hidden in it.
            expect((await store.head('note.txt'))?.contentType).toBe('text/plain');
            expect(await textAt(store, 'note.txt')).toBe('hello');
            expect(await keysOf(store, '')).toEqual(['note.txt']);
          });
        });

        it(`read(), head(), delete() and listPage() refuse ${label} too, so it is unrepresentable`, async () => {
          await withStore(async (store) => {
            await expect(store.read(poison)).rejects.toThrow(UnsafeObjectKeyError);
            await expect(store.head(poison)).rejects.toThrow(UnsafeObjectKeyError);
            await expect(store.delete(poison)).rejects.toThrow(UnsafeObjectKeyError);
            await expect(store.listPage(poison)).rejects.toThrow(UnsafeObjectKeyError);
          });
        });

        it(`refuses ${label} in a non-final segment as well, which a listing would also have hidden`, async () => {
          await withStore(async (store) => {
            await expect(store.write(`${poison}/inner.txt`, utf8('x'), {})).rejects.toThrow(
              UnsafeObjectKeyError,
            );
          });
        });
      }
    });

    // ── W2-plan.md's second acceptance criterion: refused BY CONSTRUCTION ─────────────────────

    describe('a key that would escape its workspace prefix is refused before any byte moves', () => {
      const attacks: ReadonlyArray<{ readonly label: string; readonly key: string }> = [
        { label: 'a ".." segment', key: '../../etc/passwd' },
        { label: 'an absolute path', key: '/etc/passwd' },
        { label: 'a percent-encoded ".." segment', key: '..%2f..%2fetc%2fpasswd' },
      ];

      for (const attack of attacks) {
        it(`write(), read(), head(), delete() and listPage() refuse ${attack.label}`, async () => {
          await withStore(async (store) => {
            await expect(store.write(attack.key, utf8('pwned'), {})).rejects.toThrow(
              UnsafeObjectKeyError,
            );
            await expect(store.read(attack.key)).rejects.toThrow(UnsafeObjectKeyError);
            await expect(store.head(attack.key)).rejects.toThrow(UnsafeObjectKeyError);
            await expect(store.delete(attack.key)).rejects.toThrow(UnsafeObjectKeyError);
            await expect(store.listPage(attack.key)).rejects.toThrow(UnsafeObjectKeyError);
            await expect(store.listPage(attack.key, { recursive: true })).rejects.toThrow(
              UnsafeObjectKeyError,
            );
          });
        });
      }

      it('refuses to copy an object over the same attack keys, as source and as destination', async () => {
        await withStore(async (store) => {
          await store.write('victim.txt', utf8('victim bytes'), {});
          for (const attack of attacks) {
            await expect(store.copy(attack.key, 'dest.txt')).rejects.toThrow(UnsafeObjectKeyError);
            await expect(store.copy('victim.txt', attack.key)).rejects.toThrow(
              UnsafeObjectKeyError,
            );
          }
          expect(await store.head('dest.txt')).toBeNull();
          expect(await textAt(store, 'victim.txt')).toBe('victim bytes');
        });
      });

      it('refusing the attack keys leaves no trace outside the workspace prefix', async () => {
        // The positive half of the proof: a backend that "refused" by silently writing somewhere
        // else would still be caught here.
        await withStore(async (store) => {
          for (const attack of attacks) {
            await store.write(attack.key, utf8('pwned'), {}).catch(() => undefined);
          }
          expect(await keysOf(store, '', true)).toEqual([]);
        });
      });
    });
  });
}

/**
 * Run the full `ObjectStore` contract against one backend: keys, tenants, head, streaming
 * read/write, range, conditional write, listing, copy and signing. `label` names the backend in
 * every `describe` block, so a failure in CI says which implementation broke.
 */
export function defineObjectStoreContract(
  label: string,
  setup: () => Promise<ObjectStoreContractFixture>,
): void {
  defineObjectKeyContract(label, setup);
  describe(`ObjectStore contract — ${label}`, () => {
    async function withStore(
      run: (store: ObjectStore, fixture: ObjectStoreContractFixture) => Promise<void>,
    ): Promise<void> {
      const fixture = await setup();
      const { provider, teardown } = fixture;
      try {
        await run(provider.forWorkspace(WORKSPACE_A), fixture);
      } finally {
        await teardown();
      }
    }

    describe('head()', () => {
      it('is null for a missing key and reports size, content type and an etag for an object', async () => {
        await withStore(async (store) => {
          expect(await store.head('missing.txt')).toBeNull();
          await store.write('h.txt', utf8('12345'), { contentType: 'text/plain' });
          const meta = await store.head('h.txt');
          expect(meta).toMatchObject({ sizeBytes: 5, contentType: 'text/plain' });
          expect(meta?.etag).toEqual(expect.any(String));
          expect(meta?.etag).not.toBe('');
        });
      });

      it('changes the etag when the content changes', async () => {
        await withStore(async (store) => {
          await store.write('e.txt', utf8('one'), {});
          const first = await store.head('e.txt');
          await store.write('e.txt', utf8('two!'), {});
          const second = await store.head('e.txt');
          expect(second?.etag).not.toBe(first?.etag);
          expect(second?.sizeBytes).toBe(4);
        });
      });
    });

    describe('read() and write() stream bytes', () => {
      it('read() is null for a missing key', async () => {
        await withStore(async (store) => {
          expect(await store.read('never.txt')).toBeNull();
        });
      });

      it('write() accepts a multi-chunk stream, returns meta, and read() streams the same bytes back', async () => {
        await withStore(async (store, { contentTypeFromName }) => {
          const chunks = [utf8('alpha-'), utf8('beta-'), utf8('gamma')];
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.close();
            },
          });
          const written = await store.write('s/stream.bin', body, { contentType: 'text/plain' });
          expect(written.sizeBytes).toBe(16);
          const read = await store.read('s/stream.bin');
          expect(read?.meta).toMatchObject({
            sizeBytes: 16,
            contentType:
              contentTypeFromName === true ? inferContentType('s/stream.bin') : 'text/plain',
          });
          expect(read?.meta.etag).toBe(written.etag);
          expect(asText(await streamToBytes(read!.body))).toBe('alpha-beta-gamma');
        });
      });

      it('write() accepts bytes, and read() sees them', async () => {
        await withStore(async (store) => {
          await store.write('b.txt', utf8('bytes'), {});
          expect(await textAt(store, 'b.txt')).toBe('bytes');
        });
      });

      it('write() round-trips binary bytes through a stream', async () => {
        await withStore(async (store) => {
          const bytes = new Uint8Array(70_000);
          for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) % 256;
          await store.write('bin.bin', bytesToStream(bytes), {});
          const read = await store.read('bin.bin');
          expectBytesEqual(await streamToBytes(read!.body), bytes);
        });
      });

      // #1835 (STO-509): a write-back's deadline must stop a write or a read the store's SDK holds.
      it('write() with a signal already aborted rejects with its reason, writes nothing and cancels the body', async () => {
        await withStore(async (store) => {
          const stopped = new Error('stopped before the write');
          let cancelled: unknown;
          const body = new ReadableStream<Uint8Array>({
            cancel(reason) {
              cancelled = reason;
            },
          });
          await expect(
            store.write('aborted.txt', body, { signal: AbortSignal.abort(stopped) }),
          ).rejects.toBe(stopped);
          expect(cancelled).toBe(stopped);
          expect(await store.head('aborted.txt')).toBeNull();
        });
      });

      it('write() whose signal aborts while the body is still open rejects and leaves the key as it was', async () => {
        await withStore(async (store) => {
          await store.write('kept.txt', utf8('before'), {});
          const controller = new AbortController();
          const stalled = new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(utf8('partial'));
            },
          });
          const writing = store.write('kept.txt', stalled, { signal: controller.signal });
          setTimeout(() => controller.abort(new Error('the deadline passed')), 50);
          await expect(writing).rejects.toThrow();
          expect(await textAt(store, 'kept.txt')).toBe('before');
        });
      });

      it('read() with a signal already aborted rejects, and a body whose signal aborts errors', async () => {
        await withStore(async (store) => {
          await store.write('r.bin', bytesToStream(new Uint8Array(200_000)), {});
          const stopped = new Error('stopped before the read');
          await expect(store.read('r.bin', { signal: AbortSignal.abort(stopped) })).rejects.toBe(
            stopped,
          );

          const controller = new AbortController();
          const found = await store.read('r.bin', { signal: controller.signal });
          controller.abort(new Error('stopped mid-read'));
          await expect(streamToBytes(found!.body)).rejects.toThrow();
        });
      });

      it('head(), read() and write() refuse an unsafe key like put() does', async () => {
        await withStore(async (store) => {
          await expect(store.write('../x', utf8('x'), {})).rejects.toThrow(UnsafeObjectKeyError);
          await expect(store.read('../x')).rejects.toThrow(UnsafeObjectKeyError);
          await expect(store.head('../x')).rejects.toThrow(UnsafeObjectKeyError);
        });
      });
    });

    describe('range reads', () => {
      it('serve a closed range, an open-ended range, and report the whole size', async () => {
        await withStore(async (store) => {
          if (!store.capabilities.range) return;
          await store.write('r.txt', utf8('0123456789'), {});
          const closed = await store.read('r.txt', { range: { start: 2, end: 5 } });
          expect(asText(await streamToBytes(closed!.body))).toBe('2345');
          expect(closed?.range).toEqual({ start: 2, end: 5 });
          expect(closed?.meta.sizeBytes).toBe(10);
          const open = await store.read('r.txt', { range: { start: 7 } });
          expect(asText(await streamToBytes(open!.body))).toBe('789');
          expect(open?.range).toEqual({ start: 7, end: 9 });
          const whole = await store.read('r.txt');
          expect(whole?.range).toBeNull();
        });
      });
    });

    describe('a range that cannot be satisfied is refused identically everywhere', () => {
      const bad: ReadonlyArray<readonly [string, { start: number; end?: number }]> = [
        ['a negative start', { start: -5 }],
        ['a negative start with an end', { start: -5, end: 3 }],
        ['a fractional start', { start: 1.5 }],
        ['a fractional end', { start: 1, end: 2.5 }],
        ['NaN', { start: Number.NaN }],
        ['start after end', { start: 5, end: 2 }],
        ['a start at the object size', { start: 10 }],
        ['a start past the object size', { start: 99, end: 120 }],
      ];
      for (const [name, range] of bad) {
        it(`rejects ${name} with RangeNotSatisfiableError`, async () => {
          await withStore(async (store) => {
            if (!store.capabilities.range) return;
            await store.write('range.txt', utf8('0123456789'), {});
            await expect(store.read('range.txt', { range })).rejects.toThrow(
              RangeNotSatisfiableError,
            );
          });
        });
      }

      it('rejects any range on a zero-byte object, and still streams it whole', async () => {
        await withStore(async (store) => {
          if (!store.capabilities.range) return;
          await store.write('empty.txt', new Uint8Array(0), {});
          await expect(store.read('empty.txt', { range: { start: 0 } })).rejects.toThrow(
            RangeNotSatisfiableError,
          );
          await expect(store.read('empty.txt', { range: { start: 0, end: 0 } })).rejects.toThrow(
            RangeNotSatisfiableError,
          );
          const whole = await store.read('empty.txt');
          expect((await streamToBytes(whole!.body)).byteLength).toBe(0);
        });
      });

      it('clamps an end past the last byte', async () => {
        await withStore(async (store) => {
          if (!store.capabilities.range) return;
          await store.write('clamp.txt', utf8('0123456789'), {});
          const read = await store.read('clamp.txt', { range: { start: 8, end: 500 } });
          expect(asText(await streamToBytes(read!.body))).toBe('89');
          expect(read?.range).toEqual({ start: 8, end: 9 });
        });
      });

      it('a missing object is null, not a range error', async () => {
        await withStore(async (store) => {
          if (!store.capabilities.range) return;
          expect(await store.read('nope.txt', { range: { start: 0 } })).toBeNull();
        });
      });
    });

    describe('a write whose body fails', () => {
      function failingBody(): ReadableStream<Uint8Array> {
        let pulls = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls > 2) controller.error(new Error('source broke'));
            else controller.enqueue(new Uint8Array(1024).fill(7));
          },
        });
      }

      it('rejects, leaves no object behind and keeps the previous one intact', async () => {
        await withStore(async (store) => {
          await expect(store.write('half.bin', failingBody(), {})).rejects.toThrow('source broke');
          expect(await store.head('half.bin')).toBeNull();
          expect(await listAll(store, '')).toEqual([]);

          await store.write('kept.txt', utf8('original'), {});
          await expect(store.write('kept.txt', failingBody(), {})).rejects.toThrow();
          expect(await textAt(store, 'kept.txt')).toBe('original');
        });
      });

      it('a conditional write whose body fails writes nothing and leaves the named version current', async () => {
        await withStore(async (store) => {
          if (!store.capabilities.conditionalPut) return;
          await expect(
            store.write('fresh.bin', failingBody(), { ifNoneMatch: '*' }),
          ).rejects.toThrow();
          expect(await store.head('fresh.bin')).toBeNull();

          const kept = await store.write('kept.txt', utf8('original'), {});
          await expect(
            store.write('kept.txt', failingBody(), { ifMatch: kept.etag }),
          ).rejects.toThrow();
          expect(await textAt(store, 'kept.txt')).toBe('original');
          expect((await store.head('kept.txt'))?.etag).toBe(kept.etag);
          // Nothing replaced it, so a retry that names the same version still succeeds.
          await store.write('kept.txt', utf8('retried'), { ifMatch: kept.etag });
          expect(await textAt(store, 'kept.txt')).toBe('retried');
        });
      });
    });

    describe('conditional write', () => {
      it('ifNoneMatch "*" creates once and then conflicts', async () => {
        await withStore(async (store) => {
          if (!store.capabilities.conditionalPut) return;
          await store.write('c.txt', utf8('first'), { ifNoneMatch: '*' });
          await expect(store.write('c.txt', utf8('second'), { ifNoneMatch: '*' })).rejects.toThrow(
            ObjectConflictError,
          );
          expect(await textAt(store, 'c.txt')).toBe('first');
        });
      });

      it('ifNoneMatch "*" conflicts on a body large enough to be uploaded in parts', async () => {
        await withStore(async (store) => {
          if (!store.capabilities.conditionalPut) return;
          // Above S3's 5 MiB part, so the condition must hold when the parts are completed.
          const size = 6 * 1024 * 1024;
          await store.write('big.bin', bytesToStream(new Uint8Array(size).fill(1)), {
            ifNoneMatch: '*',
          });
          await expect(
            store.write('big.bin', bytesToStream(new Uint8Array(size).fill(2)), {
              ifNoneMatch: '*',
            }),
          ).rejects.toThrow(ObjectConflictError);
          const found = await store.read('big.bin');
          const bytes = found === null ? null : await streamToBytes(found.body);
          expect(bytes?.length).toBe(size);
          expect(bytes?.every((byte) => byte === 1)).toBe(true);
        });
      });

      it('ifMatch replaces only the version it names, and conflicts on a stale or missing one', async () => {
        await withStore(async (store) => {
          if (!store.capabilities.conditionalPut) return;
          await expect(store.write('m.txt', utf8('x'), { ifMatch: '"nope"' })).rejects.toThrow(
            ObjectConflictError,
          );
          const v1 = await store.write('m.txt', utf8('v1'), {});
          const v2 = await store.write('m.txt', utf8('v2-longer'), { ifMatch: v1.etag });
          await expect(store.write('m.txt', utf8('v3'), { ifMatch: v1.etag })).rejects.toThrow(
            ObjectConflictError,
          );
          expect(await textAt(store, 'm.txt')).toBe('v2-longer');
          await store.write('m.txt', utf8('v3'), { ifMatch: v2.etag });
          expect(await textAt(store, 'm.txt')).toBe('v3');
        });
      });

      it('head() reports the etag the write returned', async () => {
        await withStore(async (store) => {
          const written = await store.write('w.txt', utf8('mine'), {});
          expect((await store.head('w.txt'))?.etag).toBe(written.etag);
        });
      });

      it('ifMatch with ifNoneMatch is refused, the body cancelled and nothing written', async () => {
        await withStore(async (store) => {
          let cancelled = false;
          let pulls = 0;
          const body = new ReadableStream<Uint8Array>({
            pull: (controller) => {
              pulls += 1;
              if (pulls > 3) controller.close();
              else controller.enqueue(utf8('x'));
            },
            cancel: () => {
              cancelled = true;
            },
          });
          // A JavaScript caller can pass both; the type allows only one.
          const both = { ifNoneMatch: '*', ifMatch: '"any"' } as unknown as WriteOptions;
          await expect(store.write('both.txt', body, both)).rejects.toThrow(ObjectConflictError);
          expect(cancelled).toBe(true);
          expect(await store.head('both.txt')).toBeNull();
        });
      });

      it('two concurrent ifNoneMatch "*" writes: exactly one wins', async () => {
        await withStore(async (store) => {
          if (!store.capabilities.conditionalPut) return;
          const results = await Promise.allSettled([
            store.write('race.txt', bytesToStream(utf8('left')), { ifNoneMatch: '*' }),
            store.write('race.txt', bytesToStream(utf8('right')), { ifNoneMatch: '*' }),
          ]);
          expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
          const lost = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
          );
          expect(lost?.reason).toBeInstanceOf(ObjectConflictError);
        });
      });
    });

    describe('listPage() pages with an opaque cursor', () => {
      async function drain(
        store: ObjectStore,
        prefix: string,
        recursive: boolean,
        limit: number,
      ): Promise<string[]> {
        const keys: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 50; guard += 1) {
          const page = await store.listPage(prefix, {
            recursive,
            limit,
            ...(cursor === undefined ? {} : { cursor }),
          });
          expect(page.entries.length).toBeLessThanOrEqual(Math.max(1, limit));
          keys.push(...page.entries.map((entry) => entry.key));
          if (page.cursor === null) return keys;
          cursor = page.cursor;
        }
        throw new Error('listPage never finished');
      }

      it('visits every entry once, one level or recursively', async () => {
        await withStore(async (store) => {
          for (const name of ['a', 'b', 'c', 'd', 'e']) {
            await store.write(`p/${name}.txt`, utf8(name), {});
          }
          await store.write('p/sub/deep.txt', utf8('deep'), {});
          await store.write('p-sibling/x.txt', utf8('x'), {});

          const level = await drain(store, 'p', false, 2);
          expect([...level].sort()).toEqual([
            'p/a.txt',
            'p/b.txt',
            'p/c.txt',
            'p/d.txt',
            'p/e.txt',
            'p/sub',
          ]);
          const deep = await drain(store, 'p', true, 2);
          expect([...deep].sort()).toEqual([
            'p/a.txt',
            'p/b.txt',
            'p/c.txt',
            'p/d.txt',
            'p/e.txt',
            'p/sub/deep.txt',
          ]);
        });
      });

      it('does not skip a folder that shares its key with a file across a page boundary', async () => {
        await withStore(async (store) => {
          if (!store.capabilities.fileAndFolderShareKey) return;
          await store.write('dup/x', utf8('file'), {});
          await store.write('dup/x/y', utf8('deep'), {});
          const keys: string[] = [];
          const kinds: string[] = [];
          let cursor: string | undefined;
          for (let guard = 0; guard < 10; guard += 1) {
            const page = await store.listPage('dup', {
              limit: 1,
              ...(cursor === undefined ? {} : { cursor }),
            });
            keys.push(...page.entries.map((entry) => entry.key));
            kinds.push(...page.entries.map((entry) => entry.kind));
            if (page.cursor === null) break;
            cursor = page.cursor;
          }
          expect(keys).toEqual(['dup/x', 'dup/x']);
          expect([...kinds].sort()).toEqual(['file', 'folder']);
        });
      });

      it('lists pages that concatenate into the single-page order, one level or recursively', async () => {
        await withStore(async (store) => {
          // A folder sorts next to files that share its name's start: `-` and `.` sort before `/`.
          for (const key of ['o/a.txt', 'o/a/b.txt', 'o/a-b/c.txt', 'o/a0.txt', 'o/b.txt']) {
            await store.write(key, utf8(key), {});
          }
          for (const recursive of [false, true]) {
            const whole = (await store.listPage('o', { recursive, limit: 1000 })).entries.map(
              (entry) => `${entry.kind}:${entry.key}`,
            );
            expect(whole).toHaveLength(5);
            for (const limit of [1, 2, 3]) {
              const paged: string[] = [];
              let cursor: string | undefined;
              for (let guard = 0; guard < 20; guard += 1) {
                const page = await store.listPage('o', {
                  recursive,
                  limit,
                  ...(cursor === undefined ? {} : { cursor }),
                });
                paged.push(...page.entries.map((entry) => `${entry.kind}:${entry.key}`));
                if (page.cursor === null) break;
                cursor = page.cursor;
              }
              expect(paged).toEqual(whole);
            }
          }
        });
      });

      it('treats a limit below 1 as 1 and still finishes', async () => {
        await withStore(async (store) => {
          await store.write('lim/a.txt', utf8('a'), {});
          await store.write('lim/b.txt', utf8('b'), {});
          expect(await drain(store, 'lim', true, 0)).toEqual(['lim/a.txt', 'lim/b.txt']);
        });
      });

      it('returns an empty final page for a prefix with nothing under it', async () => {
        await withStore(async (store) => {
          expect(await store.listPage('none', {})).toEqual({ entries: [], cursor: null });
        });
      });
    });

    describe('copy() is a server-side copy', () => {
      it('the destination has the source bytes, content type and size; the source is unchanged', async () => {
        await withStore(async (store) => {
          await store.write('source.txt', utf8('payload'), { contentType: 'text/plain' });
          await store.copy('source.txt', 'dest.txt');
          const dest = await store.read('dest.txt');
          expect(asText(await streamToBytes(dest!.body))).toBe('payload');
          expect(dest?.meta).toMatchObject({ sizeBytes: 7, contentType: 'text/plain' });
          const source = await store.read('source.txt');
          expect(asText(await streamToBytes(source!.body))).toBe('payload');
        });
      });

      it('overwrites an existing destination', async () => {
        await withStore(async (store) => {
          await store.write('source.txt', utf8('new'), {});
          await store.write('dest.txt', utf8('stale'), {});
          await store.copy('source.txt', 'dest.txt');
          const dest = await store.read('dest.txt');
          expect(asText(await streamToBytes(dest!.body))).toBe('new');
        });
      });

      it('copying a source that does not exist is a no-op, not an error', async () => {
        await withStore(async (store) => {
          await expect(store.copy('never-written.txt', 'dest.txt')).resolves.toBeUndefined();
          expect(await store.head('dest.txt')).toBeNull();
        });
      });

      it('refuses an unsafe source or destination key', async () => {
        await withStore(async (store) => {
          await store.write('victim.txt', utf8('victim'), {});
          await expect(store.copy('../x', 'dest.txt')).rejects.toThrow(UnsafeObjectKeyError);
          await expect(store.copy('victim.txt', '../x')).rejects.toThrow(UnsafeObjectKeyError);
          expect(await store.head('dest.txt')).toBeNull();
        });
      });

      it('two workspaces cannot copy across each other, even at the identical relative key', async () => {
        const { provider, teardown } = await setup();
        try {
          const storeA = provider.forWorkspace(WORKSPACE_A);
          const storeB = provider.forWorkspace(WORKSPACE_B);
          await storeA.write('secret.txt', utf8('A only'), {});
          await storeB.copy('secret.txt', 'stolen.txt');
          // Workspace B's own `secret.txt` never existed, so its scoped copy source is empty.
          expect(await storeB.head('stolen.txt')).toBeNull();
        } finally {
          await teardown();
        }
      });

      it('scopes the copy source, so an unprefixed source naming another workspace finds nothing', async () => {
        const { provider, teardown } = await setup();
        try {
          const storeA = provider.forWorkspace(WORKSPACE_A);
          const storeB = provider.forWorkspace(WORKSPACE_B);
          await storeB.write('secret.txt', utf8('B only'), { contentType: 'text/plain' });
          const before = await storeB.head('secret.txt');
          // The backend-root key of B's object. Scoped, it names A's own (empty) subtree; a copy
          // that dropped the source prefix would read B's bytes into A.
          const unscoped = `${workspaceFolder(WORKSPACE_B)}secret.txt`;
          await storeA.copy(unscoped, 'stolen.txt');
          expect(await storeA.head('stolen.txt')).toBeNull();
          const after = await storeB.read('secret.txt');
          expect(asText(await streamToBytes(after!.body))).toBe('B only');
          expect(await storeB.head('secret.txt')).toEqual(before);
        } finally {
          await teardown();
        }
      });
    });

    describe('a foreign object the key guard refuses', () => {
      it('is skipped by every listing, not fatal', async () => {
        const { provider, teardown, plantRaw } = await setup();
        try {
          // Nothing but this module writes to the in-memory reference, so it cannot hold one.
          if (plantRaw === undefined) return;
          const store = provider.forWorkspace(WORKSPACE_A);
          await store.write('docs/real.txt', utf8('real'), {});
          const root = `${workspaceFolder(WORKSPACE_A)}docs`;
          // A console "create folder" is a zero-byte `name/` object; a bare `%` is a legal object
          // name everywhere and never a valid key.
          await plantRaw(`${root}/console-folder/`, new Uint8Array());
          await plantRaw(`${root}/50%.txt`, utf8('foreign'));

          const recursive = (await store.listPage('docs', { recursive: true })).entries;
          expect(recursive.map((entry) => entry.key)).toEqual(['docs/real.txt']);
          expect((await store.listPage('docs/console-folder')).entries).toEqual([]);
          const listings = [
            recursive,
            (await store.listPage('docs')).entries,
            await listAll(store, 'docs'),
            await listAll(store, 'docs', { recursive: true }),
          ];
          for (const entries of listings) {
            for (const entry of entries) expect(() => toObjectKey(entry.key)).not.toThrow();
            expect(entries.map((entry) => entry.key)).toContain('docs/real.txt');
          }
        } finally {
          await teardown();
        }
      });
    });

    describe('signing', () => {
      async function withSigning(
        run: (store: ObjectStore, fetchable: boolean, refusesExpired: boolean) => Promise<void>,
      ): Promise<void> {
        const { provider, teardown, signedUrlsFetchable, refusesExpiredSigning } = await setup();
        try {
          await run(
            provider.forWorkspace(WORKSPACE_A),
            signedUrlsFetchable === true,
            refusesExpiredSigning === true,
          );
        } finally {
          await teardown();
        }
      }

      it('is offered exactly when the backend declares it', async () => {
        await withStore((store) => {
          expect(store.createSignedUrl !== undefined).toBe(store.capabilities.sign);
          return Promise.resolve();
        });
      });

      // @story US-STO-02
      it('[US-STO-02][contract][sdk] expiry above 900 s is refused before any I/O', async () => {
        await withSigning(async (store) => {
          if (store.createSignedUrl === undefined) {
            expect(store.capabilities.sign).toBe(false);
            return;
          }
          await expect(
            store.createSignedUrl('a.txt', { method: 'GET', expiresInSeconds: 901 }),
          ).rejects.toThrow(SignedUrlUnsupportedError);
          // The "no backend call" half is proven by the recording backend in object-store.test.ts.
        });
      });

      // @story US-STO-05
      it('[US-STO-05][contract][sdk] a signed GET serves exactly one key and expires', async () => {
        await withSigning(async (store, fetchable, refusesExpired) => {
          if (store.createSignedUrl === undefined) return;
          await store.write('a.txt', utf8('alpha'), { contentType: 'text/plain' });
          await store.write('b.txt', utf8('bravo'), { contentType: 'text/plain' });
          const signed = await store.createSignedUrl('a.txt', { method: 'GET' });
          expect(() => new URL(signed.url)).not.toThrow();
          if (!fetchable) return;

          const served = await fetch(signed.url, { headers: signed.headers });
          expect(await served.text()).toBe('alpha');

          const other = new URL(signed.url);
          other.pathname = other.pathname.replace(/a\.txt$/, 'b.txt');
          expect((await fetch(other, { headers: signed.headers })).ok).toBe(false);

          const past = new Date(Date.now() - 120_000);
          const expiredRequest = { method: 'GET', expiresInSeconds: 60, now: past } as const;
          if (refusesExpired) {
            await expect(store.createSignedUrl('a.txt', expiredRequest)).rejects.toThrow(
              SignedUrlUnsupportedError,
            );
            return;
          }
          const expired = await store.createSignedUrl('a.txt', expiredRequest);
          expect((await fetch(expired.url, { headers: expired.headers })).ok).toBe(false);
        });
      });

      // @story US-STO-02
      it('[US-STO-02][contract][sdk] a signed PUT with a bound length refuses a different length', async () => {
        await withSigning(async (store, fetchable) => {
          if (store.createSignedUrl === undefined) return;
          const request = {
            method: 'PUT',
            contentLength: 3,
            requireBoundContentLength: true,
          } as const;
          if (!store.capabilities.boundLengthSign) {
            await expect(store.createSignedUrl('up.bin', request)).rejects.toThrow(
              SignedUrlUnsupportedError,
            );
            return;
          }
          const signed = await store.createSignedUrl('up.bin', request);
          expect(() => new URL(signed.url)).not.toThrow();
          if (!fetchable) return;

          const longer = await fetch(signed.url, {
            method: 'PUT',
            headers: signed.headers,
            body: utf8('four'),
          });
          expect(longer.ok).toBe(false);
          expect(await store.head('up.bin')).toBeNull();

          const exact = await fetch(signed.url, {
            method: 'PUT',
            headers: signed.headers,
            body: utf8('abc'),
          });
          expect(exact.ok).toBe(true);
          expect((await store.head('up.bin'))?.sizeBytes).toBe(3);
        });
      });
    });
  });
}

/**
 * Paging a backend does itself (memory, the local filesystem, a connected folder): page size, key
 * order, cursor and the 1,000 clamp are this repository's to prove, so every such backend calls
 * this beside {@link defineObjectStoreContract}. A service that pages natively (S3, GCS, Azure)
 * does not: its paging is the provider's, and 1,001 writes do not fit the test timeout there.
 */
export function defineOwnPagingContract(
  label: string,
  setup: () => Promise<ObjectStoreContractFixture>,
): void {
  describe(`ObjectStore own paging — ${label}`, () => {
    async function withStore(
      run: (store: ObjectStore, fixture: ObjectStoreContractFixture) => Promise<void>,
    ): Promise<void> {
      const fixture = await setup();
      try {
        await run(fixture.provider.forWorkspace(WORKSPACE_A), fixture);
      } finally {
        await fixture.teardown();
      }
    }

    it('pages more than one default page in key order, clamping a larger limit to 1000', async () => {
      await withStore(async (store, { plantRaw }) => {
        const expected = Array.from(
          { length: 1001 },
          (_, index) => `big/${String(index).padStart(4, '0')}.txt`,
        );
        // Seeded the way a foreign tool fills the folder where the backend allows it: a store
        // write is durable (two fsyncs on a folder), and 2,002 fsyncs beside the parallel suite's
        // disk traffic took this test past its timeout. Paging, not the write path, is under test.
        const seed = (key: string): Promise<unknown> =>
          plantRaw === undefined
            ? store.write(key, utf8('x'), {})
            : plantRaw(`${workspaceFolder(WORKSPACE_A)}${key}`, utf8('x'));
        for (let from = 0; from < expected.length; from += 50) {
          await Promise.all(expected.slice(from, from + 50).map(seed));
        }

        const first = await store.listPage('big');
        expect(first.entries).toHaveLength(1000);
        expect(first.cursor).not.toBeNull();
        expect((await store.listPage('big', { limit: 5000 })).entries).toHaveLength(1000);

        const keys = first.entries.map((entry) => entry.key);
        const second = await store.listPage('big', { cursor: first.cursor ?? '' });
        keys.push(...second.entries.map((entry) => entry.key));
        expect(second.cursor).toBeNull();
        expect(keys).toEqual(expected);
      });
    });
  });
}
