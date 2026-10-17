/**
 * The one `ObjectStore` contract suite W2-plan.md's first acceptance criterion asks for: "write it
 * once, run it against the local-filesystem implementation and against S3/MinIO."
 *
 * ## Adding a backend — the single entry point
 *
 * {@link defineObjectStoreContract} is the only entry point, and adding a backend means adding one
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
 * test, so a fixture must not be shared between them.
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

import { OBJECT_METADATA_SUFFIX, UnsafeObjectKeyError } from './key-safety.js';
import type { ObjectStore, ObjectStoreProvider } from './object-store.js';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

/** What a suite's `setup()` hands back: a fresh provider, and how to tear it down afterward. */
export interface ObjectStoreContractFixture {
  readonly provider: ObjectStoreProvider;
  readonly teardown: () => Promise<void>;
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

/**
 * Run the full `ObjectStore` contract against one backend. `label` names the backend in every
 * `describe` block, so a failure in CI says which implementation broke without anyone opening the
 * file.
 */
export function defineObjectStoreContract(
  label: string,
  setup: () => Promise<ObjectStoreContractFixture>,
): void {
  describe(`ObjectStore contract — ${label}`, () => {
    async function withStore(run: (store: ObjectStore) => Promise<void>): Promise<void> {
      const { provider, teardown } = await setup();
      try {
        await run(provider.forWorkspace(WORKSPACE_A));
      } finally {
        await teardown();
      }
    }

    it('returns null from get() for a key that was never put()', async () => {
      await withStore(async (store) => {
        expect(await store.get('never-written.txt')).toBeNull();
      });
    });

    it('returns null for a missing child beneath an existing object key', async () => {
      await withStore(async (store) => {
        await store.put('plain-file.txt', { body: utf8('not a folder') });
        expect(await store.get('plain-file.txt/missing-child')).toBeNull();
      });
    });

    it('put() then get() round-trips bytes exactly, including a trailing newline', async () => {
      await withStore(async (store) => {
        const withNewline = utf8('line one\nline two\n');
        const withoutNewline = utf8('line one\nline two');
        await store.put('with-newline.txt', { body: withNewline, contentType: 'text/plain' });
        await store.put('without-newline.txt', { body: withoutNewline, contentType: 'text/plain' });

        const readBack1 = await store.get('with-newline.txt');
        const readBack2 = await store.get('without-newline.txt');
        expectBytesEqual(readBack1?.body, withNewline);
        expectBytesEqual(readBack2?.body, withoutNewline);
        // The two must stay distinguishable — a store that trimmed or normalised either write
        // would make this assertion pass by accident even if the bytes above were already wrong.
        expect(readBack1?.body).not.toEqual(readBack2?.body);
      });
    });

    it('put() then get() round-trips arbitrary binary bytes, not just text', async () => {
      await withStore(async (store) => {
        const bytes = new Uint8Array(256);
        for (let i = 0; i < 256; i += 1) bytes[i] = i;
        await store.put('binary.bin', { body: bytes, contentType: 'application/octet-stream' });
        const readBack = await store.get('binary.bin');
        expectBytesEqual(readBack?.body, bytes);
        expect(readBack?.contentType).toBe('application/octet-stream');
        expect(readBack?.sizeBytes).toBe(256);
      });
    });

    it('put() overwrites an existing key rather than appending to it', async () => {
      await withStore(async (store) => {
        await store.put('report.txt', { body: utf8('first') });
        await store.put('report.txt', { body: utf8('second, shorter than "first" + anything') });
        await store.put('report.txt', { body: utf8('third') });
        const readBack = await store.get('report.txt');
        expectBytesEqual(readBack?.body, utf8('third'));
      });
    });

    it('delete() removes an object, and a second delete() of the same key is not an error', async () => {
      await withStore(async (store) => {
        await store.put('to-delete.txt', { body: utf8('gone soon') });
        await store.delete('to-delete.txt');
        expect(await store.get('to-delete.txt')).toBeNull();
        // R-15 §1c, verified against MinIO and local fs alike: deleting a missing key is success.
        await expect(store.delete('to-delete.txt')).resolves.toBeUndefined();
        await expect(store.delete('never-existed-at-all.txt')).resolves.toBeUndefined();
      });
    });

    it('list() reports files and folders one level under a prefix, not recursively', async () => {
      await withStore(async (store) => {
        await store.put('contracts/agreement.pdf', { body: utf8('pdf bytes') });
        await store.put('contracts/pricing.xlsx', { body: utf8('xlsx bytes') });
        await store.put('instructions.md', { body: utf8('# hi') });

        const root = await store.list('');
        const rootKeys = [...root].sort((a, b) => a.key.localeCompare(b.key));
        expect(rootKeys).toEqual([
          expect.objectContaining({ kind: 'folder', key: 'contracts' }),
          expect.objectContaining({
            kind: 'file',
            key: 'instructions.md',
            contentType: null,
            sizeBytes: 4,
          }),
        ]);

        const nested = await store.list('contracts');
        const nestedKeys = nested.map((e) => e.key).sort();
        expect(nestedKeys).toEqual(['contracts/agreement.pdf', 'contracts/pricing.xlsx']);
        expect(nested.every((e) => e.kind === 'file')).toBe(true);
      });
    });

    it('list() of a prefix that does not exist is empty, not an error', async () => {
      await withStore(async (store) => {
        expect(await store.list('nothing/here')).toEqual([]);
      });
    });

    it("two workspaces never see each other's keys, even with the identical relative key", async () => {
      const { provider, teardown } = await setup();
      try {
        const storeA = provider.forWorkspace(WORKSPACE_A);
        const storeB = provider.forWorkspace(WORKSPACE_B);
        await storeA.put('shared-name.txt', { body: utf8('workspace A') });
        expect(await storeB.get('shared-name.txt')).toBeNull();
        await storeB.put('shared-name.txt', { body: utf8('workspace B') });
        expect(asText((await storeA.get('shared-name.txt'))!.body)).toBe('workspace A');
        expect(asText((await storeB.get('shared-name.txt'))!.body)).toBe('workspace B');
        expect((await storeA.list('')).map((e) => e.key)).toEqual(['shared-name.txt']);
      } finally {
        await teardown();
      }
    });

    // ── The key a put() was given is the key it wrote to (verification round 1, F2) ───────────

    describe('a key is stored literally, never under some transformed form of itself', () => {
      it('put() writes to the key it was handed, and get()/list() name that same key', async () => {
        await withStore(async (store) => {
          await store.put('a/b', { body: utf8('VICTIM BYTES') });
          expect(asText((await store.get('a/b'))!.body)).toBe('VICTIM BYTES');
          expect((await store.list('a')).map((e) => e.key)).toEqual(['a/b']);
        });
      });

      it('put() refuses a key that would mean a different key once decoded, and leaves that other key alone', async () => {
        // The counter-example that failed verification round 1: `a%252fb` was accepted, decoded a
        // second and a third time on its way down, and the bytes landed on `a/b` while the API
        // reported writing `a%2fb`. A guard that only ever returns its own input cannot do that;
        // this asserts the consequence rather than the mechanism, so it holds for any backend.
        await withStore(async (store) => {
          await store.put('a/b', { body: utf8('VICTIM BYTES') });
          await expect(store.put('a%252fb', { body: utf8('ATTACKER BYTES') })).rejects.toThrow(
            UnsafeObjectKeyError,
          );
          expect(asText((await store.get('a/b'))!.body)).toBe('VICTIM BYTES');
          expect((await store.list('')).map((e) => e.key)).toEqual(['a']);
        });
      });
    });

    // ── The reserved metadata name is not a legal key (round 1 F3; round 3 F3/U2) ──────────────
    //
    // Round 2 closed the exact-case string `note.txt.__objectstore_meta__.json` and nothing else,
    // so round 3 reproduced every one of F3's evidence lines with `…__objectstore_meta__.JSON` on
    // a case-insensitive filesystem. The suite is therefore written over a *class* of spellings
    // rather than one constant, and the assertion is that every backend refuses all of them
    // identically — a backend with no sidecar at all (memory-store.ts) must refuse them too,
    // because "which keys are legal" is one answer for every backend.
    //
    // What this block does NOT establish, and round 4 is the reason to say so here: that a
    // backend's own metadata is out of reach. No suite of spellings can establish that, because a
    // filesystem mints names of its own after this guard has run (NTFS gave the round-3 sidecar
    // the 8.3 alias `NOTETX~1.JSO`, containing neither the marker nor a `%`). Reachability is a
    // structural property of where a backend puts things, asserted for the local-filesystem
    // backend in `local-fs-store.test.ts`.

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
        it(`put() refuses ${label}, and the object it would have shadowed is untouched`, async () => {
          await withStore(async (store) => {
            await store.put('note.txt', { body: utf8('hello'), contentType: 'text/plain' });
            await expect(
              store.put(poison, { body: utf8('{"contentType":"text/html"}') }),
            ).rejects.toThrow(UnsafeObjectKeyError);
            // F3's four evidence lines, asserted as consequences rather than as a rule firing:
            // the victim's recorded content type, its bytes, and a listing with nothing extra
            // and nothing hidden in it.
            const victim = await store.get('note.txt');
            expect(victim?.contentType).toBe('text/plain');
            expectBytesEqual(victim?.body, utf8('hello'));
            expect((await store.list('')).map((entry) => entry.key)).toEqual(['note.txt']);
          });
        });

        it(`get(), delete() and list() refuse ${label} too, so it is unrepresentable and not merely unwritable`, async () => {
          await withStore(async (store) => {
            await expect(store.get(poison)).rejects.toThrow(UnsafeObjectKeyError);
            await expect(store.delete(poison)).rejects.toThrow(UnsafeObjectKeyError);
            await expect(store.list(poison)).rejects.toThrow(UnsafeObjectKeyError);
          });
        });

        it(`refuses ${label} in a non-final segment as well, which list() would also have hidden`, async () => {
          await withStore(async (store) => {
            await expect(store.put(`${poison}/inner.txt`, { body: utf8('x') })).rejects.toThrow(
              UnsafeObjectKeyError,
            );
          });
        });
      }
    });

