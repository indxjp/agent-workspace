/**
 * `PUT /api/agents/:id/pointers` (S1-06, issue #444) on PostgreSQL: the real route, real RBAC
 * decision, the real core repository's one-transaction `applyAndPoint` (S1-04) through the adapter
 * `register.ts` wires, which writes the move's `agent-changed` audit row inside the same
 * transaction (#478). The memory store mirrors the C9 and name-conflict rules; this file proves the
 * real ones roll back the same, and that an audit row the database refuses rolls the move back.
 */
import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  agentVersionPointers,
  agentVersions,
  agents,
  auditEvents,
  createDatabaseAgentRepositoryProvider,
  createDatabaseAgentResourceRepositoryProvider,
  createDatabaseAgentVersionEvaluationRepositoryProvider,
  createDatabaseAgentVersionRepositoryProvider,
  createDatabaseAuditEventRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  mcpServers,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  AgentVersionListResponseSchema,
  AgentVersionResourceSchema,
  SetAgentPointerResponseSchema,
} from '@indx-workspace/contracts/agent-versions';
import {
  AgentResourceAssignmentsResponseSchema,
  AgentResourceSchema,
} from '@indx-workspace/contracts/agents';

import { PUT } from './route';
import { GET as getAgent, PATCH as patchAgent } from '../route';
import { GET as getResources, PUT as putResources } from '../resources/route';
import { GET as listVersions, POST as saveVersion } from '../versions/route';
import { createRepositoryAgentResourceStoreProvider } from '../../../../../server/agents/resource-store';
import {
  createRepositoryAgentStoreProvider,
  type AgentStoreProvider,
} from '../../../../../server/agents/store';
import { type WorkspaceResolution } from '../../../../../server/agents/runtime';
import {
  fixtureSurface,
  versionRequest,
  type FixtureEdits,
} from '../../../../../server/agent-versions/fixtures';
import { clearApplicationContext } from '../../../../../server/application-context';
import { installTestDomains } from '../../../../../server/application-context-fixtures';
import { setAgentPointer } from '../../../../../server/agent-versions/pointers';
import {
  createRepositoryAgentVersionStoreProvider,
  type AgentVersionStoreProvider,
} from '../../../../../server/agent-versions/store';
import { createMemoryDirectory } from '../../../../../server/rbac/memory-directory';
import { Principal } from '../../../../../server/rbac/principal';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[pointers.postgres.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the pointer route ' +
      'was NOT exercised against the real core repository.',
  );
}

const PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

