import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  auditActions,
  auditEvents,
  createInMemoryCatalog,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { openDatabaseRoot, type ResourceCatalogRepository } from '@agent-workspace/core/db';
import {
  bytesToStream,
  createInMemoryObjectStore,
  storageObjectName,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { AUDIT_ACTIONS } from '@indx-workspace/contracts/observability';
import type { Logger } from '@agent-workspace/core/telemetry';

import { createStorageService, type StorageAuditEvent, type StorageContext } from './service';

interface Fixture {
  readonly workspace: () => Promise<{ readonly id: string; readonly principalId: string }>;
  readonly catalog: (workspaceId: string) => Promise<ResourceCatalogRepository>;
}

function memoryFixture(): Promise<Fixture> {
  const provider = createInMemoryCatalog();
  return Promise.resolve({
    workspace: () => Promise.resolve({ id: crypto.randomUUID(), principalId: crypto.randomUUID() }),
    catalog: (workspaceId) => Promise.resolve(provider.forWorkspace(workspaceId)),
  });
}

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL suite below is never skipped.
  isolated = await createIsolatedTestDatabase('aw_storage_audit');
}, 180_000);

afterAll(async () => isolated?.close());

function postgresFixture(): Promise<Fixture> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const provider = createDatabaseResourceCatalogRepositoryProvider(db);
  const scopes = createDatabaseWorkspaceScopeResolver(db);
  return Promise.resolve({
    workspace: async () => {
      const id = crypto.randomUUID();
      await db.insert(workspaces).values({ id, slug: `s-${id}`, name: 'storage audit' });
      const userId = crypto.randomUUID();
      const membershipId = crypto.randomUUID();
      const principalId = crypto.randomUUID();
      await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
      await db.transaction(async (tx) => {
        await tx
          .insert(memberships)
          .values({ id: membershipId, workspaceId: id, userId, role: 'owner' });
        await tx
          .insert(workspacePrincipals)
          .values({ id: principalId, workspaceId: id, kind: 'membership', membershipId });
      });
      return { id, principalId };
    },
    catalog: async (workspaceId) => {
      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null) throw new Error(`workspace ${workspaceId} no longer exists`);
      return provider.forScope(scope);
    },
  });
}

const noLog: Logger = { info() {}, warn() {}, error() {}, child: () => noLog };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const bytesOf = (text: string) => new TextEncoder().encode(text);
/** Built at run time: a signature-shaped value that no source file spells out. */
const sentinel = () => crypto.randomUUID().replaceAll('-', '');

