import {
  createInMemoryWorkspaceScopeResolver,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  files,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll } from 'vitest';
import {
  createResourceCatalogStoreProvider,
  type ResourceCatalogStoreProvider,
} from '../storage/store';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
interface Member {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string | null;
}

export interface World {
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly scopes: WorkspaceScopeResolver;
  readonly a: Member;
  /**
   * Ready file rows with an object id and no object behind them, written straight into the catalog
   * (one bulk insert on PostgreSQL), like a raw insert: the folder move is the thing under test,
   * not 10,000 uploads.
   */
  seed(paths: readonly string[]): Promise<void>;
  /** Another principal of workspace `a`, one that may own rows. */
  member(): Promise<string>;
}

export function memoryWorld(): Promise<World> {
  const a = { workspaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), userId: null };
  const catalogs = createInMemoryCatalogStore();
  return Promise.resolve({
    catalogs,
    scopes: createInMemoryWorkspaceScopeResolver([{ id: a.workspaceId, slug: 'acme' }]),
    a,
    seed: (paths) => {
      const catalog = catalogs.forWorkspaceSync(a.workspaceId);
      for (const path of paths) {
        catalog.seed({
          path,
          status: 'ready',
          ownerPrincipalId: a.principalId,
          objectId: crypto.randomUUID(),
        });
      }
      return Promise.resolve();
    },
    member: () => Promise.resolve(crypto.randomUUID()),
  });
}

let isolated: IsolatedTestDatabase | undefined;

async function postgresMember(db: IsolatedTestDatabase['db'], joining?: string): Promise<Member> {
  const workspaceId = joining ?? crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  if (joining === undefined) {
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'files' });
  }
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Member' });
  await db.transaction(async (tx) => {
    const role = joining === undefined ? 'owner' : 'builder';
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  return { workspaceId, principalId, userId };
}

export async function postgresWorld(): Promise<World> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const { db } = isolated;
  const scopes = createDatabaseWorkspaceScopeResolver(db);
  const a = await postgresMember(db);
  return {
    catalogs: createResourceCatalogStoreProvider({
      repositories: createDatabaseResourceCatalogRepositoryProvider(db),
      scopes,
    }),
    scopes,
    a,
    seed: async (paths) => {
      const rows = paths.map((path) => {
        const objectId = crypto.randomUUID();
        return {
          workspaceId: a.workspaceId,
          path,
          kind: 'file' as const,
          storageKey: `files/${objectId}`,
          objectId,
          sizeBytes: 1,
          contentType: 'text/plain',
          ownerPrincipalId: a.principalId,
          createdBy: a.userId,
        };
      });
      for (let at = 0; at < rows.length; at += 2000) {
        await db.insert(files).values(rows.slice(at, at + 2000));
      }
    },
    member: async () => (await postgresMember(db, a.workspaceId)).principalId,
  };
}

export async function initializeDatabase(url: string | undefined) {
  url = url?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set; run this suite through `pnpm test`.');
  }
  isolated = await createIsolatedTestDatabase('aw_files_move_delete');
}

afterAll(async () => isolated?.close());
