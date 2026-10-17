/**
 * `RunRepository.snapshotTools` against a real PostgreSQL (issue #527, S2-02b, ADR-0113 C16).
 *
 * A run's authorised tool connectors are written once, before launch, as a sorted, distinct set of
 * tool-kind connector ids in the run's own workspace. These cases pin what that guarantees: the
 * default is empty, the set is canonical and idempotent, a connector of another workspace, an MCP
 * connector or a malformed id leaves the run unchanged, and an active run's set never changes.
 */
import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { mcpServers } from '../schema/mcp-servers.js';
import { memberships } from '../schema/memberships.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseRunRepositoryProvider, type RunRepository } from './runs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

/** Both are optional on {@link RunRepository}; the database provider implements them. */
type SnapshottingRunRepository = RunRepository &
  Required<Pick<RunRepository, 'snapshotTools' | 'recordToolSandbox'>>;

function hasSnapshotTools(repository: RunRepository): repository is SnapshottingRunRepository {
  return repository.snapshotTools !== undefined && repository.recordToolSandbox !== undefined;
}

function withSnapshotTools(repository: RunRepository): SnapshottingRunRepository {
  if (!hasSnapshotTools(repository)) {
    throw new Error('the database run repository must implement snapshotTools');
  }
  return repository;
}

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn('[repositories/runs-tool-snapshot.test.ts] SKIPPED — TEST_DATABASE_URL is not set.');
}

/** One workspace with an owner principal and a session runs can be created in. */
interface Tenant {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly repository: SnapshottingRunRepository;
}

