/**
 * Own/other ownership on the files `:id` routes over a real PostgreSQL catalog. Harness:
 * `routes.test-support.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createInMemoryWorkspaceScopeResolver,
  openDatabaseRoot,
  type DatabaseRoot,
} from '@agent-workspace/core/db';
import {
  apiKeys,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';
import { createPostgresDirectory } from '../rbac/postgres-directory';
import { Principal } from '../rbac/principal';
import { createResourceCatalogStoreProvider } from '../storage/store';
import { createCatalogFilesWorld } from './catalog-runtime-fixtures';
import {
  ACTOR_HEADER,
  WORKSPACE_HEADER,
  download,
  remove,
  rename,
  resolveWorkspaceFromHeader,
  upload,
} from './routes.test-support';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

/**
 * Verification round 2, finding 1: `ownershipOfPath` (`apps/web/server/files/ownership.ts`)
 * compares a file's catalog `created_by` against the caller, but every test in
 * `routes.test.ts` runs as an Owner, whose grant on `files` is `any` (`permissions.ts`) — wide
 * enough that `decide()` never even looks at what `ownershipOfPath` answered. This suite drives the
 * same three routes as a Builder, whose grant is `own`, so the comparison is the thing standing
 * between the two Builders below.
 *
 * The comparison reads a real `ResourceCatalogRepository` (`created_by` is tenant-paired to
 * `memberships` by a composite foreign key — see `packages/core/src/db/schema/files.ts`), and
 * the in-memory catalog has no such foreign key, so only PostgreSQL can show the pairing
 * hold. So this suite needs a real `TEST_DATABASE_URL` and skips loudly, rather than being
 * marked `.skip`, when one is not set —
 * the same `describe.skipIf` shape `resource-catalogs.test.ts` and `postgres-directory.test.ts`
 * use, so CI's real PostgreSQL 17 is the authority on whether it ran.
 */
