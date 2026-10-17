import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { apiKeys } from '../schema/api-keys.js';
import { endpointClientAgents } from '../schema/endpoint-client-agents.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseDirectoryRoot } from './directory.js';
import { createDatabaseEndpointClientRepositoryProvider } from './endpoint-clients.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('EndpointClientRepository (ADR-0134)', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentA = crypto.randomUUID();
  const agentB = crypto.randomUUID();
  const foreignAgent = crypto.randomUUID();

  const permissions = {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  };

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_endpoint_clients');
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: workspaceId, name: 'Endpoints' },
      { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Other' },
    ]);
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.com`, name: 'Owner' });
    const membershipId = crypto.randomUUID();
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalId,
        workspaceId,
        kind: 'membership',
        membershipId,
      });
    });
    const otherMembershipId = crypto.randomUUID();
    const otherPrincipalId = crypto.randomUUID();
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: otherMembershipId, workspaceId: otherWorkspaceId, userId, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: otherPrincipalId,
        workspaceId: otherWorkspaceId,
        kind: 'membership',
        membershipId: otherMembershipId,
      });
    });
    const agent = (id: string, workspace: string, owner: string) => ({
      id,
      workspaceId: workspace,
      name: `agent ${id}`,
      instructions: '',
      ownerPrincipalId: owner,
      createdBy: userId,
      permissions,
    });
    await isolated.db
      .insert(agents)
      .values([
        agent(agentA, workspaceId, principalId),
        agent(agentB, workspaceId, principalId),
        agent(foreignAgent, otherWorkspaceId, otherPrincipalId),
      ]);
  }, 180_000);

  afterAll(async () => isolated.close());

  async function clientsFor(workspace: string) {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(workspace);
    if (scope === null) throw new Error('workspace did not resolve');
    return createDatabaseEndpointClientRepositoryProvider(isolated.db).forScope(scope);
  }

  const directory = () => createDatabaseDirectoryRoot(isolated.db);

  async function mintKey(clientId: string, name: string) {
    const outcome = await directory()
      .forWorkspace(workspaceId)
      .createEndpointApiKey({
        name,
        role: 'builder',
        keyPrefix: `pfx_${crypto.randomUUID().slice(0, 8)}`,
        keyHash: crypto.randomBytes(32).toString('hex'),
        expiresAt: null,
        endpointClientId: clientId,
        actsForPrincipalId: principalId,
      });
    return outcome;
  }

  const base = { actsForPrincipalId: principalId, createdByPrincipalId: principalId };

  it('creates a client with its agents and refuses a duplicate name per kind', async () => {
    const clients = await clientsFor(workspaceId);
    const created = await clients.create({
      ...base,
      name: 'orders',
      kind: 'mcp-project',
      agentIds: [agentB, agentA, agentA],
      toolNames: ['getOrder'],
    });
    if (created.kind !== 'created') throw new Error('expected created');
    expect([...created.client.agentIds].sort()).toEqual([agentA, agentB].sort());
    expect(created.client.toolNames).toEqual(['getOrder']);
    expect(created.client.revokedAt).toBeNull();

    expect(
      await clients.create({ ...base, name: 'orders', kind: 'mcp-project', agentIds: [agentA] }),
    ).toEqual({ kind: 'name-taken' });
    const sameNameOtherKind = await clients.create({
      ...base,
      name: 'orders',
      kind: 'a2a-agent',
      agentIds: [agentA],
    });
    expect(sameNameOtherKind.kind).toBe('created');
  });

  it('enforces the agent count per kind', async () => {
    const clients = await clientsFor(workspaceId);
    await expect(
      clients.create({ ...base, name: 'two', kind: 'a2a-agent', agentIds: [agentA, agentB] }),
    ).rejects.toThrow();
    await expect(
      clients.create({ ...base, name: 'none', kind: 'mcp-project', agentIds: [] }),
    ).rejects.toThrow();
    await expect(
      clients.create({
        ...base,
        name: 'tools-on-a2a',
        kind: 'a2a-agent',
        agentIds: [agentA],
        toolNames: ['x'],
      }),
    ).rejects.toThrow();
  });

  it('refuses another workspace agent and writes nothing', async () => {
    const clients = await clientsFor(workspaceId);
    await expect(
      clients.create({ ...base, name: 'foreign', kind: 'mcp-project', agentIds: [foreignAgent] }),
    ).rejects.toThrow();
    expect(await clients.findByName('mcp-project', 'foreign')).toBeNull();
  });

  it('does not show a client to another workspace', async () => {
    const clients = await clientsFor(workspaceId);
    const created = await clients.create({
      ...base,
      name: 'isolated',
      kind: 'mcp-project',
      agentIds: [agentA],
    });
    if (created.kind !== 'created') throw new Error('expected created');
    const other = await clientsFor(otherWorkspaceId);
    expect(await other.get(created.client.id)).toBeNull();
    expect(await other.list()).toEqual([]);
    expect(await other.update(created.client.id, { toolNames: ['x'] })).toEqual({
      kind: 'not-found',
    });
    expect(await other.revoke(created.client.id, new Date())).toBeNull();
    expect((await clients.get(created.client.id))?.revokedAt).toBeNull();
  });

  it('replaces agents and the tool list on update, and keeps the kind rules', async () => {
    const clients = await clientsFor(workspaceId);
    const mcp = await clients.create({
      ...base,
      name: 'update-mcp',
      kind: 'mcp-project',
      agentIds: [agentA],
    });
    const a2a = await clients.create({
      ...base,
      name: 'update-a2a',
      kind: 'a2a-agent',
      agentIds: [agentA],
    });
    if (mcp.kind !== 'created' || a2a.kind !== 'created') throw new Error('expected created');
    const updated = await clients.update(mcp.client.id, { agentIds: [agentB], toolNames: ['t'] });
    if (updated.kind !== 'updated') throw new Error('expected updated');
    expect(updated.client.agentIds).toEqual([agentB]);
    expect(updated.client.toolNames).toEqual(['t']);
    expect(updated.client.updatedAt.getTime()).toBeGreaterThanOrEqual(
      mcp.client.updatedAt.getTime(),
    );
    await expect(clients.update(a2a.client.id, { agentIds: [agentA, agentB] })).rejects.toThrow();
    await expect(clients.update(a2a.client.id, { toolNames: ['t'] })).rejects.toThrow();
    expect((await clients.get(a2a.client.id))?.agentIds).toEqual([agentA]);
  });

  it('rebinds the agent of an a2a client on an agents-only patch', async () => {
    const clients = await clientsFor(workspaceId);
    const a2a = await clients.create({
      ...base,
      name: 'rebind-a2a',
      kind: 'a2a-agent',
      agentIds: [agentA],
    });
    if (a2a.kind !== 'created') throw new Error('expected created');
    const updated = await clients.update(a2a.client.id, { agentIds: [agentB] });
    if (updated.kind !== 'updated') throw new Error('expected updated');
    expect(updated.client.agentIds).toEqual([agentB]);
    expect(updated.client.updatedAt.getTime()).toBeGreaterThanOrEqual(
      a2a.client.updatedAt.getTime(),
    );
  });

  it('refuses to change a revoked client under the row lock', async () => {
    const clients = await clientsFor(workspaceId);
    const created = await clients.create({
      ...base,
      name: 'revoked-then-patched',
      kind: 'a2a-agent',
      agentIds: [agentA],
    });
    if (created.kind !== 'created') throw new Error('expected created');
    await clients.revoke(created.client.id, new Date());
    expect(await clients.update(created.client.id, { agentIds: [agentB] })).toEqual({
      kind: 'revoked',
    });
    expect((await clients.get(created.client.id))?.agentIds).toEqual([agentA]);
  });

  it('deleting an agent removes its row from the client', async () => {
    const clients = await clientsFor(workspaceId);
    const disposable = crypto.randomUUID();
    await isolated.db.insert(agents).values({
      id: disposable,
      workspaceId,
      name: 'disposable',
      instructions: '',
      ownerPrincipalId: principalId,
      createdBy: userId,
      permissions,
    });
    const created = await clients.create({
      ...base,
      name: 'cascade',
      kind: 'mcp-project',
      agentIds: [agentA, disposable],
    });
    if (created.kind !== 'created') throw new Error('expected created');
    await isolated.db.delete(agents).where(eq(agents.id, disposable));
    expect((await clients.get(created.client.id))?.agentIds).toEqual([agentA]);
  });

  describe('bound keys', () => {
    it('authenticates a bound key with its endpoint scope and never as a plain principal', async () => {
      const clients = await clientsFor(workspaceId);
      const mcp = await clients.create({
        ...base,
        name: 'keyed-mcp',
        kind: 'mcp-project',
        agentIds: [agentA],
      });
      const a2a = await clients.create({
        ...base,
        name: 'keyed-a2a',
        kind: 'a2a-agent',
        agentIds: [agentB],
      });
      if (mcp.kind !== 'created' || a2a.kind !== 'created') throw new Error('expected created');

      const hash = crypto.randomBytes(32).toString('hex');
      const minted = await directory().forWorkspace(workspaceId).createEndpointApiKey({
        name: 'mcp key',
        role: 'builder',
        keyPrefix: 'pfx_mcp',
        keyHash: hash,
        expiresAt: null,
        endpointClientId: mcp.client.id,
        actsForPrincipalId: principalId,
      });
      if (minted.kind !== 'created') throw new Error('expected created');
      const authenticated = await directory().authenticateApiKeyHash(hash, new Date());
      expect(authenticated?.endpointScope).toEqual({
        kind: 'mcp-project',
        clientId: mcp.client.id,
      });
      expect((await clients.get(mcp.client.id))?.apiKeyIds).toEqual([minted.key.id]);
      expect(minted.key.endpointScope).toEqual({ kind: 'mcp-project', clientId: mcp.client.id });

      const a2aHash = crypto.randomBytes(32).toString('hex');
      const a2aMinted = await directory().forWorkspace(workspaceId).createEndpointApiKey({
        name: 'a2a key',
        role: 'builder',
        keyPrefix: 'pfx_a2a',
        keyHash: a2aHash,
        expiresAt: null,
        endpointClientId: a2a.client.id,
        actsForPrincipalId: principalId,
      });
      if (a2aMinted.kind !== 'created') throw new Error('expected created');
      expect(
        (await directory().authenticateApiKeyHash(a2aHash, new Date()))?.endpointScope,
      ).toEqual({ kind: 'a2a-agent', clientId: a2a.client.id, agentId: agentB });

      const keyPrincipal = await isolated.db
        .select({ id: workspacePrincipals.id })
        .from(workspacePrincipals)
        .where(eq(workspacePrincipals.apiKeyId, minted.key.id));
      const keyPrincipalId = keyPrincipal[0]?.id;
      if (keyPrincipalId === undefined) throw new Error('key principal missing');
      expect(await directory().principalById(workspaceId, keyPrincipalId)).toBeNull();
    });

    it('reports the endpoint scope of a key when it is revoked on its own', async () => {
      const clients = await clientsFor(workspaceId);
      const created = await clients.create({
        ...base,
        name: 'key-revoke',
        kind: 'mcp-project',
        agentIds: [agentA],
      });
      if (created.kind !== 'created') throw new Error('expected created');
      const minted = await mintKey(created.client.id, 'single');
      if (minted.kind !== 'created') throw new Error('expected created');
      const revoked = await directory()
        .forWorkspace(workspaceId)
        .revokeApiKey(minted.key.id, new Date());
      expect(revoked).toMatchObject({
        kind: 'revoked',
        key: { endpointScope: { kind: 'mcp-project', clientId: created.client.id } },
      });
    });

    it('revoking the client revokes every bound key and its principal, once', async () => {
      const clients = await clientsFor(workspaceId);
      const created = await clients.create({
        ...base,
        name: 'to-revoke',
        kind: 'mcp-project',
        agentIds: [agentA],
      });
      if (created.kind !== 'created') throw new Error('expected created');
      const hash = crypto.randomBytes(32).toString('hex');
      const minted = await directory().forWorkspace(workspaceId).createEndpointApiKey({
        name: 'doomed',
        role: 'builder',
        keyPrefix: 'pfx_doomed',
        keyHash: hash,
        expiresAt: null,
        endpointClientId: created.client.id,
        actsForPrincipalId: principalId,
      });
      if (minted.kind !== 'created') throw new Error('expected created');
      expect(await directory().authenticateApiKeyHash(hash, new Date())).not.toBeNull();

      const at = new Date();
      const revoked = await clients.revoke(created.client.id, at);
      expect(revoked?.client.revokedAt).not.toBeNull();
      expect(revoked?.revokedKeys).toEqual([{ id: minted.key.id, name: 'doomed' }]);
      const keyRows = await isolated.db
        .select({ revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(eq(apiKeys.id, minted.key.id));
      expect(keyRows[0]?.revokedAt).not.toBeNull();
      const principalRows = await isolated.db
        .select({ revokedAt: workspacePrincipals.revokedAt })
        .from(workspacePrincipals)
        .where(eq(workspacePrincipals.apiKeyId, minted.key.id));
      expect(principalRows[0]?.revokedAt).not.toBeNull();
      expect(await directory().authenticateApiKeyHash(hash, new Date())).toBeNull();

      const again = await clients.revoke(created.client.id, new Date(at.getTime() + 60_000));
      expect(again?.client.revokedAt?.getTime()).toBe(revoked?.client.revokedAt?.getTime());
      expect(again?.revokedKeys).toEqual([]);

      expect(await mintKey(created.client.id, 'late')).toEqual({
        kind: 'endpoint-client-revoked',
        id: created.client.id,
      });
    });

    it('refuses to bind a key to a client of another workspace or one that does not exist', async () => {
      const missing = crypto.randomUUID();
      expect(await mintKey(missing, 'ghost')).toEqual({
        kind: 'no-such-endpoint-client',
        id: missing,
      });
      const clients = await clientsFor(workspaceId);
      const created = await clients.create({
        ...base,
        name: 'wrong-tenant',
        kind: 'mcp-project',
        agentIds: [agentA],
      });
      if (created.kind !== 'created') throw new Error('expected created');
      const outcome = await directory()
        .forWorkspace(otherWorkspaceId)
        .createEndpointApiKey({
          name: 'cross',
          role: 'builder',
          keyPrefix: 'pfx_cross',
          keyHash: crypto.randomBytes(32).toString('hex'),
          expiresAt: null,
          endpointClientId: created.client.id,
          actsForPrincipalId: principalId,
        });
      expect(outcome.kind).toBe('no-such-endpoint-client');
    });

    it('fails closed when the agent of an a2a client is gone', async () => {
      const clients = await clientsFor(workspaceId);
      const doomedAgent = crypto.randomUUID();
      await isolated.db.insert(agents).values({
        id: doomedAgent,
        workspaceId,
        name: 'doomed agent',
        instructions: '',
        ownerPrincipalId: principalId,
        createdBy: userId,
        permissions,
      });
      const created = await clients.create({
        ...base,
        name: 'orphaned',
        kind: 'a2a-agent',
        agentIds: [doomedAgent],
      });
      if (created.kind !== 'created') throw new Error('expected created');
      const hash = crypto.randomBytes(32).toString('hex');
      const minted = await directory().forWorkspace(workspaceId).createEndpointApiKey({
        name: 'orphan key',
        role: 'builder',
        keyPrefix: 'pfx_orphan',
        keyHash: hash,
        expiresAt: null,
        endpointClientId: created.client.id,
        actsForPrincipalId: principalId,
      });
      if (minted.kind !== 'created') throw new Error('expected created');
      await isolated.db.delete(agents).where(eq(agents.id, doomedAgent));
      expect(
        await isolated.db
          .select()
          .from(endpointClientAgents)
          .where(eq(endpointClientAgents.clientId, created.client.id)),
      ).toEqual([]);
      expect(await directory().authenticateApiKeyHash(hash, new Date())).toBeNull();
    });
  });
});
