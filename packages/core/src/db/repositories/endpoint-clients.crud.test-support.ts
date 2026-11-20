import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import type { EndpointClientFixture } from './endpoint-clients.fixture.test-support.js';

async function createsWithAgentsAndRefusesDuplicateName(f: EndpointClientFixture) {
  const { agentA, agentB } = f;
  const clients = await f.clientsFor(f.workspaceId);
  const created = await clients.create({
    ...f.base,
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
    await clients.create({ ...f.base, name: 'orders', kind: 'mcp-project', agentIds: [agentA] }),
  ).toEqual({ kind: 'name-taken' });
  const sameNameOtherKind = await clients.create({
    ...f.base,
    name: 'orders',
    kind: 'a2a-agent',
    agentIds: [agentA],
  });
  expect(sameNameOtherKind.kind).toBe('created');
}

async function enforcesAgentCountPerKind(f: EndpointClientFixture) {
  const { agentA, agentB } = f;
  const clients = await f.clientsFor(f.workspaceId);
  const attempt = (name: string, kind: 'a2a-agent' | 'mcp-project', agentIds: string[]) =>
    clients.create({ ...f.base, name, kind, agentIds });
  await expect(attempt('two', 'a2a-agent', [agentA, agentB])).rejects.toThrow();
  await expect(attempt('none', 'mcp-project', [])).rejects.toThrow();
  await expect(
    clients.create({
      ...f.base,
      name: 'tools-on-a2a',
      kind: 'a2a-agent',
      agentIds: [agentA],
      toolNames: ['x'],
    }),
  ).rejects.toThrow();
}

async function builderClientTakesNoAgentsOrTools(f: EndpointClientFixture) {
  const clients = await f.clientsFor(f.workspaceId);
  const door = await f.createClient(clients, { name: 'door', kind: 'builder', agentIds: [] });
  expect(door).toMatchObject({ kind: 'builder', agentIds: [], toolNames: null });
  expect((await clients.get(door.id))?.kind).toBe('builder');
  const kept = await clients.update(door.id, { agentIds: [] });
  expect(kept).toMatchObject({ client: { kind: 'builder', agentIds: [] } });
  await expect(clients.update(door.id, { agentIds: [f.agentA] })).rejects.toThrow();

  await expect(
    clients.create({ ...f.base, name: 'with-agent', kind: 'builder', agentIds: [f.agentA] }),
  ).rejects.toThrow();
  await expect(
    clients.create({
      ...f.base,
      name: 'with-tools',
      kind: 'builder',
      agentIds: [],
      toolNames: ['x'],
    }),
  ).rejects.toThrow();
  expect(await clients.findByName('builder', 'with-agent')).toBeNull();
  expect(await clients.findByName('builder', 'with-tools')).toBeNull();
}

async function databaseRefusesBuilderToolNamesAndUnknownKind(f: EndpointClientFixture) {
  expect(await f.rawInsertViolations('builder', '{x}')).toEqual([
    { code: '23514', constraint: 'endpoint_clients_tool_names_mcp_only' },
  ]);
  expect(await f.rawInsertViolations('surface', null)).toEqual([
    { code: '23514', constraint: 'endpoint_clients_kind_valid' },
  ]);
}

async function refusesForeignAgentAndWritesNothing(f: EndpointClientFixture) {
  const clients = await f.clientsFor(f.workspaceId);
  await expect(
    clients.create({
      ...f.base,
      name: 'foreign',
      kind: 'mcp-project',
      agentIds: [f.foreignAgent],
    }),
  ).rejects.toThrow();
  expect(await clients.findByName('mcp-project', 'foreign')).toBeNull();
}

async function hidesClientFromOtherWorkspace(f: EndpointClientFixture) {
  const clients = await f.clientsFor(f.workspaceId);
  const created = await f.createClient(clients, {
    name: 'isolated',
    kind: 'mcp-project',
    agentIds: [f.agentA],
  });
  const other = await f.clientsFor(f.otherWorkspaceId);
  expect(await other.get(created.id)).toBeNull();
  expect(await other.list()).toEqual([]);
  expect(await other.update(created.id, { toolNames: ['x'] })).toEqual({ kind: 'not-found' });
  expect(await other.revoke(created.id, new Date())).toBeNull();
  expect((await clients.get(created.id))?.revokedAt).toBeNull();
}

async function replacesAgentsAndToolsOnUpdate(f: EndpointClientFixture) {
  const { agentA, agentB } = f;
  const clients = await f.clientsFor(f.workspaceId);
  const mcp = await f.createClient(clients, {
    name: 'update-mcp',
    kind: 'mcp-project',
    agentIds: [agentA],
  });
  const a2a = await f.createClient(clients, {
    name: 'update-a2a',
    kind: 'a2a-agent',
    agentIds: [agentA],
  });
  const updated = await clients.update(mcp.id, { agentIds: [agentB], toolNames: ['t'] });
  if (updated.kind !== 'updated') throw new Error('expected updated');
  expect(updated.client.agentIds).toEqual([agentB]);
  expect(updated.client.toolNames).toEqual(['t']);
  expect(updated.client.updatedAt.getTime()).toBeGreaterThanOrEqual(mcp.updatedAt.getTime());
  await expect(clients.update(a2a.id, { agentIds: [agentA, agentB] })).rejects.toThrow();
  await expect(clients.update(a2a.id, { toolNames: ['t'] })).rejects.toThrow();
  expect((await clients.get(a2a.id))?.agentIds).toEqual([agentA]);
}

async function rebindsA2aAgentOnAgentsOnlyPatch(f: EndpointClientFixture) {
  const clients = await f.clientsFor(f.workspaceId);
  const a2a = await f.createClient(clients, {
    name: 'rebind-a2a',
    kind: 'a2a-agent',
    agentIds: [f.agentA],
  });
  const updated = await clients.update(a2a.id, { agentIds: [f.agentB] });
  if (updated.kind !== 'updated') throw new Error('expected updated');
  expect(updated.client.agentIds).toEqual([f.agentB]);
  expect(updated.client.updatedAt.getTime()).toBeGreaterThanOrEqual(a2a.updatedAt.getTime());
}

async function refusesToChangeRevokedClient(f: EndpointClientFixture) {
  const clients = await f.clientsFor(f.workspaceId);
  const created = await f.createClient(clients, {
    name: 'revoked-then-patched',
    kind: 'a2a-agent',
    agentIds: [f.agentA],
  });
  await clients.revoke(created.id, new Date());
  expect(await clients.update(created.id, { agentIds: [f.agentB] })).toEqual({
    kind: 'revoked',
  });
  expect((await clients.get(created.id))?.agentIds).toEqual([f.agentA]);
}

async function deletingAgentRemovesItsRow(f: EndpointClientFixture) {
  const clients = await f.clientsFor(f.workspaceId);
  const disposable = crypto.randomUUID();
  await f.insertAgent(disposable, 'disposable');
  const created = await f.createClient(clients, {
    name: 'cascade',
    kind: 'mcp-project',
    agentIds: [f.agentA, disposable],
  });
  await f.db.delete(agents).where(eq(agents.id, disposable));
  expect((await clients.get(created.id))?.agentIds).toEqual([f.agentA]);
}

/** Create, update, tenancy and constraint behaviour of the repository. */
export function registerClientLifecycleCases(f: EndpointClientFixture) {
  it('creates a client with its agents and refuses a duplicate name per kind', () =>
    createsWithAgentsAndRefusesDuplicateName(f));
  it('enforces the agent count per kind', () => enforcesAgentCountPerKind(f));
  it('creates a builder client with no agent and refuses one with an agent or toolNames', () =>
    builderClientTakesNoAgentsOrTools(f));
  it('the database refuses builder toolNames and an unknown kind by constraint', () =>
    databaseRefusesBuilderToolNamesAndUnknownKind(f));
  it('refuses another workspace agent and writes nothing', () =>
    refusesForeignAgentAndWritesNothing(f));
  it('does not show a client to another workspace', () => hidesClientFromOtherWorkspace(f));
  it('replaces agents and the tool list on update, and keeps the kind rules', () =>
    replacesAgentsAndToolsOnUpdate(f));
  it('rebinds the agent of an a2a client on an agents-only patch', () =>
    rebindsA2aAgentOnAgentsOnlyPatch(f));
  it('refuses to change a revoked client under the row lock', () =>
    refusesToChangeRevokedClient(f));
  it('deleting an agent removes its row from the client', () => deletingAgentRemovesItsRow(f));
}
