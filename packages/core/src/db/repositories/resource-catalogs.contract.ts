/**
 * The one catalog contract suite (the storage design, §03 and §04): the in-memory catalog and the
 * PostgreSQL catalog both run it, so a test that passes against the memory version cannot hide a
 * rule the database enforces. Cases drive {@link CatalogPort}.
 *
 * A fixture owes the suite one catalog per workspace (`'a'` and `'b'`, empty and unrelated to every
 * other fixture's) and the principal that owns rows written in each. `makeFixture` runs once per
 * test.
 */
import { describe, expect, it } from 'vitest';

import type { FileStatus } from '../schema/files.js';
import { sidePath } from '../side-paths.js';
import {
  CatalogPathPendingError,
  CatalogPathTakenError,
  type CatalogFile,
  type CatalogPort,
  type CatalogSkill,
  type ReserveOutcome,
  type ResourceCatalogRepository,
} from './resource-catalogs.js';

export interface CatalogConformanceFixture {
  readonly catalog: (workspace: 'a' | 'b') => ResourceCatalogRepository;
  readonly ownerA: string;
  readonly ownerB: string;
  /** A member of workspace `'a'`, valid as a row's `createdBy`. */
  readonly actorA: string;
  /** Put a file row in any state, bypassing the port, the way a raw insert does. Rejects on a duplicate. */
  readonly seed: (
    workspace: 'a' | 'b',
    row: { readonly path: string; readonly status: FileStatus; readonly objectId: string },
  ) => Promise<void>;
}

