import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { apiKeys } from '../schema/api-keys.js';
import { endpointClientAgents } from '../schema/endpoint-client-agents.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import type { EndpointClientFixture } from './endpoint-clients.fixture.test-support.js';

const newHash = () => crypto.randomBytes(32).toString('hex');

async function authenticatesBoundKeyWithEndpointScope(f: EndpointClientFixture) {
  const clients = await f.clientsFor(f.workspaceId);
  const mcp = await f.createClient(clients, {
    name: 'keyed-mcp',
    kind: 'mcp-project',
    agentIds: [f.agentA],
  });
  const a2a = await f.createClient(clients, {
    name: 'keyed-a2a',
    kind: 'a2a-agent',
    agentIds: [f.agentB],
  });

  const hash = newHash();
  const minted = await f.mintCreatedKey(mcp.id, 'mcp key', 'pfx_mcp', hash);
  const authenticated = await f.directory().authenticateApiKeyHash(hash, new Date());
  expect(authenticated?.endpointScope).toEqual({ kind: 'mcp-project', clientId: mcp.id });
  expect((await clients.get(mcp.id))?.apiKeyIds).toEqual([minted.key.id]);
  expect(minted.key.endpointScope).toEqual({ kind: 'mcp-project', clientId: mcp.id });

  const a2aHash = newHash();
  await f.mintCreatedKey(a2a.id, 'a2a key', 'pfx_a2a', a2aHash);
  expect((await f.directory().authenticateApiKeyHash(a2aHash, new Date()))?.endpointScope).toEqual({
    kind: 'a2a-agent',
    clientId: a2a.id,
    agentId: f.agentB,
  });

  const keyPrincipal = await f.db
    .select({ id: workspacePrincipals.id })
    .from(workspacePrincipals)
    .where(eq(workspacePrincipals.apiKeyId, minted.key.id));
  const keyPrincipalId = keyPrincipal[0]?.id;
  if (keyPrincipalId === undefined) throw new Error('key principal missing');
  expect(await f.directory().principalById(f.workspaceId, keyPrincipalId)).toBeNull();
}

async function reportsEndpointScopeOnKeyRevocation(f: EndpointClientFixture) {
  const clients = await f.clientsFor(f.workspaceId);
  const created = await f.createClient(clients, {
    name: 'key-revoke',
    kind: 'mcp-project',
    agentIds: [f.agentA],
  });
  const minted = await f.mintKey(created.id, 'single');
  if (minted.kind !== 'created') throw new Error('expected created');
  const revoked = await f
    .directory()
    .forWorkspace(f.workspaceId)
    .revokeApiKey(minted.key.id, new Date());
  expect(revoked).toMatchObject({
    kind: 'revoked',
    key: { endpointScope: { kind: 'mcp-project', clientId: created.id } },
  });
}

async function revokingClientRevokesKeysOnce(f: EndpointClientFixture) {
  const clients = await f.clientsFor(f.workspaceId);
  const created = await f.createClient(clients, {
    name: 'to-revoke',
    kind: 'mcp-project',
    agentIds: [f.agentA],
  });
  const hash = newHash();
  const minted = await f.mintCreatedKey(created.id, 'doomed', 'pfx_doomed', hash);
  expect(await f.directory().authenticateApiKeyHash(hash, new Date())).not.toBeNull();

  const at = new Date();
  const revoked = await clients.revoke(created.id, at);
  expect(revoked?.client.revokedAt).not.toBeNull();
  expect(revoked?.revokedKeys).toEqual([{ id: minted.key.id, name: 'doomed' }]);
  const keyRows = await f.db
    .select({ revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(eq(apiKeys.id, minted.key.id));
  expect(keyRows[0]?.revokedAt).not.toBeNull();
  const principalRows = await f.db
    .select({ revokedAt: workspacePrincipals.revokedAt })
    .from(workspacePrincipals)
    .where(eq(workspacePrincipals.apiKeyId, minted.key.id));
  expect(principalRows[0]?.revokedAt).not.toBeNull();
  expect(await f.directory().authenticateApiKeyHash(hash, new Date())).toBeNull();

  const again = await clients.revoke(created.id, new Date(at.getTime() + 60_000));
  expect(again?.client.revokedAt?.getTime()).toBe(revoked?.client.revokedAt?.getTime());
  expect(again?.revokedKeys).toEqual([]);

  expect(await f.mintKey(created.id, 'late')).toEqual({
    kind: 'endpoint-client-revoked',
    id: created.id,
  });
}

async function refusesToBindKeyAcrossWorkspacesOrToMissingClient(f: EndpointClientFixture) {
  const missing = crypto.randomUUID();
  expect(await f.mintKey(missing, 'ghost')).toEqual({
    kind: 'no-such-endpoint-client',
    id: missing,
  });
  const clients = await f.clientsFor(f.workspaceId);
  const created = await f.createClient(clients, {
    name: 'wrong-tenant',
    kind: 'mcp-project',
    agentIds: [f.agentA],
  });
  const outcome = await f.mintKey(created.id, 'cross', { workspace: f.otherWorkspaceId });
  expect(outcome.kind).toBe('no-such-endpoint-client');
}

async function failsClosedWhenA2aAgentIsGone(f: EndpointClientFixture) {
  const clients = await f.clientsFor(f.workspaceId);
  const doomedAgent = crypto.randomUUID();
  await f.insertAgent(doomedAgent, 'doomed agent');
  const created = await f.createClient(clients, {
    name: 'orphaned',
    kind: 'a2a-agent',
    agentIds: [doomedAgent],
  });
  const hash = newHash();
  await f.mintCreatedKey(created.id, 'orphan key', 'pfx_orphan', hash);
  await f.db.delete(agents).where(eq(agents.id, doomedAgent));
  expect(
    await f.db
      .select()
      .from(endpointClientAgents)
      .where(eq(endpointClientAgents.clientId, created.id)),
  ).toEqual([]);
  expect(await f.directory().authenticateApiKeyHash(hash, new Date())).toBeNull();
}

/** Keys bound to an endpoint client: authentication, revocation and tenancy. */
export function registerBoundKeyCases(f: EndpointClientFixture) {
  it('authenticates a bound key with its endpoint scope and never as a plain principal', () =>
    authenticatesBoundKeyWithEndpointScope(f));
  it('reports the endpoint scope of a key when it is revoked on its own', () =>
    reportsEndpointScopeOnKeyRevocation(f));
  it('revoking the client revokes every bound key and its principal, once', () =>
    revokingClientRevokesKeysOnce(f));
  it('refuses to bind a key to a client of another workspace or one that does not exist', () =>
    refusesToBindKeyAcrossWorkspacesOrToMissingClient(f));
  it('fails closed when the agent of an a2a client is gone', () =>
    failsClosedWhenA2aAgentIsGone(f));
}
