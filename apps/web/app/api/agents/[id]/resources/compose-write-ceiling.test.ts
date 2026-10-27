/**
 * Verification round 1, finding 1 (blocking) — the composed run request must carry read-only for
 * a file whose grant is still `'read-write'` in the database once the agent's own `writeFiles`
 * permission has been turned off, even when nothing ever re-`replace()`d the assignment row. That
 * is exactly the shape `AgentDetailScreen.save()` (`../../../../../components/agents/agent-detail.
 * tsx`) produces on its own documented partial-failure path: the definition `PATCH` (which can
 * flip `writeFiles` off) succeeds, and the resources `PUT` that would otherwise re-narrow the
 * grant fails or is never re-sent, and the screen deliberately leaves the stored assignment alone
 * so the visible partial-outcome banner stays honest (issue #133's "no optimistic view of the
 * assignments" acceptance criterion).
 *
 * `packages/core/src/db/repositories/agent-resources.test.ts` already proves the repository's
 * `get` narrows a stale row directly against real PostgreSQL. This file proves the same thing one
 * layer up, through the actual production wiring the run composer uses:
 * `createAgentRunResourceLoader` (`apps/web/server/compose/resource-loader.ts`, imported here
 * read-only — this task does not own that file) fed by the real, unmodified
 * `createRepositoryAgentResourceStoreProvider` (`../../../../../server/agents/resource-store.ts`)
 * and `createDatabaseAgentResourceRepositoryProvider`, over a real database. Only the object store
 * behind assigned file content is faked (`createInMemoryObjectStore`, under the real catalog
 * service, as `apps/web/server/compose/resource-loader.test.ts` does) — the write-permission ceiling
 * under test has nothing to do with where file bytes live.
 *
 * `apps/web/server/compose/**` is outside this task's Owns globs; nothing in that directory is
 * edited here, only imported.
 */
import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  agents,
  createDatabaseAgentRepositoryProvider,
  createDatabaseAgentResourceRepositoryProvider,
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  files,
  memberships,
  users,
  workspaces,
  workspacePrincipals,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { createInMemoryObjectStore } from '@agent-workspace/core/storage';

import { createAgentRunResourceLoader } from '../../../../../server/compose/resource-loader';
import { createRepositoryAgentResourceStoreProvider } from '../../../../../server/agents/resource-store';
import { createResourceCatalogStoreProvider } from '../../../../../server/resources/catalog-store';
import { createStorageService } from '../../../../../server/storage/service';

const quietLog = { info() {}, warn() {}, error() {}, child: () => quietLog };

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    "[compose-write-ceiling.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so this task's " +
      'proof that a composed run request narrows a stale read-write grant was NOT exercised.',
  );
}

describe.skipIf(!hasDatabase)(
  'createAgentRunResourceLoader narrows a stale read-write grant (verification round 1, finding 1)',
  () => {
    let isolated: IsolatedTestDatabase;
    const workspaceId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const fileId = crypto.randomUUID();
    const ownerId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const ownerPrincipalId = crypto.randomUUID();

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase('aw_w9ui133_compose_ceiling');
      await isolated.db
        .insert(workspaces)
        .values([{ id: workspaceId, slug: 'compose-ceiling', name: 'Compose Ceiling' }]);
      await isolated.db
        .insert(users)
        .values([{ id: ownerId, email: `${ownerId}@example.test`, name: 'Owner' }]);
      await isolated.db.transaction(async (tx) => {
        await tx
          .insert(memberships)
          .values([{ id: membershipId, workspaceId, userId: ownerId, role: 'owner' }]);
        await tx.insert(workspacePrincipals).values({
          id: ownerPrincipalId,
          workspaceId,
          kind: 'membership',
          membershipId,
        });
      });
      await isolated.db.insert(agents).values({
        id: agentId,
        workspaceId,
        name: 'Compose ceiling agent',
        instructions: '',
        modelConnectionId: null,
        model: null,
        // Starts with writeFiles ALLOWED so the read-write grant below persists legitimately.
        permissions: {
          readFiles: true,
          writeFiles: true,
          runCommands: false,
          unrestrictedNetwork: false,
        },
        createdBy: ownerId,
        ownerPrincipalId,
      });
      await isolated.db.insert(files).values({
        id: fileId,
        workspaceId,
        path: 'handbook',
        kind: 'folder',
        storageKey: null,
        createdBy: ownerId,
        ownerPrincipalId,
      });
    }, 180_000);

    afterAll(async () => isolated.close());

    it('composes a run with access: "read" for a folder whose stored grant is still "read-write" once writeFiles is turned off with no follow-up PUT', async () => {
      const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
      const assignments = createRepositoryAgentResourceStoreProvider({
        repositories: createDatabaseAgentResourceRepositoryProvider(isolated.db),
        scopes,
      });
      const catalog = createResourceCatalogStoreProvider({
        repositories: createDatabaseResourceCatalogRepositoryProvider(isolated.db),
        scopes,
      });

      // Step 1: grant read-write while writeFiles is on — a legitimate PUT.
      await expect(
        assignments.forWorkspace(workspaceId).replace(agentId, {
          files: [{ fileId, access: 'read-write' }],
          skillIds: [],
          connectorIds: [],
        }),
      ).resolves.toMatchObject({ kind: 'updated' });

      // Step 2: a later, independent PATCH turns writeFiles off — modelled with the same
      // `AgentRepository.update` method `PATCH /api/agents/:id` calls (`../route.ts`, outside this
      // task's Owns), so this file asserts only what the loader does with the resulting state, not
      // how the PATCH route itself is implemented. Per `AgentDetailScreen.save()`'s documented
      // behaviour, a resources PUT that would re-narrow the grant is never re-sent when the
      // definition half already succeeded and the assignments half failed or was not attempted —
      // this row is exactly what that leaves behind.
      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null) throw new Error('workspace fixture did not resolve');
      await expect(
        createDatabaseAgentRepositoryProvider(isolated.db)
          .forScope(scope)
          .update(agentId, {
            permissions: {
              readFiles: true,
              writeFiles: false,
              runCommands: false,
              unrestrictedNetwork: false,
            },
          }),
      ).resolves.toMatchObject({ kind: 'updated' });

      // Step 3: compose a run. No project, no runtime skills/connectors store needed — only the
      // agent's own file grant is exercised.
      const assigned = await assignments.forWorkspace(workspaceId).get(agentId);
      if (assigned === null) throw new Error('the agent has no assignments');
      const loader = createAgentRunResourceLoader({
        catalog,
        storage: createStorageService({
          catalog: (id) => catalog.forWorkspace(id),
          objects: createInMemoryObjectStore(),
          log: quietLog,
        }),
      });
      const selection = await loader.load(workspaceId, assigned);
      const folder = selection.files.find((resource) => resource.path === 'handbook');
      expect(folder).toMatchObject({ kind: 'directory', access: 'read' });
    });
  },
);