describe.skipIf(!hasDatabase)('PUT /api/agents/:id/pointers on PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const ownerUserId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const ownerPrincipalId = crypto.randomUUID();
  const agentA = crypto.randomUUID();
  const agentB = crypto.randomUUID();
  const agentC = crypto.randomUUID();
  const agentD = crypto.randomUUID();
  const crmId = crypto.randomUUID();
  let agentStores: AgentStoreProvider;
  let versionStores: AgentVersionStoreProvider;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_dj_s1_06_pointers');
    await isolated.db
      .insert(workspaces)
      .values([{ id: workspaceId, slug: 'pointers', name: 'Pointers' }]);
    await isolated.db
      .insert(users)
      .values([{ id: ownerUserId, email: `${ownerUserId}@example.test`, name: 'Owner' }]);
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values([{ id: membershipId, workspaceId, userId: ownerUserId, role: 'owner' }]);
      await tx.insert(workspacePrincipals).values({
        id: ownerPrincipalId,
        workspaceId,
        kind: 'membership',
        membershipId,
      });
    });
    await isolated.db.insert(agents).values(
      [
        { id: agentA, name: 'Support triage' },
        { id: agentB, name: 'Billing' },
        { id: agentC, name: 'Legacy blank' },
        { id: agentD, name: 'Console edited' },
      ].map((row) => ({
        ...row,
        workspaceId,
        instructions: 'Before any version.',
        modelConnectionId: null,
        model: null,
        permissions: PERMISSIONS,
        createdBy: ownerUserId,
        ownerPrincipalId,
      })),
    );
    await isolated.db.insert(mcpServers).values({
      id: crmId,
      workspaceId,
      name: 'crm',
      transport: 'http',
      url: 'https://crm.example.test/mcp',
      createdBy: ownerUserId,
      ownerPrincipalId,
    });

    const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
    agentStores = createRepositoryAgentStoreProvider({
      repositories: createDatabaseAgentRepositoryProvider(isolated.db),
      scopes,
    });
    versionStores = createRepositoryAgentVersionStoreProvider({
      repositories: createDatabaseAgentVersionRepositoryProvider(isolated.db),
      evaluations: createDatabaseAgentVersionEvaluationRepositoryProvider(isolated.db),
      scopes,
    });
    installTestDomains({
      agents: {
        agents: agentStores,
        agentResources: createRepositoryAgentResourceStoreProvider({
          repositories: createDatabaseAgentResourceRepositoryProvider(isolated.db),
          scopes,
        }),
        resolveWorkspace: (): Promise<WorkspaceResolution> =>
          Promise.resolve({ kind: 'workspace', workspaceId }),
      },
    });
    installTestDomains({ agentVersions: { versions: versionStores } });
    installTestDomains({
      audit: {
        scopes,
        repositories: createDatabaseAuditEventRepositoryProvider(isolated.db),
      },
    });
    installTestDomains({
      rbac: {
        directory: createMemoryDirectory({ users: [] }),
        identify: () =>
          Promise.resolve(
            Principal.fromApiKey({
              principalId: ownerPrincipalId,
              apiKeyId: crypto.randomUUID(),
              workspaceId,
              role: 'owner',
              label: 'pointers owner key',
            }),
          ),
      },
    });
  }, 180_000);

  afterAll(async () => {
    clearApplicationContext();
    await isolated.close();
  });

  function context(id: string): { params: Promise<{ id: string }> } {
    return { params: Promise.resolve({ id }) };
  }

  async function save(id: string, edits: FixtureEdits): Promise<number> {
    const response = await saveVersion(
      new Request(`https://example.invalid/api/agents/${id}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(versionRequest(edits)),
      }),
      context(id),
    );
    expect(response.status).toBe(201);
    return AgentVersionResourceSchema.parse(await response.json()).number;
  }

  function point(id: string, version: number): Promise<Response> {
    return PUT(
      new Request(`https://example.invalid/api/agents/${id}/pointers`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ environment: 'local', version }),
      }),
      context(id),
    );
  }

  async function agentRow(id: string): Promise<unknown> {
    const response = await getAgent(
      new Request(`https://example.invalid/api/agents/${id}`),
      context(id),
    );
    return AgentResourceSchema.parse(await response.json());
  }

  async function assignments(id: string): Promise<unknown> {
    const response = await getResources(
      new Request(`https://example.invalid/api/agents/${id}/resources`),
      context(id),
    );
    expect(response.status).toBe(200);
    return AgentResourceAssignmentsResponseSchema.parse(await response.json());
  }

  async function pointerRows(id: string): Promise<number> {
    return (
      await isolated.db
        .select({ id: agentVersionPointers.versionId })
        .from(agentVersionPointers)
        .where(eq(agentVersionPointers.agentId, id))
    ).length;
  }

  async function pointedVersion(id: string): Promise<readonly string[]> {
    return (
      await isolated.db
        .select({ versionId: agentVersionPointers.versionId })
        .from(agentVersionPointers)
        .where(eq(agentVersionPointers.agentId, id))
    ).map((row) => row.versionId);
  }

  async function agentChangedCount(id: string): Promise<number> {
    return (
      await isolated.db
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(and(eq(auditEvents.action, 'agent-changed'), eq(auditEvents.subjectId, id)))
    ).length;
  }

  it('materialises version 1 onto the row and its assignments, and records one audit row', async () => {
    await save(agentA, {
      instructions: 'Version one.',
      resources: { connectors: ['crm'] },
    });
    await save(agentA, { instructions: 'Version two.' });

    const response = await point(agentA, 1);
    expect(response.status).toBe(200);
    const body = SetAgentPointerResponseSchema.parse(await response.json());
    expect(body.pointer).toMatchObject({ environment: 'local', number: 1 });

    expect(await agentRow(agentA)).toMatchObject({ instructions: 'Version one.' });
    const listed = await listVersions(
      new Request(`https://example.invalid/api/agents/${agentA}/versions`),
      context(agentA),
    );
    // The row was written from version 1, so `aw push` reads it as unedited (issue #613).
    expect(AgentVersionListResponseSchema.parse(await listed.json()).materialised).toBe(1);
    expect(await assignments(agentA)).toMatchObject({
      assignments: { connectorIds: [crmId], skillIds: [], files: [] },
    });
    const audits = await isolated.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'agent-changed'), eq(auditEvents.subjectId, agentA)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorPrincipalId: ownerPrincipalId,
      actorLabel: 'pointers owner key',
      subjectLabel: 'Support triage: local -> version 1',
    });
  });

  it('answers 404 agent_version_not_found for a number the agent does not have', async () => {
    const response = await point(agentA, 99);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'agent_version_not_found', details: ['version:99'] },
    });
  });

  it('refuses a second agent serving the same surface (C9) and rolls its row back', async () => {
    const withMain = await save(agentA, {
      instructions: 'Version three, serving main.',
      surfaces: [fixtureSurface('main')],
    });
    expect((await point(agentA, withMain)).status).toBe(200);

    const bVersion = await save(agentB, {
      name: 'Billing',
      instructions: 'Billing would serve main too.',
      resources: { connectors: ['crm'] },
      surfaces: [fixtureSurface('main', 'Billing')],
    });
    const rowBefore = await agentRow(agentB);
    const assignmentsBefore = await assignments(agentB);

    const response = await point(agentB, bVersion);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'surface_name_taken', details: ['surface:main'] },
    });
    expect(await agentRow(agentB)).toEqual(rowBefore);
    expect(await assignments(agentB)).toEqual(assignmentsBefore);
    expect(await pointerRows(agentB)).toBe(0);
  });

  it("answers 409 agent_name_conflict when the version's agent name is another agent's", async () => {
    const renamed = await save(agentB, { name: 'Support triage' });
    const response = await point(agentB, renamed);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'agent_name_conflict' } });
    expect(await agentRow(agentB)).toMatchObject({ name: 'Billing' });
  });

  it('refuses 400 a stored version whose agent name is blank, rather than failing the update (500)', async () => {
    // A version saved before the pipeline refused blank names; the save route now refuses one, so
    // the row is written directly.
    await isolated.db.insert(agentVersions).values({
      workspaceId,
      agentId: agentC,
      number: 1,
      summary: 'Blank name',
      via: 'api',
      body: versionRequest({ name: '   ' }).body,
      createdByPrincipalId: ownerPrincipalId,
    });
    const response = await point(agentC, 1);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'invalid_agent_version',
        details: ['body.definition.agent.name: must not be blank'],
      },
    });
    expect(await agentRow(agentC)).toMatchObject({ name: 'Legacy blank' });
    expect(await pointerRows(agentC)).toBe(0);
  });

  it('saves a console PATCH and resources PUT as ui versions and points local (issue #616)', async () => {
    expect((await point(agentD, await save(agentD, { name: 'Console edited' }))).status).toBe(200);
    const auditsBefore = await agentChangedCount(agentD);
    const listing = async () =>
      AgentVersionListResponseSchema.parse(
        await (
          await listVersions(
            new Request(`https://example.invalid/api/agents/${agentD}/versions`),
            context(agentD),
          )
        ).json(),
      );

    const patched = await patchAgent(
      new Request(`https://example.invalid/api/agents/${agentD}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instructions: 'Edited in the console.' }),
      }),
      context(agentD),
    );
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect(AgentResourceSchema.parse(await patched.json())).toMatchObject({
      instructions: 'Edited in the console.',
    });
    const afterPatch = await listing();
    expect(afterPatch.items.map((item) => [item.number, item.via])).toEqual([
      [1, 'api'],
      [2, 'ui'],
    ]);
    expect(afterPatch.pointers).toMatchObject([{ environment: 'local', number: 2 }]);
    expect(afterPatch.materialised).toBe(2);
    expect(await agentChangedCount(agentD)).toBe(auditsBefore + 1);

    const assigned = await putResources(
      new Request(`https://example.invalid/api/agents/${agentD}/resources`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: [], skillIds: [], connectorIds: [crmId] }),
      }),
      context(agentD),
    );
    expect(assigned.status, await assigned.clone().text()).toBe(200);
    expect(await assigned.json()).toEqual({
      assignments: { files: [], skillIds: [], connectorIds: [crmId], storageGrants: [] },
    });
    const afterPut = await listing();
    expect(afterPut.items[2]).toMatchObject({
      number: 3,
      via: 'ui',
      body: {
        definition: {
          agent: { instructions: 'Edited in the console.' },
          resources: { connectors: ['crm'] },
        },
      },
    });
    expect(afterPut.materialised).toBe(3);
  });

  it('rolls the whole move back when the audit row is refused (#478 regression)', async () => {
    const agents = agentStores.forWorkspace(workspaceId);
    const store = await versionStores.forWorkspace(workspaceId);
    if (store === null) throw new Error('the workspace resolves');
    const agent = await agents.get(agentA);
    if (agent === null) throw new Error('agent A exists');
    const rowBefore = await agentRow(agentA);
    const assignmentsBefore = await assignments(agentA);
    const pointerBefore = await pointedVersion(agentA);
    const auditsBefore = await agentChangedCount(agentA);
    expect(pointerBefore).toHaveLength(1);

    // Version 2 applies cleanly on its own; only the actor is wrong. A principal id that is not one
    // of this workspace's fails `audit_events_actor_principal_workspace_fk` inside the transaction.
    await expect(
      setAgentPointer(
        { environment: 'local', version: 2 },
        agent,
        { principalId: crypto.randomUUID(), userId: null, actor: 'a stranger' },
        { store },
      ),
    ).rejects.toThrow();

    expect(await agentRow(agentA)).toEqual(rowBefore);
    expect(await assignments(agentA)).toEqual(assignmentsBefore);
    expect(await pointedVersion(agentA)).toEqual(pointerBefore);
    expect(await agentChangedCount(agentA)).toBe(auditsBefore);

    // The same move by a principal of the workspace applies and records one more row.
    const moved = await setAgentPointer(
      { environment: 'local', version: 2 },
      agent,
      { principalId: ownerPrincipalId, userId: ownerUserId, actor: 'pointers owner key' },
      { store },
    );
    expect(moved.status).toBe(200);
    expect(await agentRow(agentA)).toMatchObject({ instructions: 'Version two.' });
    expect(await agentChangedCount(agentA)).toBe(auditsBefore + 1);
  });
});
