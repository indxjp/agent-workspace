import crypto from 'node:crypto';

import {
  createDatabaseRunRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  agents as agentRows,
  memberships,
  sessions,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { canonicalCall } from '@indx-workspace/contracts/agents';
import { afterAll, beforeAll, describe, expect } from 'vitest';

import type { ApprovalRequest } from '../../ports';
import { callContextOf } from '../../testing/context';
import { describeApprovalConformance, type ApprovalFixture } from './approval.contract';
import { MemoryApproval } from './memory';
import { createApproval } from './production';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

/** The text the gateway stores for an approved `aw-control` call, built without the adapter's own code. */
const gatewayText = (call: ApprovalRequest) =>
  canonicalCall(`mcp__aw-control__${call.tool}`, call.arguments);

describeApprovalConformance('the memory adapter', () => {
  const approvals = new MemoryApproval();
  const workspaceId = crypto.randomUUID();
  return Promise.resolve({
    port: approvals,
    ctx: callContextOf(workspaceId, 'builder', undefined, null, 'run-a'),
    otherRun: callContextOf(workspaceId, 'builder', undefined, null, 'run-b'),
    otherWorkspace: callContextOf(crypto.randomUUID(), 'builder', undefined, null, 'run-a'),
    approve: (ctx, call) => Promise.resolve(approvals.approve(ctx, call)),
  });
});

describeApprovalConformance('the production adapter over a fake run store', () => {
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const rows = new Map<
    string,
    { approvedToolCalls: { toolName: string; canonicalCall: string }[] }
  >();
  const known = new Set<string>([workspaceId, otherWorkspaceId]);
  const port = createApproval({
    scopes: { forWorkspaceId: (id) => Promise.resolve(known.has(id) ? id : null) },
    runs: {
      forScope: (scope) => ({
        get: (runId) => Promise.resolve(rows.get(`${scope}/${runId}`) ?? null),
      }),
    },
  });
  return Promise.resolve({
    port,
    ctx: callContextOf(workspaceId, 'builder', undefined, null, 'run-a'),
    otherRun: callContextOf(workspaceId, 'builder', undefined, null, 'run-b'),
    otherWorkspace: callContextOf(otherWorkspaceId, 'builder', undefined, null, 'run-a'),
    approve: (ctx, call) => {
      const key = `${ctx.workspaceId}/${ctx.runId}`;
      const stored = {
        toolName: `mcp__aw-control__${call.tool}`,
        canonicalCall: gatewayText(call),
      };
      rows.set(key, { approvedToolCalls: [...(rows.get(key)?.approvedToolCalls ?? []), stored] });
      return Promise.resolve();
    },
  });
});

describe.skipIf(!hasDatabase)('ApprovalPort on PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_builder_approval');
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: 'approval', name: 'Approval' },
      { id: otherWorkspaceId, slug: 'other', name: 'Other' },
    ]);
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
    await isolated.db.insert(agentRows).values({
      id: agentId,
      workspaceId,
      name: 'Approval agent',
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
  }, 180_000);

  /** A session never holds two live runs, so every run gets its own. */
  async function newSession(): Promise<string> {
    const id = crypto.randomUUID();
    await isolated.db
      .insert(sessions)
      .values({ id, workspaceId, userId, ownerPrincipalId: principalId, agentId });
    return id;
  }

  afterAll(async () => isolated.close());

  async function postgresFixture(): Promise<ApprovalFixture> {
    const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
    const runs = createDatabaseRunRepositoryProvider(isolated.db);
    const scope = await scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('the fixture workspace resolves');
    const contextOf = (id: string, runId: string) =>
      callContextOf(id, 'builder', principalId, userId, runId);
    const [runA, runB] = [crypto.randomUUID(), crypto.randomUUID()];
    // A run's approvals are written when it is created, so the first run is created by its approval.
    await runs
      .forScope(scope)
      .create({ id: runB, sessionId: await newSession(), engine: 'claude-agent-sdk' });
    return {
      port: createApproval({ scopes, runs }),
      ctx: contextOf(workspaceId, runA),
      otherRun: contextOf(workspaceId, runB),
      otherWorkspace: contextOf(otherWorkspaceId, runA),
      approve: async (ctx, call) => {
        const created = await runs.forScope(scope).create({
          id: ctx.runId,
          sessionId: await newSession(),
          engine: 'claude-agent-sdk',
          approvedToolCalls: [
            { toolName: `mcp__aw-control__${call.tool}`, canonicalCall: gatewayText(call) },
          ],
        });
        expect(created.kind).toBe('created');
      },
    };
  }

  describeApprovalConformance('the production adapter over PostgreSQL', postgresFixture);
});
