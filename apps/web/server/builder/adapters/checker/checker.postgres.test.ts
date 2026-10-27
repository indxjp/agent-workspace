/**
 * `CheckerPort` on PostgreSQL: a draft check runs the real pipeline over core's repositories and
 * writes no agent, version, pointer or audit row, for a new draft and for an existing agent.
 */
import crypto from 'node:crypto';

import {
  agentVersionPointers,
  agentVersions,
  agents,
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_DOOR } from '../../testing/context';
import { createAgentFromVersion } from '../../../agent-versions/create-from-version';
import { fromVersionRequest } from '../../../agent-versions/fixtures';
import { createRepositoryAgentVersionStoreProvider } from '../../../agent-versions/store';
import { createRepositoryAgentStoreProvider } from '../../../agents/store';
import type { CallContext } from '../../ports';
import { draftBody } from './checker.contract';
import { createChecker } from './production';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('CheckerPort on PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  let agentId = '';

  const ctx: CallContext = {
    workspaceId,
    door: TEST_DOOR,
    runId: 'run-pg',
    traceId: 'trace-1',
    modelId: 'model-1',
    promptVersion: 'prompt-1',
    caller: {
      kind: 'person',
      principal: {
        workspaceId,
        principalId,
        ownerPrincipalId: principalId,
        userId,
        role: 'builder',
      },
    },
  };

  const scopes = () => createDatabaseWorkspaceScopeResolver(isolated.db);
  const agentStores = () =>
    createRepositoryAgentStoreProvider({
      repositories: createDatabaseAgentRepositoryProvider(isolated.db),
      scopes: scopes(),
    });
  const versionStores = () =>
    createRepositoryAgentVersionStoreProvider({
      repositories: createDatabaseAgentVersionRepositoryProvider(isolated.db),
      evaluations: createDatabaseAgentVersionEvaluationRepositoryProvider(isolated.db),
      scopes: scopes(),
    });
  const checker = () =>
    createChecker({ agents: agentStores(), versions: versionStores(), pipeline: () => ({}) });

  async function rowCounts() {
    return {
      agents: await isolated.db.$count(agents),
      versions: await isolated.db.$count(agentVersions),
      pointers: await isolated.db.$count(agentVersionPointers),
      audits: await isolated.db.$count(auditEvents),
    };
  }

  /** Each pointer's target, so a pointer moved in place shows even when the counts stay put. */
  async function pointerRows() {
    const rows = await isolated.db
      .select({
        agentId: agentVersionPointers.agentId,
        environment: agentVersionPointers.environment,
        versionId: agentVersionPointers.versionId,
      })
      .from(agentVersionPointers);
    return rows.sort((a, b) =>
      `${a.agentId}/${a.environment}`.localeCompare(`${b.agentId}/${b.environment}`),
    );
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_builder_checker');
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: 'checker', name: 'Checker' });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'M' });
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, workspaceId, userId, role: 'builder' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    const store = await versionStores().forWorkspace(workspaceId);
    if (store === null) throw new Error('the workspace exists');
    const created = await createAgentFromVersion(
      fromVersionRequest({ name: 'Existing' }),
      { principalId, ownerPrincipalId: principalId, userId, actorLabel: 'seed' },
      { store, agents: agentStores().forWorkspace(workspaceId) },
    );
    expect(created.status).toBe(201);
    agentId = (await isolated.db.select({ id: agents.id }).from(agents))[0]?.id ?? '';
  }, 180_000);

  afterAll(async () => isolated.close());

  it('writes no row for a new draft, an existing agent, or a refused draft', async () => {
    const before = await rowCounts();
    expect(before).toMatchObject({ agents: 1, versions: 1, pointers: 1 });
    const pointersBefore = await pointerRows();

    expect(await checker().check(ctx, undefined, draftBody('Draft agent'))).toEqual({
      ok: true,
      number: 1,
    });
    expect(await checker().check(ctx, agentId, draftBody('Existing'))).toEqual({
      ok: true,
      number: 2,
    });
    expect(await checker().check(ctx, undefined, draftBody('Draft agent', ['erp']))).toMatchObject({
      ok: false,
      code: 'agent_definition_references_missing',
      details: ['connector:erp'],
    });

    expect(await rowCounts()).toEqual(before);
    expect(await pointerRows()).toEqual(pointersBefore);
  });
});
