import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  agents,
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseSessionStateRepositoryProvider,
  createDatabaseStorageMigrationRunRepository,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  sessions,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  createLocalFilesystemObjectStore,
  createLocalFilesystemObjectStoreProvider,
  streamToBytes,
  type ObjectStoreProviderV2,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';

import { runCleanupPass } from './cleanup';
import { runFinalizeStage } from './migrate-finalize';
import { runAdoptStage, runCopyStage } from './migrate-naming';
import { createStorageService } from './service';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[storage/migrate-finalize.integration.test.ts] the PostgreSQL trial was SKIPPED — ' +
      'TEST_DATABASE_URL is not set, so the finalize stage was NOT run end to end.',
  );
}

const log: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => log,
};
const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(!hasDatabase)('the finalize stage on PostgreSQL and a local-disk store', () => {
  let isolated: IsolatedTestDatabase;
  let tmp: string;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'aw-migrate-finalize-'));
    isolated = await createIsolatedTestDatabase('aw_storage_migrate_final_trial');
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

  const keysOf = async (provider: ObjectStoreProviderV2) =>
    (await provider.forWorkspace(workspaceId).listPage('', { recursive: true })).entries
      .map((entry) => entry.key)
      .sort();

  // @story US-STO-13
  it('[US-STO-13][api][cli] trial: adopt, copy and finalize leave every file intact and no old object but the unaccounted', async () => {
    const stores = {
      files: createLocalFilesystemObjectStoreProvider(path.join(tmp, 'files')),
      skills: createLocalFilesystemObjectStoreProvider(path.join(tmp, 'skills')),
      'session-state': createLocalFilesystemObjectStoreProvider(path.join(tmp, 'state')),
    };
    const objects = createLocalFilesystemObjectStore(path.join(tmp, 'root'));
    const { files: rows, state } = await catalog();
    const oldFiles = stores.files.forWorkspace(workspaceId);

    // The data as the old layout left it: bytes at the path and, for most, a row with no object id.
    const seeded = new Map<string, Uint8Array>([
      ['notes.txt', new TextEncoder().encode('hello')],
      ['reports/2026/q1.bin', randomBytes(3 * 1024 * 1024)],
      ['reports/empty.txt', new Uint8Array(0)],
      // No row: an upload the old layout never recorded. The adopt stage gives it one.
      ['uploads/late.txt', new TextEncoder().encode('late')],
    ]);
    for (const [filePath, bytes] of seeded) {
      await oldFiles.write(filePath, bytes, { contentType: null });
      if (filePath === 'uploads/late.txt') continue;
      await rows.putFile({
        path: filePath,
        kind: 'file',
        storageKey: filePath,
        sizeBytes: bytes.byteLength,
        contentType: null,
        ownerPrincipalId: principalId,
      });
    }
    // A folder marker of a folder that is a catalog row, and a staging archive no row ever names.
    await rows.createFolder('empty-dir', { ownerPrincipalId: principalId });
    await oldFiles.write('empty-dir/.agent-workspace-empty-folder', new Uint8Array(0), {
      contentType: null,
    });
    const archive = 'runs/r1/outputs/.runtime-staging.tar';
    await oldFiles.write(archive, randomBytes(64), { contentType: null });

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
    await rows.putSkill({
      name: 'sk',
      skillMd: '# sk',
      enabled: true,
      ownerPrincipalId: principalId,
    });
    const meta = { name: 'sk', enabled: true };
    await stores.skills
      .forWorkspace(workspaceId)
      .write('skill-meta/sk.json', new TextEncoder().encode(JSON.stringify(meta)), {
        contentType: 'application/json',
      });

    const blobBytes = randomBytes(1024);
    const oldState = stores['session-state'].forWorkspace(workspaceId);
    await oldState.write('s/blob', blobBytes, { contentType: null });
    await state.putBlob(sessionId, {
      engine: 'claude-agent-sdk',
      blobKey: 'snapshot',
      storageKey: 's/blob',
      sizeBytes: blobBytes.byteLength,
      sha256: sha256Of(blobBytes),
    });
    // The old twin of a snapshot that was overwritten: no row names it, so it is kept and reported.
    await oldState.write('s/overwritten', randomBytes(16), { contentType: null });

    const finalize = () =>
      runFinalizeStage({
        objects,
        legacy: stores,
        catalog: () => Promise.resolve(rows),
        blobs: () => Promise.resolve(state),
        workspaceIds: () => Promise.resolve([workspaceId]),
        runs: createDatabaseStorageMigrationRunRepository(isolated.db),
        log,
      });

    // Before the copy, rows are still in the old naming: the check passes nothing through.
    await expect(finalize()).resolves.toMatchObject({ outcome: 'blocked' });
    expect(await keysOf(stores.files)).toHaveLength(seeded.size + 2);

    await runAdoptStage({
      objects: createLocalFilesystemObjectStore(path.join(tmp, 'files')),
      prefix: 'workspaces',
      catalog: () => Promise.resolve(rows),
      ownerPrincipalId: () => Promise.resolve(principalId),
      runs: createDatabaseStorageMigrationRunRepository(isolated.db),
      log,
    });
    await runCopyStage({
      objects,
      legacy: stores,
      catalog: () => Promise.resolve(rows),
      blobs: () => Promise.resolve(state),
      workspaceIds: () => Promise.resolve([workspaceId]),
      mode: 'copy',
      log,
    });

    const report = await finalize();

    expect(report).toMatchObject({
      outcome: 'deleted',
      verify: { legacyRows: 0, mismatches: 0 },
      delete: { refused: null },
    });
    // 4 files + 1 skill file + 1 snapshot were checked.
    expect(report.verify.rowsChecked).toBe(6);

    // Every file downloads byte-identical from the new naming alone.
    const service = createStorageService({
      catalog: () => Promise.resolve(rows),
      objects,
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

    // No old object remains but the one no row accounts for, which is reported.
    expect(await keysOf(stores.files)).toEqual([archive]);
    expect(await keysOf(stores.skills)).toEqual([]);
    expect(await keysOf(stores['session-state'])).toEqual(['s/overwritten']);
    expect(report.delete).toMatchObject({
      unaccounted: 2,
      unaccountedSample: [
        `files:${workspaceId}:${archive}`,
        `session-state:${workspaceId}:s/overwritten`,
      ],
    });
    // The skill's record is in its column.
    expect((await rows.listSkills())[0]).toMatchObject({ name: 'sk', meta });
    // The pass is on record, clean.
    await expect(
      createDatabaseStorageMigrationRunRepository(isolated.db).latest(),
    ).resolves.toMatchObject({ rowsChecked: 6, legacyRows: 0, mismatches: 0 });

    // A second run has nothing to delete, and the cleanup job finds no orphan.
    await expect(finalize()).resolves.toMatchObject({ delete: { deleted: 0, unaccounted: 2 } });
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
});

function never(): never {
  throw new Error('unreachable');
}