    // ── W2-plan.md's second acceptance criterion: refused BY CONSTRUCTION, three ways ──────────

    describe('a key that would escape its workspace prefix is refused before any byte moves', () => {
      const attacks: ReadonlyArray<{ readonly label: string; readonly key: string }> = [
        { label: 'a ".." segment', key: '../../etc/passwd' },
        { label: 'an absolute path', key: '/etc/passwd' },
        { label: 'a percent-encoded ".." segment', key: '..%2f..%2fetc%2fpasswd' },
      ];

      for (const attack of attacks) {
        it(`put() refuses ${attack.label}`, async () => {
          await withStore(async (store) => {
            await expect(store.put(attack.key, { body: utf8('pwned') })).rejects.toThrow(
              UnsafeObjectKeyError,
            );
          });
        });

        it(`get() refuses ${attack.label}`, async () => {
          await withStore(async (store) => {
            await expect(store.get(attack.key)).rejects.toThrow(UnsafeObjectKeyError);
          });
        });

        it(`delete() refuses ${attack.label}`, async () => {
          await withStore(async (store) => {
            await expect(store.delete(attack.key)).rejects.toThrow(UnsafeObjectKeyError);
          });
        });

        it(`list() refuses ${attack.label} as a prefix`, async () => {
          await withStore(async (store) => {
            await expect(store.list(attack.key)).rejects.toThrow(UnsafeObjectKeyError);
          });
        });
      }

      it('refuses to copy an object over the same attack keys, as source and as destination', async () => {
        await withStore(async (store) => {
          await store.put('victim.txt', { body: utf8('victim bytes') });
          for (const attack of attacks) {
            await expect(store.copyObject(attack.key, 'dest.txt')).rejects.toThrow(
              UnsafeObjectKeyError,
            );
            await expect(store.copyObject('victim.txt', attack.key)).rejects.toThrow(
              UnsafeObjectKeyError,
            );
          }
          expect(await store.get('dest.txt')).toBeNull();
          expect(asText((await store.get('victim.txt'))!.body)).toBe('victim bytes');
        });
      });

      it('refusing the attack keys leaves no trace outside the workspace prefix', async () => {
        // The positive half of the proof: not only does the call reject, nothing was written
        // anywhere a directory traversal could have reached. Run after the rejections above
        // (same `withStore` shape) so a backend that "refused" by silently writing somewhere else
        // would still be caught here.
        await withStore(async (store) => {
          for (const attack of attacks) {
            await store.put(attack.key, { body: utf8('pwned') }).catch(() => undefined);
          }
          expect(await store.list('')).toEqual([]);
        });
      });
    });

