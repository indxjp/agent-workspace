/**
 * The database-backed resource-assignment and grant stores (`./store.ts`), end to end against
 * PostgreSQL. Before refactoring plan part 07 step 2 moved them here, their own files had no test
 * of their own: only `get` was reached, through the routes.
 */
import crypto from 'node:crypto';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRepositoryAgentGrantStoreProvider,
  createRepositoryAgentResourceStoreProvider,
  createRepositoryAgentStoreProvider,
} from './store';
import { input } from './store.conformance';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

describe.skipIf(!hasDatabase)('the agents store adapters on PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  let root: DatabaseRoot;
  const workspace = { id: crypto.randomUUID(), slug: 'agents-adapters', name: 'Agents Adapters' };
  const user = { id: crypto.randomUUID(), email: 'adapters@example.test', name: 'Adapter' };
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  let agentId: string;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_p07_agents_adapters');
    await isolated.db.insert(workspaces).values(workspace);
    await isolated.db.insert(users).values(user);
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, workspaceId: workspace.id, userId: user.id, role: 'viewer' });
      await tx.insert(workspacePrincipals).values({
        id: principalId,
        workspaceId: workspace.id,
        kind: 'membership',
        membershipId,
      });
    });
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
    const created = await createRepositoryAgentStoreProvider({
      repositories: root.agents,
      scopes: root.scopes,
    })
      .forWorkspace(workspace.id)
      .create(input({ name: 'adapter-agent' }), {
        principalId,
        userId: user.id,
      });
    if (created.kind !== 'created') throw new Error(`agent not created: ${created.kind}`);
    agentId = created.agent.id;
  }, 120_000);

  afterAll(async () => {
    await root?.close();
    await isolated?.close();
  });

  describe('createRepositoryAgentResourceStoreProvider', () => {
    const store = () =>
      createRepositoryAgentResourceStoreProvider({
        repositories: root.agentResources,
        scopes: root.scopes,
      });

    it('writes an assignment and reads the same one back', async () => {
      const assignments = store().forWorkspace(workspace.id);
      const replaced = await assignments.replace(agentId, {
        files: [],
        skillIds: [],
        connectorIds: [],
      });
      expect(replaced).toMatchObject({
        kind: 'updated',
        assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: [] },
      });
      await expect(assignments.get(agentId)).resolves.toMatchObject({
        files: [],
        skillIds: [],
        connectorIds: [],
      });
    });

    it('names an unknown connector rather than storing it', async () => {
      const id = crypto.randomUUID();
      await expect(
        store()
          .forWorkspace(workspace.id)
          .replace(agentId, { files: [], skillIds: [], connectorIds: [id] }),
      ).resolves.toStrictEqual({ kind: 'unknown-connector', id });
    });

    it('answers not-found for an agent this workspace does not have', async () => {
      await expect(
        store()
          .forWorkspace(workspace.id)
          .replace(crypto.randomUUID(), { files: [], skillIds: [], connectorIds: [] }),
      ).resolves.toStrictEqual({ kind: 'not-found' });
    });

    it('refuses a workspace that does not exist', async () => {
      await expect(store().forWorkspace(crypto.randomUUID()).get(agentId)).rejects.toThrow(
        /no longer exists/u,
      );
    });
  });

  describe('createRepositoryAgentGrantStoreProvider', () => {
    const store = () =>
      createRepositoryAgentGrantStoreProvider({
        repositories: root.agentGrants,
        scopes: root.scopes,
      });

    it('replaces, lists and checks the grants of one agent', async () => {
      const grants = store().forWorkspace(workspace.id);
      await expect(grants.hasGrant(agentId, user.id)).resolves.toBe(false);
      await expect(grants.listPrincipalIds(agentId)).resolves.toStrictEqual([]);
      await expect(grants.replacePrincipalIds(agentId, [principalId])).resolves.toStrictEqual({
        kind: 'updated',
        principalIds: [principalId],
      });
      await expect(grants.listPrincipalIds(agentId)).resolves.toStrictEqual([principalId]);
      await expect(grants.hasGrant(agentId, user.id)).resolves.toBe(true);
    });

    it('answers null and agent-not-found for an agent this workspace does not have', async () => {
      const grants = store().forWorkspace(workspace.id);
      const missing = crypto.randomUUID();
      await expect(grants.listPrincipalIds(missing)).resolves.toBeNull();
      await expect(grants.replacePrincipalIds(missing, [])).resolves.toStrictEqual({
        kind: 'agent-not-found',
      });
    });

    it('refuses a workspace that does not exist', async () => {
      await expect(
        store().forWorkspace(crypto.randomUUID()).hasGrant(agentId, user.id),
      ).rejects.toThrow();
    });
  });
});