export function describeCatalogConformance(
  label: string,
  makeFixture: () => Promise<CatalogConformanceFixture>,
): void {
  describe(`catalog conformance: ${label}`, () => {
    const upload = async (
      catalog: CatalogPort,
      owner: string,
      path: string,
      sizeBytes = 1,
    ): Promise<CatalogFile> => {
      const reserved = await catalog.reserve(path, {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: owner,
        sizeBytes,
        contentType: null,
      });
      if (reserved.kind !== 'reserved') throw new Error(`${path} was already taken`);
      const done = await catalog.confirm(reserved.row, { sizeBytes, contentType: 'text/plain' });
      if (done === null) throw new Error(`${path} vanished before confirm`);
      return done.row;
    };
    const replace = async (
      catalog: CatalogPort,
      owner: string,
      path: string,
    ): Promise<ReserveOutcome> =>
      catalog.reserve(path, {
        ownerPrincipalId: owner,
        sizeBytes: 1,
        contentType: null,
        objectId: crypto.randomUUID(),
      });
    const paths = (rows: readonly CatalogFile[]) => rows.map((row) => row.path);
    const pending = async (catalog: CatalogPort, owner: string, path: string) => {
      const reserved = await catalog.reserve(path, {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: owner,
        sizeBytes: 5,
        contentType: null,
      });
      if (reserved.kind !== 'reserved') throw new Error(`${path} was already taken`);
      return reserved.row;
    };
    /** PostgreSQL's CHECK violation, as the driver error's cause carries it. */
    const checkViolation = (constraint: string) => ({ cause: { code: '23514', constraint } });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] a reserved row is pending and invisible to get and list', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const reserved = await a.reserve('big.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 5,
        contentType: null,
      });
      expect(reserved).toMatchObject({
        kind: 'reserved',
        row: { path: 'big.bin', kind: 'file', status: 'pending', ownerPrincipalId: ownerA },
      });
      await expect(a.get('big.bin')).resolves.toBeNull();
      expect(paths((await a.list('')).rows)).not.toContain('big.bin');
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] new rows default to the files area with the reserved object id', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const reserved = await a.reserve('docs/big.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 5,
        contentType: null,
      });
      const defaults = { area: 'files', sha256: null };
      const { objectId } = reserved.row;
      expect(reserved.row).toMatchObject({ ...defaults, storageKey: `files/${String(objectId)}` });
      await expect(
        a.confirm(reserved.row, { sizeBytes: 5, contentType: null }),
      ).resolves.toMatchObject({ row: { ...defaults, objectId } });
      await expect(a.get('docs')).resolves.toMatchObject({
        kind: 'folder',
        ...defaults,
        objectId: null,
      });
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] two rows in one workspace never share an object id', async () => {
      const { seed } = await makeFixture();
      const objectId = crypto.randomUUID();
      await seed('a', { path: 'one.bin', status: 'ready', objectId });
      await expect(seed('a', { path: 'two.bin', status: 'ready', objectId })).rejects.toThrow();
      await expect(
        seed('b', { path: 'one.bin', status: 'ready', objectId }),
      ).resolves.toBeUndefined();
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] get with includePending returns a pending row', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const reserved = await a.reserve('big.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 5,
        contentType: null,
      });
      await expect(a.get('big.bin', { includePending: true })).resolves.toMatchObject({
        id: reserved.row.id,
        status: 'pending',
      });
      await expect(a.get('missing.bin', { includePending: true })).resolves.toBeNull();
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] confirm makes the row ready and listed', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const reserved = await a.reserve('big.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 5,
        contentType: null,
      });
      const confirmed = await a.confirm(reserved.row, {
        sizeBytes: 7,
        contentType: 'application/octet-stream',
        sha256: null,
      });
      expect(confirmed).toMatchObject({
        row: {
          id: reserved.row.id,
          status: 'ready',
          sizeBytes: 7,
          contentType: 'application/octet-stream',
        },
      });
      expect(confirmed?.replaced).toBeUndefined();
      await expect(a.get('big.bin')).resolves.toMatchObject({ id: reserved.row.id });
      expect(paths((await a.list('')).rows)).toContain('big.bin');
    });

    // @story US-STO-01
    it('[US-STO-01][contract][sdk] every returned row says when it was last written, and get and list agree', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const reserved = await a.reserve('dated/a.txt', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 1,
        contentType: null,
      });
      expect(reserved.row.updatedAt).toBeInstanceOf(Date);
      const confirmed = await a.confirm(reserved.row, { sizeBytes: 1, contentType: 'text/plain' });
      const written = confirmed?.row.updatedAt;
      expect(written).toBeInstanceOf(Date);
      expect(written?.getTime()).toBeGreaterThanOrEqual(reserved.row.updatedAt?.getTime() ?? 0);
      expect((await a.get('dated/a.txt'))?.updatedAt).toEqual(written);
      const listed = (await a.list('')).rows;
      expect(listed.find((row) => row.path === 'dated/a.txt')?.updatedAt).toEqual(written);
      expect(listed.find((row) => row.path === 'dated')?.updatedAt).toBeInstanceOf(Date);
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] pending finds the upload for a path, a pending replacement included', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await expect(a.pending('x.bin')).resolves.toBeNull();

      const fresh = await pending(a, ownerA, 'x.bin');
      await expect(a.pending('x.bin')).resolves.toMatchObject({ id: fresh.id });
      await a.confirm(fresh, { sizeBytes: 5, contentType: null });
      await expect(a.pending('x.bin')).resolves.toBeNull();

      const replacement = await replace(a, ownerA, 'x.bin');
      if (replacement.kind !== 'reserved') throw new Error('x.bin was not replaceable');
      await expect(a.get('x.bin', { includePending: true })).resolves.not.toMatchObject({
        id: replacement.row.id,
      });
      await expect(a.pending('x.bin')).resolves.toMatchObject({ id: replacement.row.id });
      await expect(catalog('b').pending('x.bin')).resolves.toBeNull();

      await a.forget(replacement.row);
      await expect(a.pending('x.bin')).resolves.toBeNull();
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] countPending counts pending rows of one workspace', async () => {
      const { catalog, ownerA, ownerB } = await makeFixture();
      const a = catalog('a');
      const b = catalog('b');
      const reserve = (target: CatalogPort, owner: string, path: string) =>
        target.reserve(path, {
          objectId: crypto.randomUUID(),
          ownerPrincipalId: owner,
          sizeBytes: 1,
          contentType: null,
        });
      const x = await reserve(a, ownerA, 'x.bin');
      await reserve(a, ownerA, 'y.bin');
      await reserve(b, ownerB, 'z.bin');
      await expect(a.countPending()).resolves.toBe(2);
      await expect(b.countPending()).resolves.toBe(1);

      await a.confirm(x.row, { sizeBytes: 1, contentType: null });
      await expect(a.countPending()).resolves.toBe(1);
      await reserve(a, ownerA, 'y.bin');
      await expect(a.countPending()).resolves.toBe(1);

      await a.remove('y.bin');
      await expect(a.countPending()).resolves.toBe(0);
      await expect(b.countPending()).resolves.toBe(1);

      await a.reserve('.staging-s', {
        area: 'staging',
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 0,
        contentType: null,
      });
      await expect(a.countPending()).resolves.toBe(0);
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] countPending with a cut-off counts only reservations made at or after it', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await pending(a, ownerA, 'one.bin');
      await pending(a, ownerA, 'two.bin');
      const minute = 60_000;

      await expect(a.countPending(new Date(Date.now() - minute))).resolves.toBe(2);
      await expect(a.countPending(new Date(Date.now() + minute))).resolves.toBe(0);
      await expect(a.countPending()).resolves.toBe(2);
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] one row per path', async () => {
      const { catalog, ownerA, ownerB } = await makeFixture();
      const a = catalog('a');
      const first = await a.reserve('big.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 5,
        contentType: null,
      });
      await expect(
        a.reserve('big.bin', {
          objectId: crypto.randomUUID(),
          ownerPrincipalId: ownerB,
          sizeBytes: 9,
          contentType: 'text/plain',
        }),
      ).rejects.toBeInstanceOf(CatalogPathPendingError);
      await expect(a.get('big.bin')).resolves.toBeNull();
      await a.confirm(first.row, { sizeBytes: 5, contentType: null });
      const third = await a.reserve('big.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 9,
        contentType: null,
      });
      // A reserve over a ready file waits aside to replace it.
      expect(third).toMatchObject({
        kind: 'reserved',
        row: { targetPath: 'big.bin', status: 'pending' },
        replaces: { id: first.row.id, ownerPrincipalId: ownerA, status: 'ready' },
      });
      expect(paths((await a.list('')).rows).filter((path) => path === 'big.bin')).toHaveLength(1);
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] a pending row is refreshed only by a reserve of its own upload mode', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const input = { ownerPrincipalId: ownerA, contentType: null };
      // (a) a relay save over the owner's pending signed upload must not reset its declared size.
      const signed = await a.reserve('signed.bin', {
        objectId: crypto.randomUUID(),
        ...input,
        sizeBytes: 9,
        uploadMode: 'signed',
      });
      await expect(
        a.reserve('signed.bin', {
          objectId: crypto.randomUUID(),
          ...input,
          sizeBytes: 0,
          uploadMode: 'relay',
        }),
      ).rejects.toBeInstanceOf(CatalogPathPendingError);
      await expect(
        a.reserve('signed.bin', { objectId: crypto.randomUUID(), ...input, sizeBytes: 0 }),
      ).rejects.toBeInstanceOf(CatalogPathPendingError);
      await expect(
        a.reserve('signed.bin', {
          objectId: crypto.randomUUID(),
          ...input,
          sizeBytes: 9,
          uploadMode: 'signed',
        }),
      ).resolves.toMatchObject({ kind: 'taken', row: { id: signed.row.id, sizeBytes: 9 } });
      await expect(a.pending('signed.bin')).resolves.toMatchObject({ sizeBytes: 9 });
      // (b) a mint during the owner's in-flight relay save must not take over the save's row.
      const relay = await a.reserve('relay.bin', {
        objectId: crypto.randomUUID(),
        ...input,
        sizeBytes: 0,
        uploadMode: 'relay',
      });
      await expect(
        a.reserve('relay.bin', {
          objectId: crypto.randomUUID(),
          ...input,
          sizeBytes: 5,
          uploadMode: 'signed',
        }),
      ).rejects.toBeInstanceOf(CatalogPathPendingError);
      await expect(a.pending('relay.bin')).resolves.toMatchObject({
        id: relay.row.id,
        sizeBytes: 0,
      });
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] confirm of a forgotten row returns null', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const reserved = await a.reserve('big.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 5,
        contentType: null,
      });
      const [removed] = await a.remove('big.bin');
      expect(removed).toMatchObject({ id: reserved.row.id, status: 'deleting' });
      await expect(
        a.confirm(reserved.row, { sizeBytes: 5, contentType: null }),
      ).resolves.toBeNull();
      await expect(a.get('big.bin', { includePending: true })).resolves.toBeNull();
      if (removed !== undefined) await a.forget(removed);
      await expect(
        a.confirm(reserved.row, { sizeBytes: 5, contentType: null }),
      ).resolves.toBeNull();
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] confirm of a ready row returns null and changes nothing', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const ready = await upload(a, ownerA, 'done.txt', 4);
      await expect(
        a.confirm(ready, { sizeBytes: 9, contentType: 'image/png' }),
      ).resolves.toBeNull();
      await expect(a.get('done.txt')).resolves.toMatchObject({
        id: ready.id,
        sizeBytes: 4,
        contentType: 'text/plain',
      });
      await expect(
        a.confirm(ready, { sizeBytes: 9, contentType: 'image/png', expect: 'any' }),
      ).resolves.toMatchObject({ row: { id: ready.id, status: 'ready', sizeBytes: 9 } });
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] the owner re-reserves a pending path with a new size', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const row = await pending(a, ownerA, 'big.bin');
      await expect(
        a.reserve('big.bin', {
          objectId: crypto.randomUUID(),
          ownerPrincipalId: ownerA,
          sizeBytes: 9,
          contentType: 'text/csv',
        }),
      ).resolves.toMatchObject({
        kind: 'taken',
        row: { id: row.id, status: 'pending', sizeBytes: 9, contentType: 'text/csv' },
      });
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] another member cannot re-reserve a pending path', async () => {
      const { catalog, ownerA, ownerB } = await makeFixture();
      const a = catalog('a');
      const row = await pending(a, ownerA, 'big.bin');
      await expect(
        a.reserve('big.bin', {
          objectId: crypto.randomUUID(),
          ownerPrincipalId: ownerB,
          sizeBytes: 9,
          contentType: null,
        }),
      ).rejects.toBeInstanceOf(CatalogPathPendingError);
      await expect(a.get('big.bin', { includePending: true })).resolves.toEqual(row);
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] a folder move refuses while a child is pending', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const done = await upload(a, ownerA, 'docs/done.txt');
      const row = await pending(a, ownerA, 'docs/sub/x.bin');
      await expect(a.rename('docs', 'moved')).rejects.toBeInstanceOf(CatalogPathPendingError);
      await expect(a.get('docs/done.txt')).resolves.toMatchObject({ id: done.id });
      await expect(a.get('docs/sub/x.bin', { includePending: true })).resolves.toEqual(row);
      await expect(a.get('moved', { includePending: true })).resolves.toBeNull();
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] a move never carries a pending row: the row itself, a replacement, or the destination', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      // The pending row itself: an in-flight PUT still targets its key.
      const lone = await pending(a, ownerA, 'big.bin');
      await expect(a.rename('big.bin', 'moved.bin')).rejects.toBeInstanceOf(
        CatalogPathPendingError,
      );
      await expect(a.get('big.bin', { includePending: true })).resolves.toEqual(lone);
      await expect(a.get('moved.bin', { includePending: true })).resolves.toBeNull();

      // A ready child whose replacement is pending at its side path.
      const ready = await upload(a, ownerA, 'docs/x.bin');
      const replacement = await replace(a, ownerA, 'docs/x.bin');
      if (replacement.kind !== 'reserved') throw new Error('docs/x.bin was not replaceable');
      await expect(a.rename('docs', 'moved')).rejects.toBeInstanceOf(CatalogPathPendingError);
      await expect(a.get('docs/x.bin')).resolves.toMatchObject({ id: ready.id });
      await expect(a.pending('docs/x.bin')).resolves.toMatchObject({ id: replacement.row.id });
      await expect(a.get('moved', { includePending: true })).resolves.toBeNull();

      // A destination held by a pending upload is taken, not overwritten.
      await a.forget(replacement.row);
      const target = await pending(a, ownerA, 'dest/x.bin');
      await expect(a.rename('docs', 'dest')).rejects.toBeInstanceOf(CatalogPathTakenError);
      await expect(a.get('dest/x.bin', { includePending: true })).resolves.toEqual(target);
      await expect(a.get('docs/x.bin')).resolves.toMatchObject({ id: ready.id });
    });

    it('refuses a dot segment in a path as the files_path_no_dot_segments CHECK does', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await expect(
        a.reserve('docs/../x.bin', {
          objectId: crypto.randomUUID(),
          ownerPrincipalId: ownerA,
          sizeBytes: 1,
          contentType: null,
        }),
      ).rejects.toMatchObject(checkViolation('files_path_no_dot_segments'));
      await expect(a.get('docs', { includePending: true })).resolves.toBeNull();
    });

    it('refuses a negative size as the files_size_non_negative CHECK does', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await expect(
        a.reserve('neg.bin', {
          objectId: crypto.randomUUID(),
          ownerPrincipalId: ownerA,
          sizeBytes: -1,
          contentType: null,
        }),
      ).rejects.toMatchObject(checkViolation('files_size_non_negative'));
      await expect(a.get('neg.bin', { includePending: true })).resolves.toBeNull();
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] rename refuses a pending row and leaves it in place', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await a.reserve('big.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 5,
        contentType: null,
      });
      await expect(a.rename('big.bin', 'moved.bin')).rejects.toBeInstanceOf(
        CatalogPathPendingError,
      );
      await expect(a.get('big.bin', { includePending: true })).resolves.toMatchObject({
        status: 'pending',
      });
      await expect(a.get('moved.bin', { includePending: true })).resolves.toBeNull();
    });

    it('creates the parent folders of a reserved path, ready and owned by its owner', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await a.reserve('docs/deep/big.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 5,
        contentType: null,
      });
      for (const path of ['docs', 'docs/deep']) {
        await expect(a.get(path)).resolves.toMatchObject({
          kind: 'folder',
          status: 'ready',
          ownerPrincipalId: ownerA,
        });
      }
    });

    it('[US-STO-01][contract][sdk] createFolder adds a ready folder row with its parents and no object', async () => {
      const { catalog, ownerA, actorA } = await makeFixture();
      const a = catalog('a');
      const made = await a.createFolder('docs/deep', {
        ownerPrincipalId: ownerA,
        createdBy: actorA,
      });
      expect(made).toMatchObject({
        kind: 'created',
        row: {
          path: 'docs/deep',
          kind: 'folder',
          status: 'ready',
          storageKey: null,
          sizeBytes: 0,
          ownerPrincipalId: ownerA,
          createdBy: actorA,
        },
      });
      await expect(a.get('docs')).resolves.toMatchObject({ kind: 'folder', status: 'ready' });
      expect(paths((await a.list('')).rows)).toEqual(['docs', 'docs/deep']);

      const again = await a.createFolder('docs/deep', { ownerPrincipalId: ownerA });
      expect(again).toMatchObject({ kind: 'taken', row: { id: made.row.id } });
    });

    it('[US-STO-01][contract][sdk] createFolder over a file or a pending upload is taken and changes nothing', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const file = await upload(a, ownerA, 'docs/ready.txt');
      const held = await pending(a, ownerA, 'docs/pending.txt');

      await expect(
        a.createFolder('docs/ready.txt', { ownerPrincipalId: ownerA }),
      ).resolves.toMatchObject({ kind: 'taken', row: { id: file.id, kind: 'file' } });
      await expect(
        a.createFolder('docs/pending.txt', { ownerPrincipalId: ownerA }),
      ).resolves.toMatchObject({ kind: 'taken', row: { id: held.id, status: 'pending' } });
      await expect(a.get('docs/ready.txt')).resolves.toMatchObject({ id: file.id, kind: 'file' });
      await expect(a.createFolder(sidePath(file.id), { ownerPrincipalId: ownerA })).rejects.toThrow(
        'reserved catalog path',
      );
    });

    it('lists ready rows in path order, a page at a time, and clamps the page size', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      for (const name of ['f3', 'f1', 'f5', 'f2', 'f4']) await upload(a, ownerA, name);
      await a.reserve('f0', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 1,
        contentType: null,
      });

      const first = await a.list('', { limit: 2 });
      expect(paths(first.rows)).toEqual(['f1', 'f2']);
      expect(first.cursor).toBe('f2');
      const second = await a.list('', { cursor: 'f2', limit: 2 });
      expect(paths(second.rows)).toEqual(['f3', 'f4']);
      expect(second.cursor).toBe('f4');
      const last = await a.list('', { cursor: 'f4', limit: 2 });
      expect(paths(last.rows)).toEqual(['f5']);
      expect(last.cursor).toBeNull();

      expect(paths((await a.list('', { limit: 0 })).rows)).toEqual(['f1']);
      expect(paths((await a.list('', { limit: 100_000 })).rows)).toHaveLength(5);
    });

    it('pages in code-point order, as collate "C" does, not UTF-16 code-unit order', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await upload(a, ownerA, 'a\u{1F600}');
      await upload(a, ownerA, 'a\u{FF01}');
      const first = await a.list('', { limit: 1 });
      expect(paths(first.rows)).toEqual(['a\u{FF01}']);
      expect(first.cursor).toBe('a\u{FF01}');
      const second = await a.list('', { cursor: 'a\u{FF01}', limit: 1 });
      expect(paths(second.rows)).toEqual(['a\u{1F600}']);
    });

    it('lists only what is at or under the folder, never a sibling that shares its characters', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await upload(a, ownerA, 'docs/a.txt');
      await upload(a, ownerA, 'docs2/b.txt');
      expect(paths((await a.list('docs')).rows)).toEqual(['docs', 'docs/a.txt']);
    });

    it('renames a subtree keeping ids and leaves docs2 alone when renaming docs', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const inside = await upload(a, ownerA, 'docs/sub/a.txt');
      const sibling = await upload(a, ownerA, 'docs2/b.txt');

      // docs, docs/sub and docs/sub/a.txt: three rows, one of them a file
      await expect(a.rename('docs', 'guides')).resolves.toEqual({ rows: 3, files: 1 });

      await expect(a.get('guides/sub/a.txt')).resolves.toMatchObject({
        id: inside.id,
        storageKey: inside.storageKey,
      });
      await expect(a.get('docs/sub/a.txt')).resolves.toBeNull();
      await expect(a.get('docs2/b.txt')).resolves.toMatchObject({ id: sibling.id });
      await expect(a.rename('nothing-here', 'elsewhere')).resolves.toEqual({ rows: 0, files: 0 });
    });

    it('rename writes the parent folders of the target', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const file = await upload(a, ownerA, 'plain.txt');
      await expect(a.rename('plain.txt', 'new/place/plain.txt')).resolves.toEqual({
        rows: 1,
        files: 1,
      });
      await expect(a.get('new/place')).resolves.toMatchObject({ kind: 'folder' });
      await expect(a.get('new/place/plain.txt')).resolves.toMatchObject({ id: file.id });
    });

    // @story US-STO-04
    it('[US-STO-04][contract][sdk] removing a folder marks every row under it deleting', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await upload(a, ownerA, 'docs/sub/a.txt');
      await a.reserve('docs/pending.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 1,
        contentType: null,
      });
      await upload(a, ownerA, 'docs2/b.txt');

      // The file rows come back deleting, moved aside with their old path in `targetPath`; the
      // folder rows (docs, docs/sub) have no object to clean up.
      const removed = await a.remove('docs');
      expect(removed.map((row) => [row.targetPath, row.status]).sort()).toEqual([
        ['docs/pending.bin', 'deleting'],
        ['docs/sub/a.txt', 'deleting'],
      ]);
      for (const row of removed) expect(row.path).toBe(sidePath(row.id));

      expect(paths((await a.list('')).rows)).toEqual(['docs2', 'docs2/b.txt']);
      for (const path of ['docs', 'docs/sub', 'docs/sub/a.txt', 'docs/pending.bin']) {
        await expect(a.get(path, { includePending: true })).resolves.toBeNull();
      }
      expect((await a.deleting()).map((row) => row.targetPath).sort()).toEqual([
        'docs/pending.bin',
        'docs/sub/a.txt',
      ]);
      await expect(a.remove('docs')).resolves.toEqual([]);
    });

    // @story US-STO-04
    it('[US-STO-04][contract][sdk] remove marks a file deleting and get and list stop showing it', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const file = await upload(a, ownerA, 'one.txt');
      await upload(a, ownerA, 'two.txt');

      const removed = await a.remove('one.txt');
      // Removing is a write, so only the write time may differ from the row that was uploaded.
      const written = removed[0]?.updatedAt;
      expect(written).toBeInstanceOf(Date);
      expect(removed).toEqual([
        {
          ...file,
          status: 'deleting',
          path: sidePath(file.id),
          targetPath: 'one.txt',
          updatedAt: written,
        },
      ]);
      await expect(a.get('one.txt')).resolves.toBeNull();
      await expect(a.get('one.txt', { includePending: true })).resolves.toBeNull();
      expect(paths((await a.list('')).rows)).toEqual(['two.txt']);
      await expect(a.deleting()).resolves.toEqual(removed);
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] confirm stores the checksum', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const sha256 = 'ab'.repeat(32);
      const reserved = await a.reserve('sum.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 1,
        contentType: null,
      });
      await expect(
        a.confirm(reserved.row, { sizeBytes: 1, contentType: null, sha256 }),
      ).resolves.toMatchObject({ row: { status: 'ready', sha256 } });
      await expect(a.get('sum.bin')).resolves.toMatchObject({ sha256 });
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] confirm of a removed row returns null and never revives it', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const reserved = await a.reserve('gone.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 1,
        contentType: null,
      });
      await a.remove('gone.bin');
      await expect(
        a.confirm(reserved.row, { sizeBytes: 1, contentType: null }),
      ).resolves.toBeNull();
      await expect(a.get('gone.bin', { includePending: true })).resolves.toBeNull();
      await expect(a.deleting()).resolves.toHaveLength(1);
    });

    // @story US-STO-04
    it('[US-STO-04][contract][sdk] a removed path is free at once: reserve wins', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const input = { ownerPrincipalId: ownerA, sizeBytes: 1, contentType: null };
      const reserved = await a.reserve('gone.bin', { ...input, objectId: crypto.randomUUID() });
      await a.remove('gone.bin');
      const again = await a.reserve('gone.bin', { ...input, objectId: crypto.randomUUID() });
      expect(again).toMatchObject({
        kind: 'reserved',
        row: { path: 'gone.bin', status: 'pending' },
      });
      expect(again.row.id).not.toBe(reserved.row.id);
      await expect(a.deleting()).resolves.toHaveLength(1);
    });

    // @story US-STO-04
    it('[US-STO-04][contract][sdk] stalePending returns only pending rows reserved before the cut-off', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await upload(a, ownerA, 'ready.bin');
      const pending = await a.reserve('pending.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 1,
        contentType: null,
      });
      const minute = 60_000;

      await expect(a.stalePending(new Date(Date.now() - minute))).resolves.toEqual([]);
      await expect(a.stalePending(new Date(Date.now() + minute))).resolves.toEqual([pending.row]);
    });

    // @story US-STO-04
    it('[US-STO-04][contract][sdk] a re-reserve refreshes the time stalePending compares', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      // A signed re-mint is what refreshes it; an unchanged retry with no mode keeps its snapshot.
      const input = {
        ownerPrincipalId: ownerA,
        sizeBytes: 5,
        contentType: null,
        objectId: crypto.randomUUID(),
        uploadMode: 'signed',
      } as const;
      const first = await a.reserve('again.bin', input);
      if (first.kind !== 'reserved') throw new Error('again.bin was already taken');
      const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
      await pause();
      const cut = new Date();
      await pause();

      await expect(a.stalePending(cut)).resolves.toEqual([first.row]);
      await expect(a.reserve('again.bin', input)).resolves.toMatchObject({ kind: 'taken' });
      await expect(a.stalePending(cut)).resolves.toEqual([]);
    });

    // @story US-STO-04
    it('[US-STO-04][contract][sdk] a fresh reservation is not stale through another handle', async () => {
      const { catalog, ownerA } = await makeFixture();
      const pending = await catalog('a').reserve('pending.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 1,
        contentType: null,
      });
      const minute = 60_000;

      await expect(catalog('a').stalePending(new Date(Date.now() - minute))).resolves.toEqual([]);
      await expect(catalog('a').stalePending(new Date(Date.now() + minute))).resolves.toEqual([
        pending.row,
      ]);
    });

    // @story US-STO-04
    it('[US-STO-04][contract][sdk] forget is idempotent and never deletes a ready row', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const ready = await upload(a, ownerA, 'keep.bin');
      await upload(a, ownerA, 'doomed.bin');
      const removed = await a.remove('doomed.bin');
      expect(removed).toHaveLength(1);

      await a.forget(ready);
      await expect(a.get('keep.bin')).resolves.toMatchObject({ id: ready.id });

      for (const row of [...removed, ...removed]) await a.forget(row);
      await expect(a.deleting()).resolves.toEqual([]);
      const again = await a.reserve('doomed.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 1,
        contentType: null,
      });
      expect(again.kind).toBe('reserved');
    });

    // @story US-STO-04
    it('[US-STO-04][contract][sdk] a second workspace cannot remove, list deleting or forget the first one', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const b = catalog('b');
      await upload(a, ownerA, 'private.bin');
      const removed = await a.remove('private.bin');

      await expect(b.remove('private.bin')).resolves.toEqual([]);
      await expect(b.deleting()).resolves.toEqual([]);
      await expect(b.stalePending(new Date(Date.now() + 60_000))).resolves.toEqual([]);
      for (const row of removed) await b.forget(row);
      await expect(a.deleting()).resolves.toHaveLength(1);
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] referencing finds rows in every status by object id', async () => {
      const { catalog, ownerA, ownerB } = await makeFixture();
      const a = catalog('a');
      const ready = await upload(a, ownerA, 'ready.bin');
      await upload(a, ownerA, 'gone.bin');
      const [gone] = await a.remove('gone.bin');
      const stillPending = await pending(a, ownerA, 'pending.bin');
      const replacement = await replace(a, ownerA, 'ready.bin');
      if (replacement.kind !== 'reserved') throw new Error('the replacement was not reserved');
      expect(replacement.row.path).not.toBe('ready.bin');
      const elsewhere = await upload(catalog('b'), ownerB, 'ready.bin');
      const idsOf = (rows: readonly (CatalogFile | undefined)[]) =>
        rows.map((row) => row?.objectId ?? '');

      const found = await a.referencing({
        objectIds: [
          ...idsOf([ready, gone, stillPending, replacement.row, elsewhere]),
          crypto.randomUUID(),
        ],
      });

      expect(found.map((row) => row.id).sort()).toEqual(
        [ready.id, gone?.id, stillPending.id, replacement.row.id].sort(),
      );
      await expect(a.referencing({ objectIds: [] })).resolves.toEqual([]);
      await expect(catalog('b').referencing({ objectIds: idsOf([ready, gone]) })).resolves.toEqual(
        [],
      );
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] rename of a new-style row keeps its storage key and object id', async () => {
      const { catalog, seed } = await makeFixture();
      const a = catalog('a');
      const objectId = crypto.randomUUID();
      await seed('a', { path: 'old/new-style.bin', status: 'ready', objectId });
      const before = await a.get('old/new-style.bin');

      await expect(a.rename('old', 'moved')).resolves.toEqual({ rows: 1, files: 1 });
      await expect(a.get('moved/new-style.bin')).resolves.toMatchObject({
        id: before?.id,
        objectId,
        storageKey: before?.storageKey,
      });
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] confirming a replacement leaves exactly one ready row and marks the old one deleting', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const old = await upload(a, ownerA, 'r.bin', 1);
      const reserved = await replace(a, ownerA, 'r.bin');
      expect(reserved.kind).toBe('reserved');

      const done = await a.confirm(reserved.row, {
        sizeBytes: 2,
        contentType: 'text/plain',
        sha256: 'cd'.repeat(32),
      });
      expect(done).toMatchObject({
        row: {
          id: reserved.row.id,
          path: 'r.bin',
          status: 'ready',
          sizeBytes: 2,
          targetPath: null,
        },
        replaced: { id: old.id, status: 'deleting', targetPath: 'r.bin' },
      });
      expect((await a.list('')).rows.filter((row) => row.path === 'r.bin')).toEqual([done?.row]);
      await expect(a.deleting()).resolves.toEqual([done?.replaced]);
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] a replacement is pending beside the ready row; get and list still show the old row', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const old = await upload(a, ownerA, 'r.bin');
      const reserved = await replace(a, ownerA, 'r.bin');

      expect(reserved).toMatchObject({
        kind: 'reserved',
        row: { status: 'pending', targetPath: 'r.bin' },
      });
      expect(reserved.row.path).toBe(sidePath(reserved.row.id));
      await expect(a.get('r.bin')).resolves.toMatchObject({ id: old.id });
      await expect(a.get('r.bin', { includePending: true })).resolves.toMatchObject({ id: old.id });
      expect((await a.list('')).rows.map((row) => row.id)).toEqual([old.id]);
      await expect(a.countPending()).resolves.toBe(1);
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] a second pending replacement of one path is taken', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await upload(a, ownerA, 'r.bin');
      const first = await replace(a, ownerA, 'r.bin');
      const second = await replace(a, ownerA, 'r.bin');
      expect(second).toMatchObject({ kind: 'taken', row: { id: first.row.id, status: 'pending' } });
      await expect(a.countPending()).resolves.toBe(1);
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] a reserve with an object id on a free path stores the object id and key', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const objectId = crypto.randomUUID();
      const reserved = await a.reserve('new/free.bin', {
        ownerPrincipalId: ownerA,
        sizeBytes: 1,
        contentType: null,
        objectId,
        area: 'files',
      });
      expect(reserved).toMatchObject({
        kind: 'reserved',
        row: { path: 'new/free.bin', objectId, area: 'files', storageKey: `files/${objectId}` },
      });
      expect(reserved.row.targetPath ?? null).toBeNull();
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] confirm with an object id publishes that object and keeps the row id', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const ingress = crypto.randomUUID();
      const published = crypto.randomUUID();
      const input = { ownerPrincipalId: ownerA, sizeBytes: 1, contentType: null };
      const reserved = await a.reserve('up.bin', { ...input, objectId: ingress });
      const used = crypto.randomUUID();
      await a.reserve('other.bin', { ...input, objectId: used });

      await expect(
        a.confirm(reserved.row, { sizeBytes: 1, contentType: null, objectId: used }),
      ).rejects.toThrow();
      const done = await a.confirm(reserved.row, {
        sizeBytes: 1,
        contentType: null,
        objectId: published,
      });
      expect(done?.row).toMatchObject({
        id: reserved.row.id,
        status: 'ready',
        objectId: published,
        storageKey: `files/${published}`,
      });
      await expect(a.get('up.bin')).resolves.toMatchObject({ objectId: published });
      await expect(a.referencing({ objectIds: [ingress] })).resolves.toEqual([]);
      // The reservation's snapshot names the ingress object, so it confirms nothing again.
      await expect(
        a.confirm(reserved.row, { sizeBytes: 1, contentType: null, objectId: ingress }),
      ).resolves.toBeNull();
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] a reserve with an object id already in use is refused', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const objectId = crypto.randomUUID();
      const input = { ownerPrincipalId: ownerA, sizeBytes: 1, contentType: null, objectId };
      await a.reserve('used.bin', input);
      await upload(a, ownerA, 'r.bin');
      for (const path of ['free.bin', 'r.bin']) {
        await expect(a.reserve(path, input)).rejects.toThrow('files_workspace_object_key');
      }
      await expect(a.countPending()).resolves.toBe(1);
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] confirm of a forgotten replacement returns null and keeps the ready row', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const old = await upload(a, ownerA, 'r.bin');
      const reserved = await replace(a, ownerA, 'r.bin');
      await a.forget(reserved.row);

      await expect(
        a.confirm(reserved.row, { sizeBytes: 2, contentType: null }),
      ).resolves.toBeNull();
      await expect(a.get('r.bin')).resolves.toMatchObject({ id: old.id, status: 'ready' });
      await expect(a.deleting()).resolves.toEqual([]);
      expect((await replace(a, ownerA, 'r.bin')).kind).toBe('reserved');
    });

    // @story US-STO-04
    it('[US-STO-04][contract][sdk] removing a file also marks its pending replacement deleting', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const old = await upload(a, ownerA, 'r.bin');
      const reserved = await replace(a, ownerA, 'r.bin');

      const removed = await a.remove('r.bin');
      expect(removed.map((row) => row.id).sort()).toEqual([old.id, reserved.row.id].sort());
      expect(removed.every((row) => row.status === 'deleting' && row.targetPath === 'r.bin')).toBe(
        true,
      );
      await expect(a.get('r.bin', { includePending: true })).resolves.toBeNull();
      await expect(a.countPending()).resolves.toBe(0);
      await expect(
        a.confirm(reserved.row, { sizeBytes: 2, contentType: null }),
      ).resolves.toBeNull();
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] a folder move refuses while a file under it has a pending replacement', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const old = await upload(a, ownerA, 'docs/r.bin');
      const reserved = await replace(a, ownerA, 'docs/r.bin');

      await expect(a.rename('docs', 'guides')).rejects.toBeInstanceOf(CatalogPathPendingError);
      await expect(a.get('docs/r.bin')).resolves.toMatchObject({ id: old.id });
      await expect(a.get('guides/r.bin')).resolves.toBeNull();
      const done = await a.confirm(reserved.row, { sizeBytes: 2, contentType: null });
      expect(done).toMatchObject({
        row: { id: reserved.row.id, path: 'docs/r.bin', status: 'ready' },
        replaced: { id: old.id, targetPath: 'docs/r.bin' },
      });
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] rename onto a taken logical path is refused and moves nothing', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const from = await upload(a, ownerA, 'from.bin');
      const to = await upload(a, ownerA, 'to.bin');

      await expect(a.rename('from.bin', 'to.bin')).rejects.toBeInstanceOf(CatalogPathTakenError);
      await expect(a.get('from.bin')).resolves.toMatchObject({ id: from.id });
      await expect(a.get('to.bin')).resolves.toMatchObject({ id: to.id });
      await expect(a.rename('from.bin', 'to.bin')).rejects.toBeInstanceOf(CatalogPathTakenError);
      await expect(a.get('from.bin')).resolves.toMatchObject({ id: from.id });
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] a side path is never returned by get or list and cannot be written', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await upload(a, ownerA, 'r.bin');
      const reserved = await replace(a, ownerA, 'r.bin');

      await expect(a.get(reserved.row.path)).resolves.toBeNull();
      await expect(a.get(reserved.row.path, { includePending: true })).resolves.toBeNull();
      expect((await a.list('')).rows.every((row) => row.path !== reserved.row.path)).toBe(true);
      await expect(
        a.reserve(sidePath(crypto.randomUUID()), {
          objectId: crypto.randomUUID(),
          ownerPrincipalId: ownerA,
          sizeBytes: 1,
          contentType: null,
        }),
      ).rejects.toThrow();
      await expect(a.rename('r.bin', sidePath(crypto.randomUUID()))).rejects.toThrow();
    });

    const signed = (catalog: CatalogPort, owner: string, path: string, objectId: string) =>
      catalog.reserve(path, {
        ownerPrincipalId: owner,
        sizeBytes: 5,
        contentType: null,
        objectId,
        uploadMode: 'signed',
      });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] a re-mint of the same size makes the earlier snapshot stale for confirm and forget', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const objectId = crypto.randomUUID();
      const first = await signed(a, ownerA, 'mint.bin', objectId);
      const again = await signed(a, ownerA, 'mint.bin', objectId);
      expect(again).toMatchObject({ kind: 'taken', row: { id: first.row.id } });
      expect(first.row.reservationToken).toEqual(expect.any(String));
      expect(again.row.reservationToken).toEqual(expect.any(String));
      expect(again.row.reservationToken).not.toBe(first.row.reservationToken);

      await expect(a.confirm(first.row, { sizeBytes: 5, contentType: null })).resolves.toBeNull();
      await a.forget(first.row);
      await expect(a.pending('mint.bin')).resolves.toMatchObject({
        id: first.row.id,
        reservationToken: again.row.reservationToken,
      });
      await expect(
        a.confirm(again.row, { sizeBytes: 5, contentType: null }),
      ).resolves.toMatchObject({ row: { id: first.row.id, status: 'ready' } });
    });

    // @story US-STO-04
    it('[US-STO-04][contract][sdk] remove with a pending snapshot claims only that unchanged reservation', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const objectId = crypto.randomUUID();
      const first = await signed(a, ownerA, 'claim.bin', objectId);
      const again = await signed(a, ownerA, 'claim.bin', objectId);

      await expect(a.remove('claim.bin', { pending: first.row })).resolves.toEqual([]);
      await expect(a.pending('claim.bin')).resolves.toMatchObject({ id: first.row.id });

      const claimed = await a.remove('claim.bin', { pending: again.row });
      expect(claimed).toMatchObject([
        { id: first.row.id, status: 'deleting', targetPath: 'claim.bin', reservationToken: null },
      ]);
      await expect(a.pending('claim.bin')).resolves.toBeNull();
      await expect(a.confirm(again.row, { sizeBytes: 5, contentType: null })).resolves.toBeNull();
      for (const row of claimed) await a.forget(row);
      await expect(a.deleting()).resolves.toEqual([]);
    });

    // @story US-STO-04
    it('[US-STO-04][contract][sdk] remove with a pending snapshot never claims a ready file or another path', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const reserved = await signed(a, ownerA, 'done.bin', crypto.randomUUID());
      const other = await pending(a, ownerA, 'other.bin');
      await a.confirm(reserved.row, { sizeBytes: 5, contentType: null });

      await expect(a.remove('done.bin', { pending: reserved.row })).resolves.toEqual([]);
      await expect(a.remove('done.bin', { pending: other })).resolves.toEqual([]);
      await expect(a.get('done.bin')).resolves.toMatchObject({ id: reserved.row.id });
      await expect(a.pending('other.bin')).resolves.toMatchObject({ id: other.id });
      await expect(a.deleting()).resolves.toEqual([]);
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] a duplicate relay reserve is refused without refreshing the winner', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const input = {
        ownerPrincipalId: ownerA,
        sizeBytes: 0,
        contentType: null,
        uploadMode: 'relay',
      } as const;
      const first = await a.reserve('relay.bin', { ...input, objectId: crypto.randomUUID() });
      const again = await a.reserve('relay.bin', { ...input, objectId: crypto.randomUUID() });

      expect(again).toMatchObject({ kind: 'taken', row: { id: first.row.id } });
      expect(first.row.reservationToken).toEqual(expect.any(String));
      expect(again.row.reservationToken).toBe(first.row.reservationToken);
      await expect(
        a.confirm(first.row, { sizeBytes: 3, contentType: null }),
      ).resolves.toMatchObject({ row: { status: 'ready', sizeBytes: 3 } });
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] an unchanged retry without an upload mode keeps the snapshot; a changed one does not', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const input = {
        ownerPrincipalId: ownerA,
        sizeBytes: 5,
        contentType: null,
        objectId: crypto.randomUUID(),
      };
      const first = await a.reserve('retried.bin', input);
      const same = await a.reserve('retried.bin', input);
      expect(same.row.reservationToken).toBe(first.row.reservationToken);

      const resized = await a.reserve('retried.bin', { ...input, sizeBytes: 6 });
      expect(resized.row.reservationToken).not.toBe(first.row.reservationToken);
      await expect(a.confirm(first.row, { sizeBytes: 5, contentType: null })).resolves.toBeNull();
      await expect(
        a.confirm(resized.row, { sizeBytes: 6, contentType: null }),
      ).resolves.toMatchObject({ row: { status: 'ready' } });
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] a ready or removed row carries no reservation token', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const ready = await upload(a, ownerA, 'ready.bin');
      expect(ready.reservationToken ?? null).toBeNull();
      // Re-confirming a ready row with `expect: 'any'` still goes by id and key, not a spent token.
      await expect(
        a.confirm(ready, { sizeBytes: 2, contentType: null, expect: 'any' }),
      ).resolves.toMatchObject({ row: { id: ready.id, sizeBytes: 2 } });
      const [removed] = await a.remove('ready.bin');
      expect(removed?.reservationToken ?? null).toBeNull();
    });

    // @story US-STO-14
    it('[US-STO-14][contract][sdk] a replacement reserve names the ready file it replaces; a fresh one names none', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const old = await upload(a, ownerA, 'swap.bin');
      const objectId = crypto.randomUUID();

      const first = await signed(a, ownerA, 'swap.bin', objectId);
      expect(first).toMatchObject({
        kind: 'reserved',
        row: { targetPath: 'swap.bin' },
        replaces: { id: old.id, ownerPrincipalId: ownerA, status: 'ready' },
      });
      const again = await signed(a, ownerA, 'swap.bin', objectId);
      expect(again).toMatchObject({ kind: 'taken', replaces: { id: old.id } });

      const fresh = await signed(a, ownerA, 'new.bin', crypto.randomUUID());
      expect(fresh.kind).toBe('reserved');
      expect(fresh.replaces).toBeUndefined();
    });

    it('never shows workspace A to workspace B, and B can reserve the same path', async () => {
      const { catalog, ownerA, ownerB } = await makeFixture();
      const a = catalog('a');
      const b = catalog('b');
      const fileA = await upload(a, ownerA, 'shared/same.txt');
      const pendingA = await a.reserve('pending.bin', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerA,
        sizeBytes: 1,
        contentType: null,
      });

      await expect(b.get('shared/same.txt')).resolves.toBeNull();
      await expect(b.get('pending.bin', { includePending: true })).resolves.toBeNull();
      expect((await b.list('')).rows).toEqual([]);
      await expect(
        b.confirm(pendingA.row, { sizeBytes: 1, contentType: null }),
      ).resolves.toBeNull();
      await expect(b.rename('shared', 'taken')).resolves.toEqual({ rows: 0, files: 0 });
      await expect(b.remove('shared')).resolves.toEqual([]);

      const reservedInB = await b.reserve('shared/same.txt', {
        objectId: crypto.randomUUID(),
        ownerPrincipalId: ownerB,
        sizeBytes: 2,
        contentType: null,
      });
      expect(reservedInB).toMatchObject({ kind: 'reserved', row: { ownerPrincipalId: ownerB } });
      expect(reservedInB.row.id).not.toBe(fileA.id);
      await expect(a.get('shared/same.txt')).resolves.toMatchObject({ id: fileA.id });
      await expect(a.get('pending.bin', { includePending: true })).resolves.toMatchObject({
        status: 'pending',
      });
    });
  });
}

