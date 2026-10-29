import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createInMemoryCatalog,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { createInMemoryObjectStore, storageObjectName } from '@agent-workspace/core/storage';

import {
  createStorageService,
  type SaveInput,
  type SaveResult,
  type StorageContext,
} from './service';
import type { CatalogFile, CatalogPort } from './store';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[storage/service.test.ts] the PostgreSQL catalog suite was SKIPPED — TEST_DATABASE_URL is not ' +
      'set, so the four-step save was NOT exercised against the database.',
  );
}

interface Fixture {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly otherPrincipalId: string;
  readonly userId: string | null;
  readonly catalog: CatalogPort;
}

function bodyOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** A body that stays open until `finish`, to hold a save between its steps. */
function heldBody(first: Uint8Array) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      c.enqueue(first);
    },
  });
  return { body, finish: (rest: Uint8Array) => (controller.enqueue(rest), controller.close()) };
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function memoryFixture(): Promise<Fixture> {
  const provider = createInMemoryCatalog();
  const workspaceId = crypto.randomUUID();
  return Promise.resolve({
    workspaceId,
    principalId: crypto.randomUUID(),
    otherPrincipalId: crypto.randomUUID(),
    userId: null,
    catalog: provider.forWorkspace(workspaceId),
  });
}

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  if (hasDatabase) isolated = await createIsolatedTestDatabase('aw_storage_service');
}, 180_000);

afterAll(async () => isolated?.close());

async function postgresFixture(): Promise<Fixture> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const workspaceId = crypto.randomUUID();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'storage' });
  const principal = async (): Promise<{ principalId: string; userId: string }> => {
    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Member' });
    await db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    return { principalId, userId };
  };
  const owner = await principal();
  const other = await principal();
  const scope = await createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(workspaceId);
  if (scope === null) throw new Error('catalog scope did not resolve');
  return {
    workspaceId,
    principalId: owner.principalId,
    otherPrincipalId: other.principalId,
    userId: owner.userId,
    catalog: createDatabaseResourceCatalogRepositoryProvider(db).forScope(scope),
  };
}