function defineSuite(name: string, setup: () => Promise<Fixture>) {
  describe(`file actions are audited on the ${name}`, () => {
    async function harness() {
      const f = await setup();
      const ws = await f.workspace();
      const signature = sentinel();
      const events: StorageAuditEvent[] = [];
      /** Fail the next `n` audit writes; `landed`: the row is written and only the reply is lost. */
      const failing = { next: 0, landed: false };
      const inner = createInMemoryObjectStore();
      const objects: ObjectStore = {
        ...inner,
        capabilities: { ...inner.capabilities, sign: true, boundLengthSign: true },
        createSignedUrl: (key) =>
          Promise.resolve({
            url: `https://store.invalid/${key}?sig=${signature}`,
            headers: { 'x-signature': signature },
          }),
      };
      const storage = createStorageService({
        catalog: f.catalog,
        objects,
        log: noLog,
        // Keyed by the event id, as the audit table's primary key keeps it: a key written again is
        // not a second row.
        audit: (event) => {
          const lost = failing.next > 0;
          if (lost) failing.next -= 1;
          if ((!lost || failing.landed) && !events.some((seen) => seen.id === event.id)) {
            events.push(event);
          }
          return lost ? Promise.reject(new Error('audit down')) : Promise.resolve();
        },
      });
      const actor = { principalId: ws.principalId, userId: null, label: 'Ito' };
      const ctx: StorageContext = {
        workspaceId: ws.id,
        principalId: ws.principalId,
        userId: null,
        actor,
      };
      const catalog = await f.catalog(ws.id);
      const save = async (path: string, text: string, area: 'files' | 'artifacts' = 'files') => {
        const saved = await storage.save(ctx, {
          area,
          path,
          body: bytesToStream(bytesOf(text)),
          maxBytes: 1024,
          replace: true,
        });
        if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
        return saved.row;
      };
      return { ws, ctx, actor, catalog, objects, storage, events, failing, signature, save };
    }

    const eventOf = (h: { ws: { id: string }; actor: { principalId: string } }, rest: object) => ({
      id: expect.stringMatching(UUID) as unknown,
      workspaceId: h.ws.id,
      actorPrincipalId: h.actor.principalId,
      actorUserId: null,
      actorLabel: 'Ito',
      ...rest,
    });
    const mintRequest = (path: string) => ({
      path,
      sizeBytes: 3,
      mayReplace: () => Promise.resolve(true),
    });
    const link = { responseContentType: 'text/plain', responseDisposition: 'attachment' };

    // @story US-STO-01
    it('[US-STO-01][api][sdk] upload is audited', async () => {
      const h = await harness();
      const relayed = await h.save('a.txt', 'abc');
      expect(h.events).toEqual([
        eventOf(h, { action: 'file-uploaded', subjectId: relayed.id, subjectLabel: 'a.txt' }),
      ]);

      // A signed link: the mint is a link, the complete is the upload.
      h.events.length = 0;
      expect((await h.storage.reserveUpload(h.ctx, mintRequest('b.txt'))).ok).toBe(true);
      const pending = await h.catalog.pending('b.txt');
      if (pending === null) throw new Error('no pending row');
      const name = storageObjectName(h.ws.id, 'files', pending.objectId ?? '');
      await h.objects.write(name, bytesOf('xyz'), { contentType: null });
      const done = { path: 'b.txt', maxBytes: 1024 };
      await expect(h.storage.completeUpload(h.ctx, done)).resolves.toMatchObject({ ok: true });
      expect(h.events.map((e) => e.action)).toEqual(['file-link-created', 'file-uploaded']);
      expect(h.events[1]).toMatchObject({ subjectId: pending.id, subjectLabel: 'b.txt' });
      // Completing again answers the ready file: no second upload row.
      await h.storage.completeUpload(h.ctx, done);
      expect(h.events).toHaveLength(2);
    });

    // @story US-STO-01
    it('[US-STO-01][api][sdk] run outputs, system callers and refused saves write no audit row', async () => {
      const h = await harness();
      await h.save('out.txt', 'abc', 'artifacts');
      const system = { workspaceId: h.ws.id, principalId: h.ws.principalId, userId: null };
      const input = (path: string, text: string, maxBytes: number) => ({
        area: 'files' as const,
        path,
        body: bytesToStream(bytesOf(text)),
        maxBytes,
        replace: true,
      });
      await h.storage.save(system, input('sys.txt', 'abc', 1024));
      await expect(h.storage.save(h.ctx, input('big.txt', 'abcdef', 3))).resolves.toEqual({
        ok: false,
        code: 'too_large',
      });
      expect(h.events).toEqual([]);
    });

    // @story US-STO-01
    it('[US-STO-01][api][sdk] a download is audited, and the agent reading the same row is not', async () => {
      const h = await harness();
      const row = await h.save('a.txt', 'abc');
      h.events.length = 0;
      const read = await h.storage.open({ workspaceId: h.ws.id }, row);
      await read?.body.cancel();
      expect(h.events).toEqual([]);
      const download = await h.storage.open(h.ctx, row);
      await download?.body.cancel();
      expect(h.events).toEqual([
        eventOf(h, { action: 'file-downloaded', subjectId: row.id, subjectLabel: 'a.txt' }),
      ]);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] every ranged read is its own download row, so no read goes unaudited', async () => {
      const h = await harness();
      const row = await h.save('a.txt', 'abcdef');
      h.events.length = 0;

      // Intended (#1772): one row per download request, a Range request included. Two reads of
      // the same range are two reads.
      for (const range of [
        { start: 0, end: 2 },
        { start: 3, end: 5 },
        { start: 3, end: 5 },
      ]) {
        const read = await h.storage.open(h.ctx, row, range);
        await read?.body.cancel();
      }

      expect(h.events).toEqual([
        eventOf(h, { action: 'file-downloaded', subjectId: row.id, subjectLabel: 'a.txt' }),
        eventOf(h, { action: 'file-downloaded', subjectId: row.id, subjectLabel: 'a.txt' }),
        eventOf(h, { action: 'file-downloaded', subjectId: row.id, subjectLabel: 'a.txt' }),
      ]);
      expect(new Set(h.events.map((event) => event.id)).size).toBe(3);
    });

    // @story US-STO-03
    it('[US-STO-03][api][sdk] move is audited', async () => {
      const h = await harness();
      const row = await h.save('a.txt', 'abc');
      h.events.length = 0;
      const moved = await h.storage.rename(h.ctx, 'files', 'a.txt', 'docs/b.txt');
      expect(moved).toMatchObject({ ok: true });
      expect(h.events).toEqual([
        eventOf(h, {
          action: 'file-moved',
          subjectId: row.id,
          subjectLabel: 'a.txt -> docs/b.txt',
        }),
      ]);
      // A refused move records nothing.
      const refused = await h.storage.rename(h.ctx, 'files', 'nope.txt', 'c.txt');
      expect(refused).toMatchObject({ ok: false });
      expect(h.events).toHaveLength(1);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] link creation is audited', async () => {
      const h = await harness();
      const row = await h.save('a.txt', 'abc');
      h.events.length = 0;
      expect(await h.storage.signDownload(h.ctx, row, link)).not.toBeNull();
      expect(h.events).toEqual([
        eventOf(h, { action: 'file-link-created', subjectId: row.id, subjectLabel: 'a.txt' }),
      ]);
      expect((await h.storage.reserveUpload(h.ctx, mintRequest('new.txt'))).ok).toBe(true);
      expect(h.events.map((e) => e.action)).toEqual(['file-link-created', 'file-link-created']);
      // A refused mint (a folder holds the path) records nothing.
      await h.storage.createFolder(h.ctx, 'dir');
      expect((await h.storage.reserveUpload(h.ctx, mintRequest('dir'))).ok).toBe(false);
      expect(h.events).toHaveLength(2);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] a signed URL never appears in any audit row', async () => {
      const h = await harness();
      const row = await h.save('a.txt', 'abc');
      const down = await h.storage.signDownload(h.ctx, row, link);
      const up = await h.storage.reserveUpload(h.ctx, mintRequest('b.txt'));
      // The links did carry the signature, so the assertion below can fail.
      expect(JSON.stringify([down, up])).toContain(h.signature);
      expect(h.events.map((e) => e.action)).toContain('file-link-created');
      expect(JSON.stringify(h.events)).not.toContain(h.signature);
      expect(JSON.stringify(h.events)).not.toContain('store.invalid');
    });

    // @story US-STO-02
    it('[US-STO-02][api][sdk] a retried upload complete re-audits a failed audit write, under the same key', async () => {
      const h = await harness();
      expect((await h.storage.reserveUpload(h.ctx, mintRequest('b.txt'))).ok).toBe(true);
      const pending = await h.catalog.pending('b.txt');
      if (pending === null) throw new Error('no pending row');
      await h.objects.write(
        storageObjectName(h.ws.id, 'files', pending.objectId ?? ''),
        bytesOf('xyz'),
        {
          contentType: null,
        },
      );
      const done = { path: 'b.txt', maxBytes: 1024 };
      h.events.length = 0;
      // Down for the write and its one in-process retry: the upload commits, the caller sees the error.
      h.failing.next = 2;
      await expect(h.storage.completeUpload(h.ctx, done)).rejects.toThrow('audit down');
      expect(h.events).toEqual([]);

      // The caller's retry finds the upload done and records it now.
      await expect(h.storage.completeUpload(h.ctx, done)).resolves.toMatchObject({ ok: true });
      expect(h.events).toEqual([
        eventOf(h, { action: 'file-uploaded', subjectId: pending.id, subjectLabel: 'b.txt' }),
      ]);
      // A further retry writes the same key again, which the trail keeps once.
      await h.storage.completeUpload(h.ctx, done);
      expect(h.events).toHaveLength(1);
    });

    // @story US-STO-04
    it('[US-STO-04][api][sdk] an audit write whose reply is lost is retried under the same key and kept once', async () => {
      const h = await harness();
      const row = await h.save('docs/a.txt', 'abc');
      h.events.length = 0;
      h.failing.next = 1;
      h.failing.landed = true;

      await expect(
        h.storage.remove(h.ctx, 'files', 'docs/a.txt', { recursive: false }),
      ).resolves.toMatchObject({ ok: true });

      expect(h.events).toEqual([
        eventOf(h, { action: 'file-deleted', subjectId: row.id, subjectLabel: 'docs/a.txt' }),
      ]);
    });

    // @story US-STO-04
    it('[US-STO-04][api][sdk] two uploads to one path are two audit rows, each under its own key', async () => {
      const h = await harness();
      await h.save('a.txt', 'one');
      await h.save('a.txt', 'two');
      expect(h.events.map((event) => event.action)).toEqual(['file-uploaded', 'file-uploaded']);
      expect(new Set(h.events.map((event) => event.id)).size).toBe(2);
    });

    // @story US-STO-04
    it('[US-STO-04][api][sdk] a failed audit write keeps the action and reaches the caller', async () => {
      const f = await setup();
      const ws = await f.workspace();
      const storage = createStorageService({
        catalog: f.catalog,
        objects: createInMemoryObjectStore(),
        log: noLog,
        audit: () => Promise.reject(new Error('audit down')),
      });
      const ctx: StorageContext = {
        workspaceId: ws.id,
        principalId: ws.principalId,
        userId: null,
        actor: { principalId: ws.principalId, userId: null, label: 'Ito' },
      };
      await expect(
        storage.save(ctx, {
          area: 'files',
          path: 'a.txt',
          body: bytesToStream(bytesOf('abc')),
          maxBytes: 1024,
          replace: true,
        }),
      ).rejects.toThrow('audit down');
      // The upload committed: the file is there and nothing was deleted.
      const catalog = await f.catalog(ws.id);
      await expect(catalog.get('a.txt')).resolves.toMatchObject({ status: 'ready', sizeBytes: 3 });
    });

    // @story US-STO-04
    it('[US-STO-04][api][sdk] deleting a file writes a file-deleted audit row with the actor', async () => {
      const h = await harness();
      const row = await h.save('docs/a.txt', 'abc');
      h.events.length = 0;
      await expect(
        h.storage.remove(h.ctx, 'files', 'docs/a.txt', { recursive: false }),
      ).resolves.toMatchObject({ ok: true });
      expect(h.events).toEqual([
        eventOf(h, { action: 'file-deleted', subjectId: row.id, subjectLabel: 'docs/a.txt' }),
      ]);
    });

    // @story US-STO-04
    it('[US-STO-04][api][sdk] a delete that marked no row writes no file-deleted audit row', async () => {
      const h = await harness();
      await h.save('docs/a.txt', 'abc');
      h.events.length = 0;
      // A concurrent delete wins the race: by the time this one marks, the row is already gone.
      const racing = createStorageService({
        catalog: () =>
          Promise.resolve({
            ...h.catalog,
            remove: async (target: string) => {
              await h.catalog.remove(target);
              return h.catalog.remove(target);
            },
          }),
        objects: h.objects,
        log: noLog,
        audit: (event) => {
          h.events.push(event);
          return Promise.resolve();
        },
      });
      await expect(
        racing.remove(h.ctx, 'files', 'docs/a.txt', { recursive: false }),
      ).resolves.toEqual({ ok: true, removed: 0, files: [] });
      expect(h.events).toEqual([]);
    });
  });
}

