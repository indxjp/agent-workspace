import type { StorageConnectionProvider } from '@indx-workspace/contracts/storage-connections';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Database } from '../client.js';
import { storageConnections } from '../schema/storage-connections.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';
import { postgresViolations } from './violations.js';

export interface StorageConnectionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly provider: StorageConnectionProvider;
  readonly url: string;
  readonly allowedPrefixes: readonly string[];
  readonly writeAllowed: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The non-secret half of a connection. The id is chosen first because the credential is named by it. */
export interface CreateStorageConnectionRecordInput {
  readonly id: string;
  readonly name: string;
  readonly provider: StorageConnectionProvider;
  readonly url: string;
  readonly allowedPrefixes: readonly string[];
  readonly writeAllowed: boolean;
}

export type CreateStorageConnectionOutcome =
  | { readonly kind: 'created'; readonly connection: StorageConnectionRecord }
  | { readonly kind: 'name-conflict'; readonly name: string };

/** The fields a patch may change; an absent field keeps its value. */
export interface UpdateStorageConnectionRecordInput {
  readonly name?: string | undefined;
  readonly url?: string | undefined;
  readonly allowedPrefixes?: readonly string[] | undefined;
  readonly writeAllowed?: boolean | undefined;
}

export type UpdateStorageConnectionOutcome =
  | { readonly kind: 'updated'; readonly connection: StorageConnectionRecord }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'not-found' };

export interface StorageConnectionRepository {
  list(): Promise<readonly StorageConnectionRecord[]>;
  /** The connections of this workspace whose name is one of `names`; a name it lacks is absent. */
  listByNames(names: readonly string[]): Promise<readonly StorageConnectionRecord[]>;
  get(id: string): Promise<StorageConnectionRecord | null>;
  create(input: CreateStorageConnectionRecordInput): Promise<CreateStorageConnectionOutcome>;
  /** Change a connection of this workspace. `not-found` for a missing or another workspace's id. */
  update(
    id: string,
    patch: UpdateStorageConnectionRecordInput,
  ): Promise<UpdateStorageConnectionOutcome>;
  /** Delete a connection of this workspace and return it, or `null` when there is none. */
  delete(id: string): Promise<StorageConnectionRecord | null>;
}

export interface StorageConnectionRepositoryProvider {
  forScope(scope: WorkspaceScope): StorageConnectionRepository;
}

function toRecord(row: typeof storageConnections.$inferSelect): StorageConnectionRecord {
  return row;
}

function isNameConflict(error: unknown): boolean {
  for (const failure of postgresViolations(error)) {
    if (
      failure.code === '23505' &&
      failure.constraint === 'storage_connections_workspace_name_key'
    ) {
      return true;
    }
  }
  return false;
}

export function createDatabaseStorageConnectionRepositoryProvider(
  db: Database,
): StorageConnectionRepositoryProvider {
  return {
    forScope(scope: WorkspaceScope): StorageConnectionRepository {
      const checked = requireWorkspaceScope(scope, 'StorageConnectionRepositoryProvider');
      const tenant = eq(storageConnections.workspaceId, checked.workspaceId);

      return {
        async list() {
          const rows = await db
            .select()
            .from(storageConnections)
            .where(tenant)
            .orderBy(asc(storageConnections.createdAt), asc(storageConnections.id));
          return rows.map(toRecord);
        },
        async listByNames(names) {
          if (names.length === 0) return [];
          const rows = await db
            .select()
            .from(storageConnections)
            .where(and(tenant, inArray(storageConnections.name, [...new Set(names)])))
            .orderBy(asc(storageConnections.createdAt), asc(storageConnections.id));
          return rows.map(toRecord);
        },
        async get(id) {
          const rows = await db
            .select()
            .from(storageConnections)
            .where(and(tenant, eq(storageConnections.id, id)))
            .limit(1);
          return rows[0] === undefined ? null : toRecord(rows[0]);
        },
        async create(input) {
          try {
            const rows = await db
              .insert(storageConnections)
              .values({
                ...input,
                allowedPrefixes: [...input.allowedPrefixes],
                workspaceId: checked.workspaceId,
              })
              .returning();
            if (rows[0] === undefined) throw new Error('storage connection insert returned no row');
            return { kind: 'created' as const, connection: toRecord(rows[0]) };
          } catch (error) {
            if (isNameConflict(error)) return { kind: 'name-conflict', name: input.name };
            throw error;
          }
        },
        async update(id, patch) {
          try {
            // Drizzle leaves out a key whose value is `undefined`.
            const rows = await db
              .update(storageConnections)
              .set({
                name: patch.name,
                url: patch.url,
                allowedPrefixes:
                  patch.allowedPrefixes === undefined ? undefined : [...patch.allowedPrefixes],
                writeAllowed: patch.writeAllowed,
                updatedAt: new Date(),
              })
              .where(and(tenant, eq(storageConnections.id, id)))
              .returning();
            return rows[0] === undefined
              ? { kind: 'not-found' }
              : { kind: 'updated', connection: toRecord(rows[0]) };
          } catch (error) {
            if (isNameConflict(error)) return { kind: 'name-conflict', name: patch.name ?? '' };
            throw error;
          }
        },
        async delete(id) {
          const rows = await db
            .delete(storageConnections)
            .where(and(tenant, eq(storageConnections.id, id)))
            .returning();
          return rows[0] === undefined ? null : toRecord(rows[0]);
        },
      };
    },
  };
}
