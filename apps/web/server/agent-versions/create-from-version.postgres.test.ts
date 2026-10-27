/**
 * `POST /api/agents {version, dryRun?}` (S1-06, issue #444) on PostgreSQL: the real route, real
 * RBAC, and core's one-transaction `createAgentWithFirstVersion` (S1-04) through the adapter
 * `register.ts` wires. A refused create leaves no agent row; the legacy form still creates one.
 */
import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  agents,
  createDatabaseAgentRepositoryProvider,
  createDatabaseAgentResourceRepositoryProvider,
  createDatabaseAgentVersionEvaluationRepositoryProvider,
  createDatabaseAgentVersionRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  AgentVersionListResponseSchema,
  CreateAgentFromVersionResponseSchema,
} from '@indx-workspace/contracts/agent-versions';

import { POST } from '../../app/api/agents/route';
import { GET as listVersions } from '../../app/api/agents/[id]/versions/route';
import { createRepositoryAgentResourceStoreProvider } from '../agents/resource-store';
import { createRepositoryAgentStoreProvider } from '../agents/store';
import { type WorkspaceResolution } from '../agents/runtime';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { FIXTURE_PERMISSIONS, fixtureSurface, fromVersionRequest } from './fixtures';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createRepositoryAgentVersionStoreProvider } from './store';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[create-from-version.postgres.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so ' +
      'create-from-version was NOT exercised against the real core repository.',
  );
}