export interface SkillCatalogConformanceFixture {
  readonly catalog: (workspace: 'a' | 'b') => ResourceCatalogRepository;
  readonly ownerA: string;
  readonly ownerB: string;
  /** A member of workspace `'a'`, valid as a skill's `createdBy`. */
  readonly actorA: string;
  /** Assign `skill` to a new agent in `workspace`, the way an agent version does; returns the agent id. */
  readonly assign: (workspace: 'a' | 'b', skill: CatalogSkill) => Promise<string>;
  /** Remove the assignment `assign` made, as an agent version dropping the skill does. */
  readonly unassign: (workspace: 'a' | 'b', skill: CatalogSkill, agentId: string) => Promise<void>;
  /** Date the pending revisions of the skill named `name` in `'a'` past the stale window. */
  readonly ageRevisions: (name: string) => Promise<void>;
}

/**
 * The skill half of the catalog contract (the storage design, §03): skills and their revisions
 * follow the PostgreSQL rules in memory too. `makeFixture` runs once per test.
 */
export function describeSkillCatalogConformance(
  label: string,
  makeFixture: () => Promise<SkillCatalogConformanceFixture>,
): void {
  describe(`skill catalog conformance: ${label}`, () => {
    const noWrite = () => Promise.resolve(undefined);
    const skillCheckViolation = (constraint: string) => ({ cause: { code: '23514', constraint } });
    type SkillWrite = ReturnType<typeof skillInput>;
    const skillInput = (name: string, ownerPrincipalId: string) => ({
      name,
      skillMd: `# ${name}`,
      enabled: true,
      ownerPrincipalId,
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] listSkills returns put skills ordered by name', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await expect(a.listSkills()).resolves.toEqual([]);
      const zeta = await a.putSkill(skillInput('zeta', ownerA));
      const alpha = await a.putSkill(skillInput('alpha', ownerA));
      await expect(a.listSkills()).resolves.toEqual([alpha, zeta]);
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] listSkills orders names by code point, a hyphen before a digit or letter', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      for (const name of ['ab', 'a-c', 'a0']) await a.putSkill(skillInput(name, ownerA));
      const names = (await a.listSkills()).map((skill) => skill.name);
      expect(names).toEqual(['a-c', 'a0', 'ab']);
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] putSkill and createSkill refuse a bad name or a blank SKILL.md', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const writes = [
        (input: SkillWrite) => a.putSkill(input),
        (input: SkillWrite) => a.createSkill(input),
      ];
      for (const write of writes) {
        await expect(write(skillInput('Not_A_Name', ownerA))).rejects.toMatchObject(
          skillCheckViolation('skills_name_shape'),
        );
        await expect(
          write({ ...skillInput('blank', ownerA), skillMd: '   ' }),
        ).rejects.toMatchObject(skillCheckViolation('skills_skill_md_not_blank'));
      }
      await expect(a.listSkills()).resolves.toEqual([]);
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] getSkill reads one skill by name, in its workspace only', async () => {
      const { catalog, ownerA } = await makeFixture();
      const alpha = await catalog('a').putSkill(skillInput('alpha', ownerA));
      await expect(catalog('a').getSkill('alpha')).resolves.toEqual(alpha);
      await expect(catalog('a').getSkill('zeta')).resolves.toBeNull();
      await expect(catalog('b').getSkill('alpha')).resolves.toBeNull();
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] putSkill upserts by name and never transfers id or owner', async () => {
      const { catalog, ownerA, ownerB } = await makeFixture();
      const a = catalog('a');
      const first = await a.putSkill(skillInput('reviewer', ownerA));
      const second = await a.putSkill({
        ...skillInput('reviewer', ownerB),
        skillMd: '# changed',
        enabled: false,
      });
      expect(second).toEqual({ ...first, skillMd: '# changed', enabled: false });
      await expect(a.listSkills()).resolves.toEqual([second]);
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] createSkill inserts once; a second create of the name returns null and changes nothing', async () => {
      const { catalog, ownerA, ownerB } = await makeFixture();
      const a = catalog('a');
      const created = await a.createSkill(skillInput('reviewer', ownerA));
      expect(created).toMatchObject({
        name: 'reviewer',
        skillMd: '# reviewer',
        ownerPrincipalId: ownerA,
      });

      await expect(
        a.createSkill({ ...skillInput('reviewer', ownerB), skillMd: '# other', enabled: false }),
      ).resolves.toBeNull();
      await expect(a.listSkills()).resolves.toEqual([created]);
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] putSkill over a created skill keeps its id and owner', async () => {
      const { catalog, ownerA, ownerB } = await makeFixture();
      const a = catalog('a');
      const created = await a.createSkill(skillInput('reviewer', ownerA));
      const updated = await a.putSkill({ ...skillInput('reviewer', ownerB), skillMd: '# changed' });
      expect(updated).toEqual({ ...created, skillMd: '# changed' });
    });

    it('putSkill over a skill with no creator keeps createdBy null', async () => {
      const { catalog, ownerA, actorA } = await makeFixture();
      const a = catalog('a');
      await a.putSkill(skillInput('reviewer', ownerA));
      const again = await a.putSkill({ ...skillInput('reviewer', ownerA), createdBy: actorA });
      expect(again.createdBy).toBeNull();
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] deleteSkill of an unknown name is not-found', async () => {
      const { catalog } = await makeFixture();
      await expect(catalog('a').deleteSkill('missing')).resolves.toEqual({ kind: 'not-found' });
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] deleteSkill refuses an assigned skill naming its agents, then deletes', async () => {
      const { catalog, ownerA, assign, unassign } = await makeFixture();
      const a = catalog('a');
      const assigned = await a.putSkill(skillInput('assigned', ownerA));
      const free = await a.putSkill(skillInput('free', ownerA));
      const agentId = await assign('a', assigned);

      await expect(a.deleteSkill('assigned')).resolves.toEqual({
        kind: 'in-use',
        agentIds: [agentId],
      });
      await expect(a.listSkills()).resolves.toEqual([assigned, free]);

      // Another workspace naming the same skill finds nothing and deletes nothing.
      await expect(catalog('b').deleteSkill('assigned')).resolves.toEqual({ kind: 'not-found' });

      await expect(a.deleteSkill('free')).resolves.toEqual({ kind: 'deleted', skill: free });
      await expect(a.deleteSkill('free')).resolves.toEqual({ kind: 'not-found' });
      await expect(a.listSkills()).resolves.toEqual([assigned]);

      // Once no agent uses it, the refused delete succeeds.
      await unassign('a', assigned, agentId);
      await expect(a.deleteSkill('assigned')).resolves.toEqual({
        kind: 'deleted',
        skill: assigned,
      });
      await expect(a.listSkills()).resolves.toEqual([]);
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] deleteSkill with an id leaves a later row of the name alone', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      const first = await a.putSkill(skillInput('reused', ownerA));
      await a.deleteSkill('reused');
      const second = await a.putSkill(skillInput('reused', ownerA));

      await expect(a.deleteSkill('reused', first.id)).resolves.toEqual({ kind: 'not-found' });
      await expect(a.listSkills()).resolves.toEqual([second]);
      await expect(a.deleteSkill('reused', second.id)).resolves.toEqual({
        kind: 'deleted',
        skill: second,
      });
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] revisions number 1, 2, 3 per skill and list newest first', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await a.putSkill(skillInput('numbered', ownerA));
      await a.putSkill(skillInput('numbered-other', ownerA));
      const written: number[] = [];
      const write = (number: number) => {
        written.push(number);
        return Promise.resolve(undefined);
      };

      const first = await a.publishSkillRevision('numbered', { fileCount: 1, write });
      const second = await a.publishSkillRevision('numbered', { fileCount: 3, write });
      const third = await a.publishSkillRevision('numbered', { fileCount: 2, write });
      const other = await a.publishSkillRevision('numbered-other', {
        fileCount: 1,
        write: noWrite,
      });

      expect([first?.number, second?.number, third?.number, other?.number]).toEqual([1, 2, 3, 1]);
      expect(written).toEqual([1, 2, 3]);
      const revisions = await a.listSkillRevisions('numbered');
      expect(revisions.map((r) => [r.number, r.fileCount])).toEqual([
        [3, 2],
        [2, 3],
        [1, 1],
      ]);
      expect(revisions[0]?.publishedAt).toBeInstanceOf(Date);
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] a throwing write records nothing and the number is reused', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await a.putSkill(skillInput('flaky', ownerA));
      await expect(
        a.publishSkillRevision('flaky', {
          fileCount: 1,
          write: () => Promise.reject(new Error('store down')),
        }),
      ).rejects.toThrow('store down');
      await expect(a.listSkillRevisions('flaky')).resolves.toEqual([]);
      await expect(
        a.publishSkillRevision('flaky', { fileCount: 1, write: noWrite }),
      ).resolves.toMatchObject({ number: 1 });
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] a stale revision number is never reused and completing it changes nothing', async () => {
      const { catalog, ownerA, ageRevisions } = await makeFixture();
      const a = catalog('a');
      await a.putSkill(skillInput('stale', ownerA));
      let started!: () => void;
      const writing = new Promise<void>((resolve) => (started = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const slow = a.publishSkillRevision('stale', {
        fileCount: 1,
        write: async () => {
          started();
          await released;
          return { skillMd: '# abandoned', enabled: false };
        },
      });
      await writing;
      await ageRevisions('stale');

      const abandonedSeen: (readonly number[])[] = [];
      const next = await a.publishSkillRevision('stale', {
        fileCount: 2,
        write: (_number, abandoned) => {
          abandonedSeen.push(abandoned);
          return Promise.resolve(undefined);
        },
      });
      expect(next?.number).toBe(2);
      expect(abandonedSeen).toEqual([[1]]);

      release();
      await expect(slow).resolves.toBeNull();
      expect((await a.listSkillRevisions('stale')).map((r) => [r.number, r.fileCount])).toEqual([
        [2, 2],
      ]);
      await expect(a.listSkills()).resolves.toMatchObject([
        { name: 'stale', skillMd: '# stale', enabled: true },
      ]);
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] a revision is not listed until its write completes', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await a.putSkill(skillInput('pending', ownerA));
      const listedDuringWrite: number[][] = [];
      const revision = await a.publishSkillRevision('pending', {
        fileCount: 1,
        write: async () => {
          listedDuringWrite.push((await a.listSkillRevisions('pending')).map((r) => r.number));
          listedDuringWrite.push(
            (await a.listSkillRevisions('pending', { includePending: true })).map((r) => r.number),
          );
          return undefined;
        },
      });
      expect(listedDuringWrite).toEqual([[], [1]]);
      expect(revision?.number).toBe(1);
      expect((await a.listSkillRevisions('pending')).map((r) => r.number)).toEqual([1]);
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] the content a write returns is stamped on the skill row', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await a.putSkill(skillInput('stamped', ownerA));
      await a.publishSkillRevision('stamped', {
        fileCount: 1,
        write: () => Promise.resolve({ skillMd: '# published', enabled: false }),
      });
      await expect(a.listSkills()).resolves.toMatchObject([
        { name: 'stamped', skillMd: '# published', enabled: false },
      ]);
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] concurrent publishes of one skill get distinct numbers', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await a.putSkill(skillInput('concurrent', ownerA));
      const published = await Promise.all(
        Array.from({ length: 5 }, () =>
          a.publishSkillRevision('concurrent', { fileCount: 1, write: noWrite }),
        ),
      );
      expect(published.map((r) => r?.number).sort()).toEqual([1, 2, 3, 4, 5]);
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] an unknown skill publishes nothing and has no revisions', async () => {
      const { catalog } = await makeFixture();
      const a = catalog('a');
      await expect(
        a.publishSkillRevision('missing', { fileCount: 1, write: noWrite }),
      ).resolves.toBeNull();
      await expect(a.listSkillRevisions('missing')).resolves.toEqual([]);
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] revisions leave with their skill, so a recreated skill restarts at 1', async () => {
      const { catalog, ownerA } = await makeFixture();
      const a = catalog('a');
      await a.putSkill(skillInput('recreated', ownerA));
      await a.publishSkillRevision('recreated', { fileCount: 1, write: noWrite });
      await a.publishSkillRevision('recreated', { fileCount: 1, write: noWrite });
      await expect(a.deleteSkill('recreated')).resolves.toMatchObject({ kind: 'deleted' });
      await expect(a.listSkillRevisions('recreated')).resolves.toEqual([]);

      await a.putSkill(skillInput('recreated', ownerA));
      await expect(
        a.publishSkillRevision('recreated', { fileCount: 1, write: noWrite }),
      ).resolves.toMatchObject({ number: 1 });
    });

    // @story US-STO-08
    it('[US-STO-08][contract][sdk] another workspace cannot list, delete or publish to a skill', async () => {
      const { catalog, ownerA, ownerB } = await makeFixture();
      const a = catalog('a');
      const b = catalog('b');
      const skill = await a.putSkill(skillInput('private', ownerA));
      await a.publishSkillRevision('private', { fileCount: 1, write: noWrite });

      await expect(b.listSkills()).resolves.toEqual([]);
      await expect(b.deleteSkill('private')).resolves.toEqual({ kind: 'not-found' });
      await expect(
        b.publishSkillRevision('private', { fileCount: 1, write: noWrite }),
      ).resolves.toBeNull();
      await expect(b.listSkillRevisions('private')).resolves.toEqual([]);

      const inB = await b.putSkill(skillInput('private', ownerB));
      expect(inB.id).not.toBe(skill.id);
      await expect(a.listSkills()).resolves.toEqual([skill]);
      expect(await a.listSkillRevisions('private')).toHaveLength(1);
    });
  });
}