describe.skipIf(!hasDatabase)(
  'own/other ownership on GET/DELETE/PATCH /api/files/:id (issue #117, PostgreSQL-backed)',
  () => {
    let isolated: IsolatedTestDatabase;
    let root: DatabaseRoot;
    const workspace = {
      id: crypto.randomUUID(),
      slug: 'w9-117-files-ownership',
      name: 'Files ownership',
    };
    const builderA = {
      id: crypto.randomUUID(),
      email: 'builder-a@example.test',
      name: 'Builder A',
    };
    const builderB = {
      id: crypto.randomUUID(),
      email: 'builder-b@example.test',
      name: 'Builder B',
    };
    const apiKeyAId = 'd4b86567-2c98-42e4-8c51-dab76a07f61e';
    const apiKeyBId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const principalAId = '79e2e118-56c7-4f54-96c5-e942b24de9b7';
    const principalBId = 'f54eceb4-80a0-48a5-a3a6-6fd634683f59';
    const asA = { workspace: workspace.id, actor: builderA.email };
    const asB = { workspace: workspace.id, actor: builderB.email };

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase('aw_files_ownership');
      await isolated.db.insert(workspaces).values(workspace);
      await isolated.db.insert(users).values([builderA, builderB]);
      await isolated.db.insert(memberships).values([
        { workspaceId: workspace.id, userId: builderA.id, role: 'builder' },
        { workspaceId: workspace.id, userId: builderB.id, role: 'builder' },
      ]);
      await isolated.db.transaction(async (tx) => {
        await tx.insert(apiKeys).values([
          {
            id: apiKeyAId,
            workspaceId: workspace.id,
            name: 'Builder A file key',
            role: 'builder',
            keyPrefix: 'ak_file_a',
            keyHash: 'a'.repeat(64),
          },
          {
            id: apiKeyBId,
            workspaceId: workspace.id,
            name: 'Builder B file key',
            role: 'builder',
            keyPrefix: 'ak_file_b',
            keyHash: 'b'.repeat(64),
          },
        ]);
        await tx.insert(workspacePrincipals).values([
          {
            id: principalAId,
            workspaceId: workspace.id,
            kind: 'api_key',
            apiKeyId: apiKeyAId,
          },
          {
            id: principalBId,
            workspaceId: workspace.id,
            kind: 'api_key',
            apiKeyId: apiKeyBId,
          },
        ]);
      });
      root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
    }, 180_000);

    afterAll(async () => {
      await root.close();
      await isolated.close();
    });

    beforeEach(() => {
      installTestDomains({
        files: {
          kind: 'serving',
          runtime: createCatalogFilesWorld({
            scopes: createInMemoryWorkspaceScopeResolver(
              [workspace.id].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
            ),
            resolveWorkspace: resolveWorkspaceFromHeader,
            catalogs: createResourceCatalogStoreProvider({
              repositories: root.resourceCatalogs,
              scopes: root.scopes,
            }),
          }).runtime,
        },
      });
      installTestDomains({
        rbac: {
          directory: createPostgresDirectory(root.directory),
          identify(request: Request) {
            const workspaceId = request.headers.get(WORKSPACE_HEADER);
            const actor = request.headers.get(ACTOR_HEADER);
            return Promise.resolve(
              workspaceId === null || actor === null
                ? null
                : Principal.fromApiKey({
                    principalId: actor === builderA.email ? principalAId : principalBId,
                    apiKeyId: actor === builderA.email ? apiKeyAId : apiKeyBId,
                    workspaceId,
                    role: 'builder',
                    label: actor === builderA.email ? 'Builder A file key' : 'Builder B file key',
                  }),
            );
          },
        },
      });
    });

    afterEach(() => {
      clearApplicationContext();
    });

    it('a Builder may rename and delete the file it uploaded, and no other Builder may (issue #117)', async () => {
      const uploaded = await upload('shared.txt', 'shared bytes', asA);
      expect(uploaded.status, await uploaded.clone().text()).toBe(201);

      // Builder's grant on `files` is `{ read: 'any', write: 'own', run: 'own' }`
      // (`permissions.ts`) — `GET` is readable workspace-wide by design and is not an own/other
      // gate; `PATCH` (rename) and `DELETE` are the writes this task's `ownershipOfPath` stands in
      // front of, and they are what this test proves. Both builders can download the same bytes
      // first, so the denials below are provably about the write verbs, not a workspace mismatch.
      const readByOther = await download('shared.txt', asB);
      expect(readByOther.status, await readByOther.clone().text()).toBe(200);

      // Builder B did not create this row: `own` is denied, on both write verbs this resolver
      // gates, and `decide()` never sees a role wide enough to substitute for it (Builder's write
      // grant on files is `own`, not `any`).
      expect((await rename('shared.txt', 'stolen.txt', asB)).status).toBe(403);
      expect((await remove('shared.txt', asB)).status).toBe(403);

      // Builder A did create it: the same routes, the same file, only the caller differs.
      const allowedRename = await rename('shared.txt', 'shared-renamed.txt', asA);
      expect(allowedRename.status, await allowedRename.clone().text()).toBe(200);

      const allowedDelete = await remove('shared-renamed.txt', asA);
      expect(allowedDelete.status, await allowedDelete.clone().text()).toBe(204);
    });

    it("owning a folder does not let a Builder delete or move another member's file inside it", async () => {
      for (const [caller, file] of [
        [asA, 'team/a.txt'],
        [asB, 'team/b.txt'],
      ] as const) {
        const uploaded = await upload(file, file, caller);
        expect(uploaded.status, await uploaded.clone().text()).toBe(201);
      }
      // `team` is Builder A's folder row (the first upload under it), but `team/b.txt` is B's.
      expect((await remove('team', { ...asA, recursive: true })).status).toBe(403);
      expect((await rename('team', 'mine', asA)).status).toBe(403);

      expect((await download('team/b.txt', asB)).status).toBe(200);
    });
  },
);