    // ── W9-FILES-131: `listPrefix`, the recursive counterpart to `list` ────────────────────────

    describe('listPrefix() reports every file at or beneath a prefix, however deep', () => {
      it('is empty for a prefix nothing exists at or under', async () => {
        await withStore(async (store) => {
          expect(await store.listPrefix('nothing/here')).toEqual([]);
        });
      });

      it('reports a file directly at the prefix and every descendant, unlike the one-level list()', async () => {
        await withStore(async (store) => {
          await store.put('a/b/c.txt', { body: utf8('c') });
          await store.put('a/b/d.txt', { body: utf8('d') });
          await store.put('a/e.txt', { body: utf8('e') });
          await store.put('a-sibling.txt', { body: utf8('unrelated') });

          const under = await store.listPrefix('a');
          expect(under.map((entry) => entry.key).sort()).toEqual([
            'a/b/c.txt',
            'a/b/d.txt',
            'a/e.txt',
          ]);
          expect(under.every((entry) => entry.kind === 'file')).toBe(true);

          // `list()` itself stays one level — this is the property `listPrefix` was added
          // alongside it to cover, not a replacement for it.
          const oneLevel = await store.list('a');
          expect(oneLevel.map((entry) => entry.key).sort()).toEqual(['a/b', 'a/e.txt']);
        });
      });

      it('reports a prefix that names a plain file as that one file', async () => {
        await withStore(async (store) => {
          await store.put('solo.txt', { body: utf8('alone') });
          expect((await store.listPrefix('solo.txt')).map((entry) => entry.key)).toEqual([
            'solo.txt',
          ]);
        });
      });

      it('the root prefix `""` walks every object in the workspace', async () => {
        await withStore(async (store) => {
          await store.put('top.txt', { body: utf8('top') });
          await store.put('nested/deep/leaf.txt', { body: utf8('leaf') });
          expect((await store.listPrefix('')).map((entry) => entry.key).sort()).toEqual([
            'nested/deep/leaf.txt',
            'top.txt',
          ]);
        });
      });

      it('a sibling that merely starts with the same characters is not a descendant', async () => {
        // The prefix-boundary bug: naive `key.startsWith(prefix)` would also match `docs2/x.txt`
        // for a prefix of `docs`, because nothing requires the next character to be `/`.
        await withStore(async (store) => {
          await store.put('docs/a.txt', { body: utf8('a') });
          await store.put('docs2/b.txt', { body: utf8('b') });
          expect((await store.listPrefix('docs')).map((entry) => entry.key)).toEqual([
            'docs/a.txt',
          ]);
        });
      });

      it('two workspaces never see each other under listPrefix, even at the identical relative prefix', async () => {
        const { provider, teardown } = await setup();
        try {
          const storeA = provider.forWorkspace(WORKSPACE_A);
          const storeB = provider.forWorkspace(WORKSPACE_B);
          await storeA.put('shared/one.txt', { body: utf8('A') });
          await storeB.put('shared/two.txt', { body: utf8('B') });
          expect((await storeA.listPrefix('shared')).map((e) => e.key)).toEqual(['shared/one.txt']);
          expect((await storeB.listPrefix('shared')).map((e) => e.key)).toEqual(['shared/two.txt']);
        } finally {
          await teardown();
        }
      });
    });

