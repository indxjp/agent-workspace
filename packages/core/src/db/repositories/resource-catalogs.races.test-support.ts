import crypto from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import type pg from 'pg';

import { closePool, connect } from '../client.js';
import { files } from '../schema/files.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { seedCatalogFile } from './catalog-fixtures.js';
import {
  createDatabaseResourceCatalogRepositoryProvider,
  type ResourceCatalogRepository,
} from './resource-catalogs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import {
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from './testing.js';

/** Pool size of the racing connection; the isolated database's own pool holds only four. */
export const RACE_CONNECTIONS = 10;

/** Timeout for creating the isolated database and seeding the race workspace. */
export const RACE_SETUP_TIMEOUT_MS = 180_000;

/** One isolated database with a seeded workspace and a catalog on a wide connection pool. */
export interface RaceHarness {
  readonly isolated: IsolatedTestDatabase;
  readonly racePool: pg.Pool;
  readonly catalog: ResourceCatalogRepository;
  readonly workspaceId: string;
  readonly userId: string;
  readonly principalId: string;
}

export async function createRaceHarness(databaseName: string): Promise<RaceHarness> {
  const isolated = await createIsolatedTestDatabase(databaseName);
  const { db } = isolated;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug: 'races', name: 'races' });
  await db
    .insert(users)
    .values({ id: userId, email: `${userId}@example.test`, name: 'Race owner' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  const scope = await createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(workspaceId);
  if (scope === null) throw new Error('race workspace scope did not resolve');

  const raced = connect({ url: isolated.url, maxConnections: RACE_CONNECTIONS });
  const catalog = createDatabaseResourceCatalogRepositoryProvider(raced.db).forScope(scope);
  return { isolated, racePool: raced.pool, catalog, workspaceId, userId, principalId };
}

export async function closeRaceHarness(harness: RaceHarness): Promise<void> {
  await closeIsolatedTestResources(harness.isolated, {
    close: () => closePool(harness.racePool),
  });
}

export function rowsAt(harness: RaceHarness, path: string) {
  return harness.isolated.db
    .select()
    .from(files)
    .where(and(eq(files.workspaceId, harness.workspaceId), eq(files.path, path)));
}

/** Every row standing for `path`, whether at the path itself or waiting at a side path. */
export function rowsFor(harness: RaceHarness, path: string) {
  return harness.isolated.db
    .select()
    .from(files)
    .where(
      and(
        eq(files.workspaceId, harness.workspaceId),
        sql`coalesce(${files.targetPath}, ${files.path}) = ${path}`,
      ),
    );
}

function putInput(harness: RaceHarness, path: string, sizeBytes: number) {
  return {
    path,
    kind: 'file' as const,
    storageKey: path,
    sizeBytes,
    contentType: null,
    ownerPrincipalId: harness.principalId,
    createdBy: harness.userId,
  };
}

export function seedFile(harness: RaceHarness, path: string, sizeBytes = 1) {
  return seedCatalogFile(harness.catalog, putInput(harness, path, sizeBytes));
}

/** The exclusive advisory lock a single-path writer takes for `path`. */
export function pathLock(harness: RaceHarness, path: string) {
  return sql`select pg_advisory_xact_lock(hashtextextended(${harness.workspaceId}::text || ':' || ${path}, 0))`;
}

/** The shared workspace lock every single-path writer holds. */
export function sharedWorkspaceLock(harness: RaceHarness) {
  return sql`select pg_advisory_xact_lock_shared(hashtextextended(${harness.workspaceId}::text, 0))`;
}

/** The exclusive workspace lock a prefix writer takes. */
export function exclusiveWorkspaceLock(harness: RaceHarness) {
  return sql`select pg_advisory_xact_lock(hashtextextended(${harness.workspaceId}::text, 0))`;
}

/** Reserve input for a path, with a fresh object id unless one is given. */
export function reserveInput(harness: RaceHarness, objectId = crypto.randomUUID()) {
  return {
    ownerPrincipalId: harness.principalId,
    sizeBytes: 1,
    contentType: null,
    objectId,
  };
}