defineSuite('in-memory catalog', memoryFixture);
defineSuite('PostgreSQL catalog', postgresFixture);

describe('the audit table keeps one row per audit key', () => {
  // @story US-STO-04
  it('[US-STO-04][api][sdk] recording the same key twice writes one row', async () => {
    if (isolated === undefined) throw new Error('the test database did not start');
    const root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
    try {
      const workspaceId = crypto.randomUUID();
      await isolated.db
        .insert(workspaces)
        .values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'audit key' });
      const event = {
        id: crypto.randomUUID(),
        workspaceId,
        actorPrincipalId: null,
        actorLabel: 'Ito',
        action: 'file-deleted' as const,
        subjectId: crypto.randomUUID(),
        subjectLabel: 'a.txt',
      };
      await root.recordAuditEvent(event);
      await root.recordAuditEvent(event);
      const rows = await isolated.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.workspaceId, workspaceId));
      expect(rows.map((row) => row.id)).toEqual([event.id]);
    } finally {
      await root.close();
    }
  });
});

describe('the audit table accepts every file action', () => {
  // @story US-STO-04
  it('[US-STO-04][api][sdk] the database constraint admits the five file actions and the lists agree', async () => {
    if (isolated === undefined) throw new Error('the test database did not start');
    const { db } = isolated;
    const workspaceId = crypto.randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'audit' });
    const actions = [
      'file-uploaded',
      'file-downloaded',
      'file-link-created',
      'file-moved',
      'file-deleted',
    ] as const;
    await db.insert(auditEvents).values(
      actions.map((action) => ({
        workspaceId,
        actorPrincipalId: null,
        actorLabel: 'Ito',
        action,
        subjectId: crypto.randomUUID(),
        subjectLabel: 'a.txt',
      })),
    );
    for (const action of actions) expect(auditActions).toContain(action);
    expect([...auditActions]).toEqual([...AUDIT_ACTIONS]);
  });
});