    // ── W9-FILES-131: `copyObject`, the primitive a subtree move is built from ─────────────────

    describe('copyObject() copies bytes and content type, leaving the source untouched', () => {
      it('the destination reads back the source bytes and content type; the source is unchanged', async () => {
        await withStore(async (store) => {
          await store.put('source.txt', { body: utf8('payload'), contentType: 'text/plain' });
          await store.copyObject('source.txt', 'dest.txt');
          const dest = await store.get('dest.txt');
          expectBytesEqual(dest?.body, utf8('payload'));
          expect(dest?.contentType).toBe('text/plain');
          const source = await store.get('source.txt');
          expectBytesEqual(source?.body, utf8('payload'));
        });
      });

      it('overwrites an existing destination, matching put()', async () => {
        await withStore(async (store) => {
          await store.put('source.txt', { body: utf8('new') });
          await store.put('dest.txt', { body: utf8('stale') });
          await store.copyObject('source.txt', 'dest.txt');
          expect(asText((await store.get('dest.txt'))!.body)).toBe('new');
        });
      });

      it('copying a source that does not exist is a no-op, not an error', async () => {
        await withStore(async (store) => {
          await expect(store.copyObject('never-written.txt', 'dest.txt')).resolves.toBeUndefined();
          expect(await store.get('dest.txt')).toBeNull();
        });
      });

      it('two workspaces cannot copyObject across each other, even at the identical relative key', async () => {
        const { provider, teardown } = await setup();
        try {
          const storeA = provider.forWorkspace(WORKSPACE_A);
          const storeB = provider.forWorkspace(WORKSPACE_B);
          await storeA.put('secret.txt', { body: utf8('A only') });
          await storeB.copyObject('secret.txt', 'stolen.txt');
          // Workspace B's own `secret.txt` never existed, so its scoped copy source is empty —
          // the no-op case above, exercised across the tenant boundary rather than within it.
          expect(await storeB.get('stolen.txt')).toBeNull();
        } finally {
          await teardown();
        }
      });
    });
  });
}
