/**
 * The local-filesystem backend's content-type sidecars: they live in a metadata tree beside the
 * object tree, so no key can name, forge or outlive one. Split out of `local-fs-store.test.ts`,
 * which keeps the contract suite and the rest of this backend's on-disk assertions.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { OBJECT_METADATA_SUFFIX, toObjectKey, UnsafeObjectKeyError } from './key-safety.js';
import { createLocalFilesystemObjectStoreProvider } from './local-fs-store.js';
import { listAll, readWhole } from './streams.js';

/**
 * The 8.3 short names NTFS has minted for the files in `dir`, read from the filesystem itself with
 * `dir /x`. Empty on any platform that has no such concept, and on a Windows volume where 8.3
 * creation is switched off — the caller skips rather than pretending, because a hard-coded alias
 * would assert a guess instead of what this machine actually did.
 */
function shortNamesOf(dir: string): string[] {
  if (process.platform !== 'win32') return [];
  let output: string;
  try {
    output = execFileSync('cmd', ['/c', 'dir', '/x', '/a-d', dir], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    // `dir /x` puts the short name in its own column, before the long name; a name that is already
    // 8.3-conformant needs no alias and leaves the column blank. Every minted alias contains `~N`,
    // which is what this matches — deliberately not the whole line, whose date and size columns
    // are locale-dependent.
    const match =
      /\s([A-Z0-9!#$%&'()@^_{}~-]{1,8}~\d+(?:\.[A-Z0-9!#$%&'()@^_{}~-]{1,3})?)\s+\S/.exec(line);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return [...names];
}

describe('local-filesystem ObjectStore — backend-specific proof', () => {
  const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';

  function scopedStore(rootDir: string) {
    return createLocalFilesystemObjectStoreProvider(rootDir).forWorkspace(WORKSPACE_ID);
  }

  it('writes exactly one content-type sidecar per object, and no caller can name or forge one', async () => {
    // The property `local-fs-store.ts`'s header rests on, asserted structurally rather than as a
    // claim about spelling: the object tree holds objects and nothing else, the sidecar is in a
    // sibling tree, and — the part that matters — every path a *key* can produce is inside the
    // object tree, so no spelling of any key, and no second name a filesystem mints for a file,
    // reaches the metadata tree. Rounds 1, 2 and 3 each broke a spelling rule; nothing here is a
    // spelling rule.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-03-objectstore-sidecar-'));
    try {
      const store = scopedStore(rootDir);
      await store.write('note.txt', new TextEncoder().encode('hello'), {
        contentType: 'text/plain',
      });

      // Sibling trees (a write stages its bytes in the third), and the object tree holds the object.
      expect((await readdir(rootDir)).sort()).toEqual(['metadata', 'objects', 'staging']);
      const objectDir = path.join(rootDir, 'objects', 'workspaces', WORKSPACE_ID);
      const metadataDir = path.join(rootDir, 'metadata', 'workspaces', WORKSPACE_ID);
      expect(await readdir(objectDir)).toEqual(['note.txt']);
      expect(await readdir(metadataDir)).toEqual([`note.txt${OBJECT_METADATA_SUFFIX}`]);

      // `list()` therefore filters nothing by name: there is nothing of this module's in the tree
      // it reads. (It still skips entries that are neither file nor directory — see the PR's
      // declared gap about junctions.)
      expect((await listAll(store, '')).map((e) => e.key)).toEqual(['note.txt']);

      // Every file the backend wrote outside the object tree is unreachable by construction —
      // asserted over what is actually on disk, and over the alias spellings that broke rounds 2
      // and 3, by checking where a key of that name would land rather than whether it is refused.
      for (const entry of await readdir(metadataDir)) {
        for (const spelling of [entry, entry.toUpperCase(), entry.toLowerCase(), `${entry}.`]) {
          let landed: string | null = null;
          try {
            landed = toObjectKey(`workspaces/${WORKSPACE_ID}/${spelling}`);
          } catch (error) {
            expect(error).toBeInstanceOf(UnsafeObjectKeyError);
          }
          if (landed !== null) {
            // Accepted keys are fine — they resolve into the object tree, never the metadata one.
            expect(path.join(rootDir, 'objects', ...landed.split('/'))).not.toContain(
              `${path.sep}metadata${path.sep}`,
            );
          }
        }
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('the 8.3 short name NTFS mints for a sidecar reaches nothing (verification round 4, B1)', async () => {
    // Round 3's counter-example, kept as a test. `NOTETX~1.JSO` is the NTFS short name of
    // `note.txt.%__objectstore_meta__%.json`: no `%`, no marker, accepted by the guard, and it
    // overwrote the victim's sidecar when sidecars lived beside their objects. It is a name the
    // *filesystem* invents after the guard has run, which is why no rule about spelling could have
    // caught it and why the sidecar moved out of the tree keys address instead.
    //
    // The short name is read from the real directory rather than assumed, and the case is skipped
    // where the concept does not exist (any non-Windows runner, and a Windows volume with 8.3
    // creation disabled) — a skip is honest; asserting a hard-coded alias would not be.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-03-objectstore-shortname-'));
    try {
      const store = scopedStore(rootDir);
      await store.write('note.txt', new TextEncoder().encode('hello'), {
        contentType: 'text/plain',
      });
      const metadataDir = path.join(rootDir, 'metadata', 'workspaces', WORKSPACE_ID);
      const objectDir = path.join(rootDir, 'objects', 'workspaces', WORKSPACE_ID);
      const aliases = shortNamesOf(metadataDir);
      if (aliases.length === 0) return; // not Windows, or 8.3 creation is off on this volume

      for (const alias of aliases) {
        // It is a legal key — that is the point. It must simply land somewhere harmless.
        await store.write(alias, new TextEncoder().encode('{"contentType":"text/html"}'), {});
      }

      // The victim keeps its content type, and its listing entry says so.
      expect((await readWhole(store, 'note.txt'))?.contentType).toBe('text/plain');
      expect(
        (await listAll(store, '')).map(
          (e) => `${e.key}:${e.kind === 'file' ? e.contentType : 'dir'}`,
        ),
      ).toEqual(expect.arrayContaining(['note.txt:text/plain']));
      // The bytes aimed at the sidecar landed in the object tree, as an ordinary object of their
      // own — visible in its own listing, not hidden behind a filter.
      expect((await readdir(objectDir)).sort()).toEqual(['note.txt', ...aliases].sort());
      expect((await listAll(store, '')).map((e) => e.key).sort()).toEqual(
        ['note.txt', ...aliases].sort(),
      );
      // The victim's sidecar is byte-for-byte what `write` wrote. Each alias object got a sidecar of
      // its own beside it, and could not have reached the victim's: a sidecar's name ends in a
      // 26-character suffix, so it is never itself an 8.3 short name (which is at most 12).
      expect(
        JSON.parse(
          await readFile(path.join(metadataDir, `note.txt${OBJECT_METADATA_SUFFIX}`), 'utf8'),
        ),
      ).toEqual({ contentType: 'text/plain' });
      expect((await readdir(metadataDir)).sort()).toEqual(
        ['note.txt', ...aliases].map((name) => `${name}${OBJECT_METADATA_SUFFIX}`).sort(),
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('a case variant of the reserved name forges nothing, and leaves the directory as it found it', async () => {
    // Verification round 3, F3/U2, as a test: every one of these was accepted by round 2's guard,
    // overwrote the victim's sidecar on this filesystem, forged the content type `list()` and
    // `get()` reported, and was then destroyed as collateral when `note.txt` was deleted.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-03-objectstore-sidecar-case-'));
    try {
      const store = scopedStore(rootDir);
      await store.write('note.txt', new TextEncoder().encode('hello'), {
        contentType: 'text/plain',
      });
      const objectDir = path.join(rootDir, 'objects', 'workspaces', WORKSPACE_ID);
      const metadataDir = path.join(rootDir, 'metadata', 'workspaces', WORKSPACE_ID);
      const before = {
        objects: (await readdir(objectDir)).sort(),
        metadata: (await readdir(metadataDir)).sort(),
      };

      const variants = [
        'note.txt.__objectstore_meta__.json',
        'note.txt.__objectstore_meta__.JSON',
        'note.txt.__ObjectStore_meta__.json',
        'note.txt.__OBJECTSTORE_META__.JSON',
        'note.txt.__objectstore_meta__.json::$DATA',
        `note.txt${OBJECT_METADATA_SUFFIX.toUpperCase()}`,
      ];
      for (const variant of variants) {
        await expect(
          store.write(variant, new TextEncoder().encode('{"contentType":"text/html"}'), {}),
        ).rejects.toThrow(UnsafeObjectKeyError);
      }

      expect((await readWhole(store, 'note.txt'))?.contentType).toBe('text/plain');
      expect((await listAll(store, '')).map((e) => e.key)).toEqual(['note.txt']);
      expect({
        objects: (await readdir(objectDir)).sort(),
        metadata: (await readdir(metadataDir)).sort(),
      }).toEqual(before);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('a failed sidecar write costs the content type and nothing else — the object is written and write resolves', async () => {
    // Verification round 5, B1. `write` wrote the object and then did `mkdir` + `writeFile` on the
    // metadata path with no `catch`, so a metadata-tree failure threw *after* the bytes had
    // landed: `POST NOTETX~1.JSO/x.txt` came out of the route handler as an uncaught EEXIST — a
    // framework 500 for a write that had succeeded — while three places said a half-completed
    // `write` cost "a content type and nothing else".
    //
    // The collision is forced here with an ordinary file rather than an 8.3 alias, so the case
    // runs on every platform: a file at the metadata path a later key needs as a *directory* is
    // the same EEXIST from the same `mkdir`.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-03-objectstore-metafail-'));
    try {
      const store = scopedStore(rootDir);
      const metadataDir = path.join(rootDir, 'metadata', 'workspaces', WORKSPACE_ID);
      await mkdir(metadataDir, { recursive: true });
      await writeFile(path.join(metadataDir, 'blocked'), 'not a directory', 'utf8');

      await expect(
        store.write('blocked/x.txt', new TextEncoder().encode('PAYLOAD'), {
          contentType: 'text/html',
        }),
      ).resolves.toMatchObject({ sizeBytes: 7, contentType: null });

      // The object: written, complete, readable, listed — and with no content type, which is the
      // declared cost and the whole of it.
      const stored = await readWhole(store, 'blocked/x.txt');
      expect(new TextDecoder().decode(stored?.body)).toBe('PAYLOAD');
      expect(stored?.contentType).toBeNull();
      expect((await listAll(store, 'blocked')).map((e) => `${e.key}`)).toEqual(['blocked/x.txt']);
      expect(
        await readdir(path.join(rootDir, 'objects', 'workspaces', WORKSPACE_ID, 'blocked')),
      ).toEqual(['x.txt']);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('a failed sidecar write never leaves an earlier content type describing the new bytes', async () => {
    // The decision recorded in `local-fs-store.ts`'s `catch`: a stale sidecar at this key is
    // removed on the way out, so `get` reports "unknown", never the *previous* object's type for
    // the current object's bytes. Forced by turning the sidecar path into a directory, which makes
    // `writeFile` fail with the object already written.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-03-objectstore-metastale-'));
    try {
      const store = scopedStore(rootDir);
      await store.write('note.txt', new TextEncoder().encode('first'), {
        contentType: 'text/plain',
      });
      const metaPath = path.join(
        rootDir,
        'metadata',
        'workspaces',
        WORKSPACE_ID,
        `note.txt${OBJECT_METADATA_SUFFIX}`,
      );
      await rm(metaPath, { force: true });
      await mkdir(metaPath, { recursive: true }); // a directory where the sidecar file belongs

      await expect(
        store.write('note.txt', new TextEncoder().encode('second'), {
          contentType: 'text/markdown',
        }),
      ).resolves.toMatchObject({ sizeBytes: 6, contentType: null });

      const stored = await readWhole(store, 'note.txt');
      expect(new TextDecoder().decode(stored?.body)).toBe('second');
      expect(stored?.contentType).toBeNull();
      expect((await listAll(store, ''))[0]).toMatchObject({ key: 'note.txt', contentType: null });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('deleting an object removes its sidecar with it, leaving nothing behind in either tree', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-03-objectstore-sidecar-del-'));
    try {
      const store = scopedStore(rootDir);
      await store.write('note.txt', new Uint8Array([1]), { contentType: 'text/plain' });
      await store.delete('note.txt');
      // Both trees, because the two writes `write` makes are two deletions here — the cost of the
      // split named in `local-fs-store.ts`'s header, asserted rather than assumed.
      expect(await readdir(path.join(rootDir, 'objects', 'workspaces', WORKSPACE_ID))).toEqual([]);
      expect(await readdir(path.join(rootDir, 'metadata', 'workspaces', WORKSPACE_ID))).toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
