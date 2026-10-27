import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { and, count, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  agents,
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseSessionStateRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  files,
  memberships,
  sessions,
  sessionStateBlobs,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  bytesToStream,
  createLocalFilesystemObjectStore,
  createLocalFilesystemObjectStoreProvider,
  newObjectId,
  storageObjectName,
  streamToBytes,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';

import { runCleanupPass } from './cleanup';
import { runCopyStage } from './migrate-naming';
import { createStorageService } from './service';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[storage/migrate-naming.integration.test.ts] the PostgreSQL trial was SKIPPED — ' +
      'TEST_DATABASE_URL is not set, so the copy stage was NOT run end to end.',
  );
}

const log: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => log,
};
const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(!hasDatabase)('the copy stage on PostgreSQL and a local-disk store', () => {
  let isolated: IsolatedTestDatabase;
  let tmp: string;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'aw-migrate-naming-'));
    isolated = await createIsolatedTestDatabase('aw_storage_migrate_trial');
    const { db } = isolated;
    await db.insert(workspaces).values({ id: workspaceId, slug: workspaceId, name: 'Trial' });
    await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    await db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'Trial agent',
      instructions: '',
      ownerPrincipalId: principalId,
      createdBy: userId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    await db
      .insert(sessions)
      .values({ id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId });
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
    await rm(tmp, { recursive: true, force: true });
  });

  async function catalog() {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('catalog scope did not resolve');
    return {
      files: createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scope),
      state: createDatabaseSessionStateRepositoryProvider(isolated.db).forScope(scope),
    };
  }

  // @story US-STO-13
  it('[US-STO-13][api][cli] trial: legacy data on local disk is copied, verified and switched end to end', async () => {
    const stores = {
      files: createLocalFilesystemObjectStoreProvider(path.join(tmp, 'files')),
      skills: createLocalFilesystemObjectStoreProvider(path.join(tmp, 'skills')),
      'session-state': createLocalFilesystemObjectStoreProvider(path.join(tmp, 'state')),
    };
    const objects = createLocalFilesystemObjectStore(path.join(tmp, 'root'));
    const { files: rows, state } = await catalog();

    // The data as the old layout left it: bytes at the path, a row with no object id.
    const seeded = new Map<string, Uint8Array>([
      ['notes.txt', new TextEncoder().encode('hello')],
      ['reports/2026/q1.bin', randomBytes(3 * 1024 * 1024)],
      ['reports/empty.txt', new Uint8Array(0)],
    ]);
    for (const [filePath, bytes] of seeded) {
      await stores.files.forWorkspace(workspaceId).write(filePath, bytes, { contentType: null });
      await rows.putFile({
        path: filePath,
        kind: 'file',
        storageKey: filePath,
        sizeBytes: bytes.byteLength,
        contentType: null,
        ownerPrincipalId: principalId,
      });
    }
    const skillBytes = new TextEncoder().encode('# a skill');
    await stores.skills.forWorkspace(workspaceId).write('s/SKILL.md', skillBytes, {
      contentType: null,
    });
    const reserved = await rows.reserve('s/SKILL.md', {
      ownerPrincipalId: principalId,
      sizeBytes: skillBytes.byteLength,
      contentType: null,
      area: 'skills',
    });
    await rows.confirm(reserved.row, { sizeBytes: skillBytes.byteLength, contentType: null });
    const blobBytes = randomBytes(1024);
    await stores['session-state'].forWorkspace(workspaceId).write('s/blob', blobBytes, {
      contentType: null,
    });
    await state.putBlob(sessionId, {
      engine: 'claude-agent-sdk',
      blobKey: 'snapshot',
      storageKey: 's/blob',
      sizeBytes: blobBytes.byteLength,
      sha256: sha256Of(blobBytes),
    });

    const run = (mode: 'copy' | 'copy-dry-run') =>
      runCopyStage({
        objects,
        legacy: stores,
        catalog: () => Promise.resolve(rows),
        blobs: () => Promise.resolve(state),
        workspaceIds: () => Promise.resolve([workspaceId]),
        mode,
        log,
      });

    const dry = await run('copy-dry-run');
    expect(dry.areas).toMatchObject({
      files: { found: 3, switched: 0 },
      skills: { found: 1, switched: 0 },
      'session-state': { found: 1, switched: 0 },
    });

    const report = await run('copy');
    expect(report.areas).toMatchObject({
      files: { found: 3, switched: 3 },
      skills: { found: 1, switched: 1 },
      'session-state': { found: 1, switched: 1 },
    });

    // No old-style row remains, in the database itself.
    const { db } = isolated;
    const [oldFiles] = await db
      .select({ n: count() })
      .from(files)
      .where(
        and(eq(files.workspaceId, workspaceId), eq(files.kind, 'file'), isNull(files.objectId)),
      );
    const [oldBlobs] = await db
      .select({ n: count() })
      .from(sessionStateBlobs)
      .where(
        and(eq(sessionStateBlobs.workspaceId, workspaceId), isNull(sessionStateBlobs.objectId)),
      );
    expect(oldFiles?.n).toBe(0);
    expect(oldBlobs?.n).toBe(0);

    // Every file downloads byte-identical from the new naming, with the recorded checksum.
    const service = createStorageService({
      catalog: () => Promise.resolve(rows),
      objects,
      // No old store: a read that still needed one would find nothing.
      legacy: {},
      log,
    });
    const ctx = { workspaceId, principalId, userId };
    for (const [filePath, bytes] of seeded) {
      const row = await service.get(ctx, 'files', filePath);
      expect(row?.sha256).toBe(sha256Of(bytes));
      const stream = await service.open(ctx, row ?? never());
      const read = await streamToBytes((stream ?? never()).body);
      expect(Buffer.from(read).equals(Buffer.from(bytes))).toBe(true);
    }
    const skill = await rows.get('s/SKILL.md');
    const skillStream = await objects.read(
      storageObjectName(workspaceId, 'skills', skill?.objectId ?? ''),
    );
    expect(
      Buffer.from(await streamToBytes((skillStream ?? never()).body)).equals(
        Buffer.from(skillBytes),
      ),
    ).toBe(true);
    const blob = await state.getBlob(sessionId, 'claude-agent-sdk', 'snapshot');
    const blobStream = await objects.read(
      storageObjectName(workspaceId, 'session-state', blob?.objectId ?? ''),
    );
    expect(
      Buffer.from(await streamToBytes((blobStream ?? never()).body)).equals(Buffer.from(blobBytes)),
    ).toBe(true);

    // The old objects are still there: removing them is a later stage.
    await expect(stores.files.forWorkspace(workspaceId).head('notes.txt')).resolves.not.toBeNull();

    // A second run has nothing to do, and the cleanup job finds no orphan.
    await expect(run('copy')).resolves.toMatchObject({ areas: {} });
    const cleanup = await runCleanupPass({
      objects,
      legacy: null,
      catalogs: () => Promise.resolve(rows),
      sessionState: () => Promise.resolve(state),
      workspaceIds: () => Promise.resolve([workspaceId]),
      now: () => new Date(Date.now() + 30 * 24 * 3600 * 1000),
      mode: 'report',
      log,
    });
    expect(cleanup).toMatchObject({ orphans: 0 });
  });

  // @story US-STO-13
  it('[US-STO-13][unit][cli] a blob replaced while its copy is made keeps the new snapshot', async () => {
    const stores = {
      'session-state': createLocalFilesystemObjectStoreProvider(path.join(tmp, 'state-race')),
    };
    const objects = createLocalFilesystemObjectStore(path.join(tmp, 'root-race'));
    const { state } = await catalog();
    const old = new TextEncoder().encode('old snapshot');
    await stores['session-state'].forWorkspace(workspaceId).write('race/blob', old, {
      contentType: null,
    });
    await state.putBlob(sessionId, {
      engine: 'claude-agent-sdk',
      blobKey: 'race',
      storageKey: 'race/blob',
      sizeBytes: old.byteLength,
      sha256: sha256Of(old),
    });
    // A save replaces the blob after the job read it from the work list and before it switches.
    const newObjectName = newObjectId();
    const fresh = new TextEncoder().encode('new snapshot');
    const racing = {
      forWorkspace: (id: string) => ({
        ...stores['session-state'].forWorkspace(id),
        read: async (key: string) => {
          await objects.write(
            storageObjectName(workspaceId, 'session-state', newObjectName),
            bytesToStream(fresh),
            { contentType: null },
          );
          await state.putBlob(sessionId, {
            engine: 'claude-agent-sdk',
            blobKey: 'race',
            storageKey: storageObjectName(workspaceId, 'session-state', newObjectName),
            objectId: newObjectName,
            sizeBytes: fresh.byteLength,
            sha256: sha256Of(fresh),
          });
          return stores['session-state'].forWorkspace(id).read(key);
        },
      }),
    };

    const report = await runCopyStage({
      objects,
      legacy: { 'session-state': racing },
      catalog: () =>
        Promise.resolve({
          list: () => Promise.resolve({ rows: [], cursor: null }),
          switchObject: () => Promise.resolve(false),
        }),
      blobs: () => Promise.resolve(state),
      workspaceIds: () => Promise.resolve([workspaceId]),
      mode: 'copy',
      log,
    });

    expect(report.areas['session-state']).toMatchObject({ found: 1, raced: 1, switched: 0 });
    // Only the new snapshot's object is left; the copy of the old bytes is gone.
    const left = await objects.listPage('', { recursive: true });
    expect(left.entries.map((entry) => entry.key)).toEqual([
      storageObjectName(workspaceId, 'session-state', newObjectName),
    ]);
    const blob = await state.getBlob(sessionId, 'claude-agent-sdk', 'race');
    expect(blob?.objectId).toBe(newObjectName);
    expect(blob?.sha256).toBe(sha256Of(fresh));
  });
});

function never(): never {
  throw new Error('unreachable');
}