describe.skipIf(!hasDatabase)('RunRepository.snapshotTools', () => {
  let isolated: IsolatedTestDatabase;
  let tenantA: Tenant;
  let tenantB: Tenant;
  /** Tool connectors in workspace A, created in this order. */
  let openapiA: string;
  let inventoryA: string;
  let mcpA: string;
  let toolB: string;

  async function seedTenant(slug: string): Promise<Tenant> {
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'Tool agent',
      instructions: '',
      ownerPrincipalId: principalId,
      createdBy: userId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    await isolated.db
      .insert(sessions)
      .values({ id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId });
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace did not resolve');
    const repository = withSnapshotTools(
      createDatabaseRunRepositoryProvider(isolated.db).forScope(scope),
    );
    return { workspaceId, principalId, sessionId, repository };
  }

  async function seedConnector(
    tenant: Tenant,
    name: string,
    kind: 'mcp' | 'openapi',
  ): Promise<string> {
    const rows = await isolated.db
      .insert(mcpServers)
      .values(
        kind === 'mcp'
          ? {
              workspaceId: tenant.workspaceId,
              name,
              transport: 'http',
              url: 'https://mcp.example.test/mcp',
              ownerPrincipalId: tenant.principalId,
            }
          : {
              workspaceId: tenant.workspaceId,
              name,
              kind: 'openapi',
              toolConfig: { specUrl: 'https://api.example.test/openapi.json' },
              ownerPrincipalId: tenant.principalId,
            },
      )
      .returning({ id: mcpServers.id });
    const row = rows[0];
    if (row === undefined) throw new Error('fixture connector insert returned no row');
    return row.id;
  }

  async function newRun(tenant: Tenant): Promise<string> {
    const id = crypto.randomUUID();
    await isolated.db
      .insert(runs)
      .values({ id, workspaceId: tenant.workspaceId, sessionId: tenant.sessionId });
    return id;
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_s202b_run_tools');
    tenantA = await seedTenant('run-tools-a');
    tenantB = await seedTenant('run-tools-b');
    openapiA = await seedConnector(tenantA, 'Petstore', 'openapi');
    inventoryA = await seedConnector(tenantA, 'Inventory', 'openapi');
    mcpA = await seedConnector(tenantA, 'GitHub', 'mcp');
    toolB = await seedConnector(tenantB, 'Petstore', 'openapi');
  }, 180_000);

  afterAll(async () => isolated.close());

  it('defaults to an empty set, read back as []', async () => {
    const runId = await newRun(tenantA);
    const run = await tenantA.repository.get(runId);
    expect(run?.toolConnectorIds).toEqual([]);
  });

  it('stores the sorted distinct set, and the same set twice is one set', async () => {
    const runId = await newRun(tenantA);
    const expected = [openapiA, inventoryA].sort();
    await expect(
      tenantA.repository.snapshotTools(runId, [inventoryA, openapiA, inventoryA]),
    ).resolves.toEqual({ kind: 'snapshotted', toolConnectorIds: expected });
    await expect(tenantA.repository.snapshotTools(runId, [openapiA, inventoryA])).resolves.toEqual({
      kind: 'snapshotted',
      toolConnectorIds: expected,
    });
    expect((await tenantA.repository.get(runId))?.toolConnectorIds).toEqual(expected);
  });

  it('collapses duplicates and normalises the case of an id', async () => {
    const runId = await newRun(tenantA);
    await expect(
      tenantA.repository.snapshotTools(runId, [openapiA.toUpperCase(), openapiA, openapiA]),
    ).resolves.toEqual({ kind: 'snapshotted', toolConnectorIds: [openapiA] });
  });

  it("refuses another workspace's connector and an MCP connector, leaving the run unchanged", async () => {
    const runId = await newRun(tenantA);
    await tenantA.repository.snapshotTools(runId, [openapiA]);
    await expect(tenantA.repository.snapshotTools(runId, [openapiA, toolB])).resolves.toEqual({
      kind: 'unknown-connectors',
      connectorIds: [toolB],
    });
    await expect(tenantA.repository.snapshotTools(runId, [mcpA])).resolves.toEqual({
      kind: 'unknown-connectors',
      connectorIds: [mcpA],
    });
    const absent = crypto.randomUUID();
    await expect(tenantA.repository.snapshotTools(runId, [absent])).resolves.toEqual({
      kind: 'unknown-connectors',
      connectorIds: [absent],
    });
    expect((await tenantA.repository.get(runId))?.toolConnectorIds).toEqual([openapiA]);
  });

  it('answers a malformed id as an unknown connector, never a database error', async () => {
    const runId = await newRun(tenantA);
    await expect(
      tenantA.repository.snapshotTools(runId, [openapiA, 'not-a-uuid']),
    ).resolves.toEqual({ kind: 'unknown-connectors', connectorIds: ['not-a-uuid'] });
    expect((await tenantA.repository.get(runId))?.toolConnectorIds).toEqual([]);
  });

  it("does not find another workspace's run", async () => {
    const runInB = await newRun(tenantB);
    await expect(tenantA.repository.snapshotTools(runInB, [openapiA])).resolves.toEqual({
      kind: 'not-found',
    });
    await expect(tenantA.repository.snapshotTools(crypto.randomUUID(), [])).resolves.toEqual({
      kind: 'not-found',
    });
    expect((await tenantB.repository.get(runInB))?.toolConnectorIds).toEqual([]);
  });

  it('never changes the set of a run that has left queued, but accepts a retry of the same set', async () => {
    const runId = await newRun(tenantA);
    await tenantA.repository.snapshotTools(runId, [openapiA]);
    await expect(tenantA.repository.markRunning(runId)).resolves.toMatchObject({ kind: 'moved' });
    await expect(tenantA.repository.snapshotTools(runId, [openapiA, inventoryA])).resolves.toEqual({
      kind: 'not-queued',
    });
    await expect(tenantA.repository.snapshotTools(runId, [])).resolves.toEqual({
      kind: 'not-queued',
    });
    await expect(tenantA.repository.snapshotTools(runId, [openapiA])).resolves.toEqual({
      kind: 'snapshotted',
      toolConnectorIds: [openapiA],
    });
    expect((await tenantA.repository.get(runId))?.toolConnectorIds).toEqual([openapiA]);
  });

  it('accepts a retry of the stored set after launch even when a connector in it was deleted', async () => {
    const doomed = await seedConnector(tenantA, `Doomed ${crypto.randomUUID()}`, 'openapi');
    const runId = await newRun(tenantA);
    await expect(tenantA.repository.snapshotTools(runId, [doomed])).resolves.toEqual({
      kind: 'snapshotted',
      toolConnectorIds: [doomed],
    });
    await expect(tenantA.repository.markRunning(runId)).resolves.toMatchObject({ kind: 'moved' });
    await isolated.db.delete(mcpServers).where(eq(mcpServers.id, doomed));
    await expect(tenantA.repository.snapshotTools(runId, [doomed])).resolves.toEqual({
      kind: 'snapshotted',
      toolConnectorIds: [doomed],
    });
    expect((await tenantA.repository.get(runId))?.toolConnectorIds).toEqual([doomed]);
  });

  it('answers a malformed run id as not-found, never a database error', async () => {
    await expect(tenantA.repository.snapshotTools('not-a-uuid', [])).resolves.toEqual({
      kind: 'not-found',
    });
    await expect(tenantA.repository.snapshotTools('not-a-uuid', [openapiA])).resolves.toEqual({
      kind: 'not-found',
    });
  });

  it('binds any number of connector ids as one parameter, so a huge set is a typed refusal', async () => {
    const runId = await newRun(tenantA);
    const many = Array.from({ length: 70_000 }, () => crypto.randomUUID());
    await expect(tenantA.repository.snapshotTools(runId, [openapiA, ...many])).resolves.toEqual({
      kind: 'unknown-connectors',
      connectorIds: [...many].sort(),
    });
    expect((await tenantA.repository.get(runId))?.toolConnectorIds).toEqual([]);
  });

  it('serialises concurrent snapshots: each is answered, and the stored set is one of them', async () => {
    const runId = await newRun(tenantA);
    const outcomes = await Promise.all([
      tenantA.repository.snapshotTools(runId, [openapiA]),
      tenantA.repository.snapshotTools(runId, [inventoryA]),
    ]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['snapshotted', 'snapshotted']);
    const stored = (await tenantA.repository.get(runId))?.toolConnectorIds;
    expect([[openapiA], [inventoryA]]).toContainEqual(stored);
  });

  it('records the tool sandbox origin while queued, and a retry of it after launch (ADR-0118 TS3)', async () => {
    const runId = await newRun(tenantA);
    expect((await tenantA.repository.get(runId))?.toolSandboxOrigin).toBeNull();
    await expect(
      tenantA.repository.recordToolSandbox(runId, 'http://tool-host:9'),
    ).resolves.toEqual({ kind: 'recorded' });
    await expect(tenantA.repository.markRunning(runId)).resolves.toMatchObject({ kind: 'moved' });
    await expect(
      tenantA.repository.recordToolSandbox(runId, 'http://tool-host:9'),
    ).resolves.toEqual({ kind: 'recorded' });
    await expect(tenantA.repository.recordToolSandbox(runId, 'http://other:9')).resolves.toEqual({
      kind: 'not-queued',
    });
    expect((await tenantA.repository.get(runId))?.toolSandboxOrigin).toBe('http://tool-host:9');
  });

  it("does not record a tool sandbox on another workspace's or a malformed run", async () => {
    const runInB = await newRun(tenantB);
    await expect(tenantA.repository.recordToolSandbox(runInB, 'http://x:1')).resolves.toEqual({
      kind: 'not-found',
    });
    await expect(tenantA.repository.recordToolSandbox('not-a-uuid', 'http://x:1')).resolves.toEqual(
      {
        kind: 'not-found',
      },
    );
    expect((await tenantB.repository.get(runInB))?.toolSandboxOrigin).toBeNull();
  });
});