describe.skipIf(!hasDatabase)('POST /api/agents {version} on PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const ownerUserId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const ownerPrincipalId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_dj_s1_06_create');
    await isolated.db
      .insert(workspaces)
      .values([{ id: workspaceId, slug: 'create-from-version', name: 'Create' }]);
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

    const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
    installTestDomains({
      agents: {
        agents: createRepositoryAgentStoreProvider({
          repositories: createDatabaseAgentRepositoryProvider(isolated.db),
          scopes,
        }),
        agentResources: createRepositoryAgentResourceStoreProvider({
          repositories: createDatabaseAgentResourceRepositoryProvider(isolated.db),
          scopes,
        }),
        resolveWorkspace: (): Promise<WorkspaceResolution> =>
          Promise.resolve({ kind: 'workspace', workspaceId }),
      },
    });
    installTestDomains({
      agentVersions: {
        versions: createRepositoryAgentVersionStoreProvider({
          repositories: createDatabaseAgentVersionRepositoryProvider(isolated.db),
          evaluations: createDatabaseAgentVersionEvaluationRepositoryProvider(isolated.db),
          scopes,
        }),
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
              label: 'create owner key',
            }),
          ),
      },
    });
  }, 180_000);

  afterAll(async () => {
    clearApplicationContext();
    await isolated.close();
  });

  function post(body: unknown): Promise<Response> {
    return POST(
      new Request('https://example.invalid/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  async function agentNames(): Promise<string[]> {
    const rows = await isolated.db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId));
    return rows.map((row) => row.name).sort();
  }

  it('creates the agent with version 1 and points local at it', async () => {
    const response = await post(
      fromVersionRequest({ name: 'Front desk', surfaces: [fixtureSurface('main', 'Front desk')] }),
    );
    expect(response.status).toBe(201);
    const body = CreateAgentFromVersionResponseSchema.parse(await response.json());
    expect(body.agent).toMatchObject({ name: 'Front desk', ownerPrincipalId, createdBy: null });
    expect(body.version).toMatchObject({ number: 1, createdByPrincipalId: ownerPrincipalId });

    const listed = await listVersions(
      new Request(`https://example.invalid/api/agents/${body.agent.id}/versions`),
      { params: Promise.resolve({ id: body.agent.id }) },
    );
    const listing = AgentVersionListResponseSchema.parse(await listed.json());
    expect(listing.items.map((item) => item.number)).toEqual([1]);
    expect(listing.pointers).toMatchObject([{ environment: 'local', number: 1 }]);
  });

  it('answers a dry run with {ok: true, number: 1} and creates no row', async () => {
    const before = await agentNames();
    const response = await post(fromVersionRequest({ name: 'Dry run only', dryRun: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, number: 1 });
    expect(await agentNames()).toEqual(before);
  });

  it('leaves no agent row behind a pipeline refusal', async () => {
    const before = await agentNames();
    const response = await post(
      fromVersionRequest({ name: 'Missing skill', resources: { skills: ['triage'] } }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: 'agent_definition_references_missing', details: ['skill:triage'] },
    });
    expect(await agentNames()).toEqual(before);
  });

  it('refuses a surface another agent serves (C9) in a dry run and a save, and rolls back', async () => {
    const before = await agentNames();
    const body = fromVersionRequest({
      name: 'Second desk',
      surfaces: [fixtureSurface('main', 'Second desk')],
    });
    const dryRun = await post({ ...body, dryRun: true });
    const save = await post(body);
    expect(dryRun.status).toBe(409);
    const dryRunBody: unknown = await dryRun.json();
    expect(dryRunBody).toMatchObject({
      error: { code: 'surface_name_taken', details: ['surface:main'] },
    });
    expect(save.status).toBe(409);
    expect(await save.json()).toEqual(dryRunBody);
    expect(await agentNames()).toEqual(before);
  });

  it('answers 409 agent_name_conflict in a dry run and a save', async () => {
    const body = fromVersionRequest({ name: 'Front desk' });
    const dryRun = await post({ ...body, dryRun: true });
    const save = await post(body);
    expect(dryRun.status).toBe(409);
    const dryRunBody: unknown = await dryRun.json();
    expect(dryRunBody).toMatchObject({ error: { code: 'agent_name_conflict' } });
    expect(save.status).toBe(409);
    expect(await save.json()).toEqual(dryRunBody);
  });

  it('still creates an agent from the legacy body', async () => {
    const response = await post({
      name: 'Legacy agent',
      instructions: 'Made the old way.',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    });
    expect(response.status).toBe(201);
    expect(await agentNames()).toContain('Legacy agent');
  });

  it('answers the same 400 to a dry run and a save of a blank agent name (C8), and writes nothing', async () => {
    for (const name of ['   ', '\t']) {
      const before = await agentNames();
      const body = fromVersionRequest({ name });
      const dryRun = await post({ ...body, dryRun: true });
      const save = await post(body);
      expect(dryRun.status).toBe(400);
      const dryRunBody: unknown = await dryRun.json();
      expect(dryRunBody).toMatchObject({
        error: {
          code: 'invalid_agent_version',
          details: ['version.body.definition.agent.name: must not be blank'],
        },
      });
      expect(save.status).toBe(400);
      expect(await save.json()).toEqual(dryRunBody);
      expect(await agentNames()).toEqual(before);
    }
  });

  it('names the same surface in a dry run and a save when several are taken (C8)', async () => {
    const owner = await post(
      fromVersionRequest({
        name: 'Surface owner',
        surfaces: [
          fixtureSurface('alpha', 'Surface owner'),
          fixtureSurface('zeta', 'Surface owner'),
        ],
      }),
    );
    expect(owner.status).toBe(201);
    const before = await agentNames();
    // Body order differs from every collation order: core's C9 query alone would name alpha.
    const body = fromVersionRequest({
      name: 'Late desk',
      surfaces: [fixtureSurface('zeta', 'Late desk'), fixtureSurface('alpha', 'Late desk')],
    });
    const dryRun = await post({ ...body, dryRun: true });
    const save = await post(body);
    expect(dryRun.status).toBe(409);
    const dryRunBody: unknown = await dryRun.json();
    expect(dryRunBody).toMatchObject({
      error: { code: 'surface_name_taken', details: ['surface:zeta'] },
    });
    expect(save.status).toBe(409);
    expect(await save.json()).toEqual(dryRunBody);
    expect(await agentNames()).toEqual(before);
  });
});
