/**
 * `POST /api/agents/:id/promote` and `POST /api/agents/:id/rollback` (issue #615) on PostgreSQL:
 * the real routes, real RBAC and the core repository, whose `movePointer` appends each move to
 * `agent_pointer_moves` in the pointer transaction. Proves promote then rollback leaves
 * `production` where it was with the history kept, that a refused audit row leaves no history row,
 * and that another workspace never reads or moves the agent.
 */
import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  agentPointerMoves,
  agents,
  agentVersions,
  auditEvents,
  createDatabaseAgentRepositoryProvider,
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
  AgentPointerMoveResponseSchema,
  AgentVersionListResponseSchema,
} from '@indx-workspace/contracts/agent-versions';

import { POST as promote } from './route';
import { POST as rollback } from '../rollback/route';
import { PUT as point } from '../pointers/route';
import { GET as listVersions, POST as saveVersion } from '../versions/route';
import {
  createRepositoryAgentStoreProvider,
  type AgentStoreProvider,
} from '../../../../../server/agents/store';
import { type WorkspaceResolution } from '../../../../../server/agents/runtime';
import { versionRequest } from '../../../../../server/agent-versions/fixtures';
import { clearApplicationContext } from '../../../../../server/application-context';
import { installTestDomains } from '../../../../../server/application-context-fixtures';
import { promoteAgent, rollbackAgent } from '../../../../../server/agent-versions/pointers';
import {
  createRepositoryAgentVersionStoreProvider,
  type AgentVersionStoreProvider,
} from '../../../../../server/agent-versions/store';
import type { RequestCeiling } from '../../../../../server/policy-ceiling/ceiling';
import { createMemoryDirectory } from '../../../../../server/rbac/memory-directory';
import { Principal } from '../../../../../server/rbac/principal';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[promote.postgres.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so promote and rollback ' +
      'were NOT exercised against the real core repository.',
  );
}

const WORKSPACE_HEADER = 'x-test-workspace';