function defineSuite(enabled: boolean, name: string, setup: () => Promise<Fixture>) {
  (enabled ? describe : describe.skip)(`save on the ${name}`, () => {
    async function harness(wrap: (catalog: CatalogPort) => CatalogPort = (catalog) => catalog) {
      const f = await setup();
      const objects = createInMemoryObjectStore();
      const log = { info() {}, warn() {}, error() {}, child: () => log };
      const storage = createStorageService({
        catalog: () => Promise.resolve(wrap(f.catalog)),
        objects,
        log,
      });
      const ctx: StorageContext = {
        workspaceId: f.workspaceId,
        principalId: f.principalId,
        userId: f.userId,
      };
      const save = (input: Partial<SaveInput> & Pick<SaveInput, 'path' | 'body'>, as = ctx) =>
        storage.save(as, { area: 'files', maxBytes: 1024, replace: true, ...input });
      const objectKeys = async (): Promise<string[]> =>
        (await objects.listPage('workspaces', { recursive: true })).entries.map((e) => e.key);
      const nameOf = (objectId: string | null | undefined) =>
        storageObjectName(f.workspaceId, 'files', objectId ?? '');
      return { f, ctx, objects, save, objectKeys, nameOf };
    }
    const saved = (result: SaveResult) => {
      if (!result.ok) throw new Error(`save refused: ${result.code}`);
      return result.row;
    };

    // @story US-STO-01
    it('[US-STO-01][unit][sdk] a save leaves a ready row whose object has the measured size and SHA-256', async () => {
      const { save, objects, nameOf } = await harness();
      const bytes = bytesOf('quarterly numbers');

      const row = saved(
        await save({
          path: 'reports/q3.pdf',
          body: bodyOf(bytes.subarray(0, 5), bytes.subarray(5)),
        }),
      );

      expect(row).toMatchObject({
        status: 'ready',
        sizeBytes: bytes.byteLength,
        sha256: sha256Of(bytes),
        contentType: 'application/pdf',
      });
      await expect(objects.head(nameOf(row.objectId))).resolves.toMatchObject({
        sizeBytes: bytes.byteLength,
      });
    });

    // @story US-STO-01
    it('[US-STO-01][unit][sdk] an over-limit body leaves nothing behind', async () => {
      const { f, save, objectKeys } = await harness();

      const result = await save({
        path: 'big.bin',
        maxBytes: 25,
        body: bodyOf(new Uint8Array(10), new Uint8Array(10), new Uint8Array(10)),
      });

      expect(result).toEqual({ ok: false, code: 'too_large' });
      await expect(f.catalog.get('big.bin', { includePending: true })).resolves.toBeNull();
      await expect(f.catalog.countPending()).resolves.toBe(0);
      await expect(objectKeys()).resolves.toEqual([]);
    });

    // @story US-STO-01
    it('[US-STO-01][unit][sdk] a body of exactly maxBytes is saved', async () => {
      const { save } = await harness();
      const row = saved(
        await save({ path: 'edge.bin', maxBytes: 8, body: bodyOf(new Uint8Array(8)) }),
      );
      expect(row.sizeBytes).toBe(8);
    });

    // @story US-STO-01
    it('[US-STO-01][unit][sdk] a failing confirm leaves no object and no pending row', async () => {
      const failing = (catalog: CatalogPort): CatalogPort => ({
        ...catalog,
        confirm: () => Promise.reject(new Error('database down')),
      });
      const { f, save, objectKeys } = await harness(failing);

      await expect(save({ path: 'a.txt', body: bodyOf(bytesOf('a')) })).rejects.toThrow(
        'database down',
      );

      await expect(objectKeys()).resolves.toEqual([]);
      await expect(f.catalog.get('a.txt', { includePending: true })).resolves.toBeNull();
    });

    // @story US-STO-01
    it('[US-STO-01][unit][sdk] a confirm that commits but loses its reply keeps the object', async () => {
      const lossy = (catalog: CatalogPort): CatalogPort => ({
        ...catalog,
        confirm: async (row, input) => {
          await catalog.confirm(row, input);
          throw new Error('reply lost');
        },
      });
      const { f, save, objects, nameOf } = await harness(lossy);

      await expect(save({ path: 'a.txt', body: bodyOf(bytesOf('a')) })).rejects.toThrow(
        'reply lost',
      );

      const row = await f.catalog.get('a.txt');
      expect(row).toMatchObject({ status: 'ready' });
      await expect(objects.head(nameOf(row?.objectId))).resolves.not.toBeNull();
    });

    // @story US-STO-01
    it('[US-STO-01][unit][sdk] a committed save renamed before a lost confirm reply keeps its object', async () => {
      const renamedThenLost = (catalog: CatalogPort): CatalogPort => ({
        ...catalog,
        confirm: async (row, input) => {
          await catalog.confirm(row, input);
          await catalog.rename('a.txt', 'renamed.txt');
          throw new Error('reply lost');
        },
      });
      const { f, save, objects, nameOf } = await harness(renamedThenLost);

      await expect(save({ path: 'a.txt', body: bodyOf(bytesOf('kept')) })).rejects.toThrow(
        'reply lost',
      );

      const row = await f.catalog.get('renamed.txt');
      expect(row).toMatchObject({ status: 'ready', sizeBytes: 4 });
      await expect(objects.head(nameOf(row?.objectId))).resolves.not.toBeNull();
    });

    // @story US-STO-14
    it('[US-STO-14][unit][sdk] a save that loses confirmation to another confirmer preserves the ready object', async () => {
      // Someone else (the cleanup pass, a retried request) confirms the row first.
      const confirmedFirst = (catalog: CatalogPort): CatalogPort => ({
        ...catalog,
        confirm: async (row, input) => {
          await catalog.confirm(row, input);
          return catalog.confirm(row, input);
        },
      });
      const { f, save, objects, nameOf } = await harness(confirmedFirst);

      await save({ path: 'a.txt', body: bodyOf(bytesOf('kept')) });

      const row = await f.catalog.get('a.txt');
      expect(row).toMatchObject({ status: 'ready', sizeBytes: 4 });
      await expect(objects.head(nameOf(row?.objectId))).resolves.not.toBeNull();
    });

    // @story US-STO-01
    it('[US-STO-01][unit][sdk] a confirm that finds the row removed leaves no object', async () => {
      const { f, save, objectKeys } = await harness();
      const held = heldBody(bytesOf('a'));
      const pending = save({ path: 'a.txt', body: held.body });
      await vi.waitFor(async () => expect(await f.catalog.countPending()).toBe(1));
      await f.catalog.remove('a.txt');
      held.finish(bytesOf('b'));

      await expect(pending).resolves.toEqual({ ok: false, code: 'path_changed' });

      await expect(objectKeys()).resolves.toEqual([]);
    });

    // @story US-STO-01
    it('[US-STO-01][unit][sdk] replace switches rows and removes the old object', async () => {
      const { f, save, objects, objectKeys, nameOf } = await harness();
      const first = saved(await save({ path: 'a.txt', body: bodyOf(bytesOf('old')) }));
      const held = heldBody(bytesOf('new '));

      const second = save({ path: 'a.txt', body: held.body });
      await vi.waitFor(async () => expect(await f.catalog.countPending()).toBe(1));
      await expect(objects.head(nameOf(first.objectId))).resolves.not.toBeNull();
      await expect(f.catalog.get('a.txt')).resolves.toMatchObject({ id: first.id });
      held.finish(bytesOf('bytes'));
      const row = saved(await second);

      expect(row.id).not.toBe(first.id);
      expect(row).toMatchObject({ sizeBytes: 9, sha256: sha256Of(bytesOf('new bytes')) });
      await expect(f.catalog.get('a.txt')).resolves.toMatchObject({ id: row.id });
      await expect(objectKeys()).resolves.toEqual([nameOf(row.objectId)]);
      await expect(f.catalog.deleting()).resolves.toEqual([]);
    });

    // @story US-STO-01
    it('[US-STO-01][unit][sdk] replace: false over a ready file is path_taken and changes nothing', async () => {
      const { f, save, objectKeys, nameOf } = await harness();
      const first = saved(await save({ path: 'a.txt', body: bodyOf(bytesOf('old')) }));

      const result = await save({ path: 'a.txt', replace: false, body: bodyOf(bytesOf('new')) });

      expect(result).toEqual({ ok: false, code: 'path_taken' });
      await expect(f.catalog.get('a.txt')).resolves.toMatchObject({ id: first.id });
      await expect(f.catalog.countPending()).resolves.toBe(0);
      await expect(objectKeys()).resolves.toEqual([nameOf(first.objectId)]);
    });

    // @story US-STO-14
    it('[US-STO-14][unit][sdk] a replacement policy decides on the file another member wrote just before the reservation', async () => {
      const seen: string[] = [];
      let theirs: string | null = null;
      // The path was free when the caller was authorised; another member writes it first.
      const raced = (catalog: CatalogPort): CatalogPort => ({
        ...catalog,
        reserve: async (path, input) => {
          if (theirs === null) {
            const other = await catalog.reserve(path, {
              ...input,
              ownerPrincipalId: f.otherPrincipalId,
              createdBy: null,
              objectId: crypto.randomUUID(),
            });
            theirs = other.row.id;
            await catalog.confirm(other.row, { sizeBytes: 6, contentType: null });
          }
          return catalog.reserve(path, input);
        },
      });
      const { f, ctx, save } = await harness(raced);

      const result = await save({
        path: 'a.txt',
        body: bodyOf(bytesOf('mine')),
        replace: (target) => {
          seen.push(target.id);
          return Promise.resolve(target.ownerPrincipalId === ctx.principalId);
        },
      });

      expect(result).toEqual({ ok: false, code: 'path_taken' });
      expect(seen).toEqual([theirs]);
      await expect(f.catalog.get('a.txt')).resolves.toMatchObject({
        id: theirs,
        ownerPrincipalId: f.otherPrincipalId,
      });
      await expect(f.catalog.pending('a.txt')).resolves.toBeNull();
    });

    // @story US-STO-14
    it('[US-STO-14][unit][sdk] a replacement without the reserved target is refused, never decided by path', async () => {
      const blind = (catalog: CatalogPort): CatalogPort => ({
        ...catalog,
        reserve: async (path, input) => {
          const outcome = await catalog.reserve(path, input);
          return { kind: outcome.kind, row: outcome.row };
        },
      });
      const { f, save } = await harness(blind);
      const first = saved(await save({ path: 'a.txt', body: bodyOf(bytesOf('old')) }));
      const policy = vi.fn(() => Promise.resolve(true));

      const result = await save({ path: 'a.txt', body: bodyOf(bytesOf('new')), replace: policy });

      expect(result).toEqual({ ok: false, code: 'path_taken' });
      expect(policy).not.toHaveBeenCalled();
      await expect(f.catalog.get('a.txt')).resolves.toMatchObject({ id: first.id });
    });

    // @story US-STO-01
    it('[US-STO-01][unit][sdk] a failed replacement authorization releases the reservation and cancels the relay body', async () => {
      const { f, save, objectKeys, nameOf } = await harness();
      const first = saved(await save({ path: 'a.txt', body: bodyOf(bytesOf('old')) }));
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });

      await expect(
        save({
          path: 'a.txt',
          body,
          replace: () => Promise.reject(new Error('directory unavailable')),
        }),
      ).rejects.toThrow('directory unavailable');

      expect(cancel).toHaveBeenCalledOnce();
      await expect(f.catalog.pending('a.txt')).resolves.toBeNull();
      await expect(f.catalog.get('a.txt')).resolves.toMatchObject({ id: first.id });
      await expect(objectKeys()).resolves.toEqual([nameOf(first.objectId)]);
    });

    // @story US-STO-01
    it('[US-STO-01][unit][sdk] a replace policy decides on the locked ready row; a refusal or a failure leaves nothing pending', async () => {
      const { f, save, objectKeys, nameOf } = await harness();
      const first = saved(await save({ path: 'a.txt', body: bodyOf(bytesOf('old')) }));
      const asked: CatalogFile[] = [];

      const refused = await save({
        path: 'a.txt',
        body: bodyOf(bytesOf('new')),
        replace: (target) => {
          asked.push(target);
          return Promise.resolve(false);
        },
      });
      await expect(
        save({
          path: 'a.txt',
          body: bodyOf(bytesOf('new')),
          replace: () => Promise.reject(new Error('the directory is unavailable')),
        }),
      ).rejects.toThrow('the directory is unavailable');

      expect(refused).toEqual({ ok: false, code: 'path_taken' });
      expect(asked).toMatchObject([{ id: first.id, ownerPrincipalId: f.principalId }]);
      await expect(f.catalog.get('a.txt')).resolves.toMatchObject({ id: first.id });
      await expect(f.catalog.countPending()).resolves.toBe(0);
      await expect(objectKeys()).resolves.toEqual([nameOf(first.objectId)]);
    });

    // @story US-STO-01
    it('[US-STO-01][unit][sdk] a path_taken refusal cancels the body', async () => {
      const { save } = await harness();
      saved(await save({ path: 'a.txt', body: bodyOf(bytesOf('old')) }));
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });

      const result = await save({ path: 'a.txt', replace: false, body });

      expect(result).toEqual({ ok: false, code: 'path_taken' });
      expect(cancel).toHaveBeenCalledOnce();
    });

    // @story US-STO-14
    it('[US-STO-14][unit][sdk] two saves of one path: exactly one wins', async () => {
      const { f, save, objectKeys } = await harness();
      const held = heldBody(bytesOf('first'));

      const winner = save({ path: 'race.txt', body: held.body });
      await vi.waitFor(async () => expect(await f.catalog.countPending()).toBe(1));
      const loser = await save({ path: 'race.txt', body: bodyOf(bytesOf('second')) });
      held.finish(bytesOf(' done'));

      expect(loser).toEqual({ ok: false, code: 'upload_in_progress' });
      const row = saved(await winner);
      expect(row.sizeBytes).toBe(10);
      await expect(objectKeys()).resolves.toHaveLength(1);
    });

    // @story US-STO-14
    it('[US-STO-14][unit][sdk] a pending upload of another owner is upload_in_progress', async () => {
      const { f, ctx, save, objectKeys } = await harness();
      const held = heldBody(bytesOf('first'));

      const winner = save({ path: 'race.txt', body: held.body });
      await vi.waitFor(async () => expect(await f.catalog.countPending()).toBe(1));
      const loser = await save(
        { path: 'race.txt', body: bodyOf(bytesOf('second')) },
        { ...ctx, principalId: f.otherPrincipalId, userId: null },
      );
      held.finish(bytesOf(' done'));

      expect(loser).toEqual({ ok: false, code: 'upload_in_progress' });
      saved(await winner);
      await expect(objectKeys()).resolves.toHaveLength(1);
    });

    // @story US-STO-01
    it.each(['../x', '%aside/x', '/abs', ''])(
      '[US-STO-01][unit][sdk] the unsafe path %j is invalid_path and reserves nothing',
      async (path) => {
        const { f, save, objectKeys } = await harness();

        await expect(save({ path, body: bodyOf(bytesOf('x')) })).resolves.toEqual({
          ok: false,
          code: 'invalid_path',
        });

        await expect(f.catalog.countPending()).resolves.toBe(0);
        await expect(objectKeys()).resolves.toEqual([]);
      },
    );
  });
}

defineSuite(true, 'in-memory catalog', memoryFixture);
defineSuite(hasDatabase, 'PostgreSQL catalog', postgresFixture);

describe('save on the in-memory catalog with an injected failure', () => {
  // @story US-STO-01
  it('[US-STO-01][unit][sdk] a failNext confirm leaves no object and no pending row', async () => {
    const provider = createInMemoryCatalog();
    const workspaceId = crypto.randomUUID();
    const catalog = provider.forWorkspace(workspaceId);
    const objects = createInMemoryObjectStore();
    const log = { info() {}, warn() {}, error() {}, child: () => log };
    const storage = createStorageService({ catalog: () => Promise.resolve(catalog), objects, log });
    provider.failNext('confirm', new Error('database down'));

    await expect(
      storage.save(
        { workspaceId, principalId: crypto.randomUUID(), userId: null },
        { area: 'files', path: 'a.txt', maxBytes: 1024, replace: true, body: bodyOf(bytesOf('a')) },
      ),
    ).rejects.toThrow('database down');

    const { entries } = await objects.listPage('workspaces', { recursive: true });
    expect(entries).toEqual([]);
    await expect(catalog.get('a.txt', { includePending: true })).resolves.toBeNull();
  });
});