describe.skipIf(!hasDatabase)('promote and rollback on PostgreSQL (#615)', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const ownerUserId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const ownerPrincipalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  let agentStores: AgentStoreProvider;
  let versionStores: AgentVersionStoreProvider;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_80_08_promote');
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: 'promote', name: 'Promote' },
      { id: otherWorkspaceId, slug: 'promote-other', name: 'Promote other' },
    ]);
    await isolated.db
      .insert(users)
      .values([{ id: ownerUserId, email: `${ownerUserId}@example.test`, name: 'Owner' }]);
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values([{ id: membershipId, workspaceId, userId: ownerUserId, role: 'owner' }]);
      await tx
        .insert(workspacePrincipals)
        .values({ id: ownerPrincipalId, workspaceId, kind: 'membership', membershipId });
    });
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'Support triage',
      instructions: 'Before any version.',
      modelConnectionId: null,
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
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
    const workspaceOf = (request: Request): string =>
      request.headers.get(WORKSPACE_HEADER) ?? workspaceId;
    installTestDomains({
      agents: {
        agents: agentStores,
        resolveWorkspace: (request): Promise<WorkspaceResolution> =>
          Promise.resolve({ kind: 'workspace', workspaceId: workspaceOf(request) }),
      },
    });
    installTestDomains({ agentVersions: { versions: versionStores } });
    installTestDomains({
      rbac: {
        directory: createMemoryDirectory({ users: [] }),
        identify: (request) =>
          Promise.resolve(
            Principal.fromApiKey({
              principalId: ownerPrincipalId,
              apiKeyId: crypto.randomUUID(),
              workspaceId: workspaceOf(request),
              role: 'owner',
              label: 'promote owner key',
            }),
          ),
      },
    });
  }, 180_000);

  afterAll(async () => {
    clearApplicationContext();
    await isolated.close();
  });

  const context = { params: Promise.resolve({ id: agentId }) };

  function request(sub: string, method: string, body: unknown, workspace = workspaceId): Request {
    return new Request(`https://example.invalid/api/agents/${agentId}/${sub}`, {
      method,
      headers: { 'content-type': 'application/json', [WORKSPACE_HEADER]: workspace },
      body: JSON.stringify(body),
    });
  }

  async function moved(response: Response): Promise<unknown> {
    expect(response.status).toBe(200);
    return AgentPointerMoveResponseSchema.parse(await response.json());
  }

  async function historyRows(): Promise<number> {
    return (
      await isolated.db
        .select({ id: agentPointerMoves.id })
        .from(agentPointerMoves)
        .where(eq(agentPointerMoves.agentId, agentId))
    ).length;
  }

  it('promote then rollback leaves production where it was, and keeps the history', async () => {
    for (const instructions of ['Version one.', 'Version two.']) {
      const saved = await saveVersion(
        request('versions', 'POST', versionRequest({ instructions })),
        context,
      );
      expect(saved.status).toBe(201);
    }
    expect(
      (await point(request('pointers', 'PUT', { environment: 'local', version: 1 }), context))
        .status,
    ).toBe(200);
    await expect(moved(await promote(request('promote', 'POST', {}), context))).resolves.toEqual({
      environment: 'production',
      from: null,
      to: 1,
      saved: true,
      bar: null,
    });
    expect(
      (await point(request('pointers', 'PUT', { environment: 'local', version: 2 }), context))
        .status,
    ).toBe(200);
    await expect(
      moved(await promote(request('promote', 'POST', {}), context)),
    ).resolves.toMatchObject({
      from: 1,
      to: 2,
    });
    await expect(moved(await rollback(request('rollback', 'POST', {}), context))).resolves.toEqual({
      environment: 'production',
      from: 2,
      to: 1,
      saved: true,
      bar: null,
    });

    const listed = AgentVersionListResponseSchema.parse(
      await (await listVersions(request('versions', 'GET', undefined), context)).json(),
    );
    expect(listed.pointers.map((row) => [row.environment, row.number])).toEqual([
      ['local', 2],
      ['production', 1],
    ]);
    expect(listed.moves.map((row) => [row.environment, row.number, row.reason])).toEqual([
      ['production', 1, 'rollback'],
      ['production', 2, 'promote'],
      ['local', 2, 'set'],
      ['production', 1, 'promote'],
      ['local', 1, 'set'],
    ]);
  });

  it('leaves no history row when the move’s audit row is refused', async () => {
    const store = await versionStores.forWorkspace(workspaceId);
    const agent = await agentStores.forWorkspace(workspaceId).get(agentId);
    if (store === null || agent === null) throw new Error('the fixture resolves');
    // The rollback above took production back to its first version, so nothing is left to roll
    // back to (BH061-004); promote again so the rollback reaches its audit row.
    await expect(
      moved(await promote(request('promote', 'POST', {}), context)),
    ).resolves.toMatchObject({ from: 1, to: 2 });
    const before = await historyRows();
    await expect(
      rollbackAgent(
        {},
        agent,
        { principalId: crypto.randomUUID(), userId: null, actor: 'a stranger' },
        { store },
      ),
    ).rejects.toThrow();
    expect(await historyRows()).toBe(before);
    // Production goes back to version 1, where the next case expects it.
    expect(
      (await point(request('pointers', 'PUT', { environment: 'production', version: 1 }), context))
        .status,
    ).toBe(200);
  });

  it('refuses a version below the bar with nothing written, and promotes it once it passes (#619)', async () => {
    const store = await versionStores.forWorkspace(workspaceId);
    const agent = await agentStores.forWorkspace(workspaceId).get(agentId);
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (store === null || agent === null || scope === null) throw new Error('the fixture resolves');
    const [version] = await isolated.db
      .select({ id: agentVersions.id })
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.number, 2)));
    if (version === undefined) throw new Error('version 2 is saved');
    const evaluations = createDatabaseAgentVersionEvaluationRepositoryProvider(
      isolated.db,
    ).forScope(scope);
    const evaluate = (results: readonly { name: string; passed: boolean }[]) =>
      evaluations.record({
        versionId: version.id,
        passed: results.filter((result) => result.passed).length,
        total: results.length,
        casesSnapshot: [],
        results: results.map((result) => ({
          ...result,
          runId: null,
          failures: result.passed ? [] : ['contains: refund'],
        })),
        createdByPrincipalId: ownerPrincipalId,
      });
    const ceiling: RequestCeiling = {
      policy: { promotion: { minEvalScore: 1 } },
      deploymentDefaultModel: () => Promise.resolve(null),
      connectorNames: () => Promise.resolve([]),
      recordRefusal: () => Promise.resolve(),
    };
    const actor = { principalId: ownerPrincipalId, userId: null, actor: 'promote owner key' };
    const audits = async (): Promise<number> =>
      (
        await isolated.db
          .select({ id: auditEvents.id })
          .from(auditEvents)
          .where(eq(auditEvents.workspaceId, workspaceId))
      ).length;
    const before = { history: await historyRows(), audits: await audits() };

    await evaluate([
      { name: 'greets', passed: true },
      { name: 'no refund promises', passed: false },
    ]);
    const refused = await promoteAgent({ version: 2 }, agent, actor, { store, ceiling });
    expect(refused).toMatchObject({
      status: 409,
      body: {
        error: {
          code: 'promotion_gate_failed',
          details: ['version:2', 'score:0.5', 'bar:1', 'case:no refund promises'],
        },
      },
    });
    expect({ history: await historyRows(), audits: await audits() }).toEqual(before);

    await evaluate([
      { name: 'greets', passed: true },
      { name: 'no refund promises', passed: true },
    ]);
    await expect(promoteAgent({ version: 2 }, agent, actor, { store, ceiling })).resolves.toEqual({
      status: 200,
      body: { environment: 'production', from: 1, to: 2, saved: true, bar: 1 },
    });

    // The evaluation handler is the column's only writer: a row it did not write throws (`500`).
    await evaluations.record({
      versionId: version.id,
      passed: 1,
      total: 1,
      casesSnapshot: [],
      results: [{ name: 'greets' }],
      createdByPrincipalId: ownerPrincipalId,
    });
    await expect(
      promoteAgent({ version: 2, dryRun: true }, agent, actor, { store, ceiling }),
    ).rejects.toThrow();
  });

  it('answers 404 to another workspace, and lists none of its moves there', async () => {
    const before = await historyRows();
    for (const [route, sub] of [
      [promote, 'promote'],
      [rollback, 'rollback'],
    ] as const) {
      const response = await route(request(sub, 'POST', {}, otherWorkspaceId), context);
      expect(response.status).toBe(404);
    }
    expect(await historyRows()).toBe(before);
    const other = await versionStores.forWorkspace(otherWorkspaceId);
    await expect(other?.listMoves(agentId, null, 10)).resolves.toEqual([]);
  });
});
