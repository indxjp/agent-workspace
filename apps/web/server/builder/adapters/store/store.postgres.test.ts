import crypto from 'node:crypto';

import {
  agents as agentRows,
  agentVersionPointers,
  agentVersions,
  auditEvents as auditEventRows,
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
import { AgentCreatedAuditDetailsSchema } from '@indx-workspace/contracts/observability';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createRepositoryAgentVersionStoreProvider,
  type AgentVersionStoreProvider,
} from '../../../agent-versions/store';
import { createRepositoryAgentStoreProvider } from '../../../agents/store';
import { log } from '../../../telemetry/logger';
import { startOfUtcDay } from '../../core/facts';
import { handleToolCall } from '../../shell';
import { callContextOf } from '../../testing/context';
import { makeMemoryPorts } from '../../testing/ports';
import { MemoryApproval } from '../approval/memory';
import { MemoryAudit } from '../audit/memory';
import { draftBody } from '../checker/checker.contract';
import { createAgentStore } from './production';
import { describeAgentStoreConformance, type StoreFixture } from './store.contract';

import { productionFixture } from './production.test-support';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

let isolated: IsolatedTestDatabase;

const workspaceId = crypto.randomUUID();

const otherWorkspaceId = crypto.randomUUID();

const userId = crypto.randomUUID();

const membershipId = crypto.randomUUID();

const principalId = crypto.randomUUID();

function postgresFixture(): StoreFixture {
  const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
  const agents = createRepositoryAgentStoreProvider({
    repositories: createDatabaseAgentRepositoryProvider(isolated.db),
    scopes,
  });
  const versions = createRepositoryAgentVersionStoreProvider({
    repositories: createDatabaseAgentVersionRepositoryProvider(isolated.db),
    evaluations: createDatabaseAgentVersionEvaluationRepositoryProvider(isolated.db),
    scopes,
  });
  return productionFixture({
    agents: agents,
    versions: versions,
    person: { workspaceId, otherWorkspaceId, principalId, userId },
    markBuiltin: async (agentId) => {
      await isolated.db
        .update(agentRows)
        .set({ builtinKey: 'builder' })
        .where(eq(agentRows.id, agentId));
    },
    auditEvents: async (agentId) =>
      (
        await isolated.db
          .select()
          .from(auditEventRows)
          .where(
            and(eq(auditEventRows.subjectId, agentId), eq(auditEventRows.action, 'agent-created')),
          )
      ).map((row) => ({
        action: row.action,
        subjectId: row.subjectId ?? '',
        subjectLabel: row.subjectLabel ?? '',
        actorPrincipalId: row.actorPrincipalId ?? '',
        actorUserId: row.actorUserId,
        actorLabel: row.actorLabel,
        details: AgentCreatedAuditDetailsSchema.nullable().parse(row.details),
      })),
  });
}

describe.skipIf(!hasDatabase)('AgentStorePort on PostgreSQL', () => {
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_builder_store');
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: 'store', name: 'Store' },
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
  }, 180_000);

  afterAll(async () => isolated.close());

  describeAgentStoreConformance('the production adapter over PostgreSQL', () =>
    Promise.resolve(postgresFixture()),
  );

  it(
    'rolls a save back whole when its agent-created row is refused, and journals an error',
    rollsSaveBackWholeWhenAgentCreated,
  );

  it(
    'refuses a save as agent_archived when an archive commits after its version is written, and moves no pointer',
    refusesSaveAgentArchivedWhenArchiveCommits,
  );

  it(
    "writes the creating agent, its version and the run on an agent-made agent, and nothing on a person's",
    writesCreatingAgentVersionRunAgentMade,
  );

  it(
    'answers a creating agent that is not in the workspace with agent_not_found, and writes nothing',
    answersCreatingAgentThatIsNotWorkspace,
  );

  it(
    'answers a creating agent of another workspace with agent_not_found, on the tenant-paired foreign key',
    answersCreatingAgentAnotherWorkspaceAgentNot,
  );

  it(
    'lets exactly one of two concurrent creations win at the limit',
    letsExactlyOneTwoConcurrentCreationsWin,
  );

  // Only PostgreSQL serialises the version store's check-then-write, so only it can promise this.
  it(
    'lets exactly one of two concurrent saves from the same base win',
    letsExactlyOneTwoConcurrentSavesSame,
  );
});

async function rollsSaveBackWholeWhenAgentCreated() {
  const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
  const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
  const port = createAgentStore({
    agents: createRepositoryAgentStoreProvider({
      repositories: createDatabaseAgentRepositoryProvider(isolated.db),
      scopes,
    }),
    versions: createRepositoryAgentVersionStoreProvider({
      repositories: createDatabaseAgentVersionRepositoryProvider(isolated.db),
      evaluations: createDatabaseAgentVersionEvaluationRepositoryProvider(isolated.db),
      scopes,
    }),
    pipeline: () => ({}),
    // A blank label is refused by audit_events_actor_label_not_blank, after the version is written.
    actorLabel: () => Promise.resolve('   '),
  });
  const counts = async () => ({
    agents: await isolated.db.$count(agentRows),
    versions: await isolated.db.$count(agentVersions),
    pointers: await isolated.db.$count(agentVersionPointers),
    audits: await isolated.db.$count(auditEventRows),
  });
  const approval = new MemoryApproval();
  const audit = new MemoryAudit();
  const journaled = vi.spyOn(audit, 'record');
  const ctx = callContextOf(workspaceId, 'builder', principalId, userId);
  const args = { body: draftBody('rolled-back') };
  approval.approve(ctx, { tool: 'draft_save', arguments: args });
  const before = await counts();

  const result = await handleToolCall(
    { name: 'draft_save', arguments: args, callId: 'c-1' },
    ctx,
    makeMemoryPorts({ approval, audit, store: port }),
  );

  expect(result).toMatchObject({ ok: false, code: 'internal_error' });
  expect(journaled.mock.calls.find(([, entry]) => entry.callId === 'c-1')?.[1].outcome).toBe(
    'error',
  );
  expect(await counts()).toEqual(before);
  error.mockRestore();
}

async function refusesSaveAgentArchivedWhenArchiveCommits() {
  const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
  const real = createRepositoryAgentVersionStoreProvider({
    repositories: createDatabaseAgentVersionRepositoryProvider(isolated.db),
    evaluations: createDatabaseAgentVersionEvaluationRepositoryProvider(isolated.db),
    scopes,
  });
  let archiveOnPointer: string | null = null;
  // Archives the agent between the save's pre-lock reads and the locked pointer move.
  const racing: AgentVersionStoreProvider = {
    async forWorkspace(id) {
      const store = await real.forWorkspace(id);
      if (store === null) return null;
      return {
        ...store,
        applyAndPoint: async (agentId, input) => {
          if (agentId === archiveOnPointer) {
            await isolated.db
              .update(agentRows)
              .set({ archivedAt: new Date() })
              .where(eq(agentRows.id, agentId));
          }
          return store.applyAndPoint(agentId, input);
        },
      };
    },
  };
  const port = createAgentStore({
    agents: createRepositoryAgentStoreProvider({
      repositories: createDatabaseAgentRepositoryProvider(isolated.db),
      scopes,
    }),
    versions: racing,
    pipeline: () => ({}),
    actorLabel: (_workspaceId, id) => Promise.resolve(id),
  });
  const ctx = callContextOf(workspaceId, 'builder', principalId, userId);
  const made = await port.save(ctx, { body: draftBody('racing') });
  if (!made.ok) throw new Error(`the first save failed: ${made.code}`);
  const pointers = () =>
    isolated.db
      .select({ versionId: agentVersionPointers.versionId })
      .from(agentVersionPointers)
      .where(eq(agentVersionPointers.agentId, made.agentId));
  const pointersBefore = await pointers();

  archiveOnPointer = made.agentId;
  const result = await port.save(ctx, {
    agentId: made.agentId,
    baseVersion: made.version,
    body: draftBody('racing, edited'),
  });

  expect(result).toMatchObject({ ok: false, code: 'agent_archived' });
  expect(await pointers()).toEqual(pointersBefore);
  const [row] = await isolated.db.select().from(agentRows).where(eq(agentRows.id, made.agentId));
  // The row is `local`'s working copy: the refused move must not have renamed it.
  expect(row?.name).toBe('racing');
}

async function writesCreatingAgentVersionRunAgentMade() {
  const { port, ctx } = postgresFixture();
  const made = await port.save(ctx, { body: draftBody('creator') });
  if (!made.ok) throw new Error(`the creator save failed: ${made.code}`);
  const byAgent = await port.save(ctx, {
    body: draftBody('child'),
    createdByAgent: { agentId: made.agentId, version: 1 },
  });
  const byPerson = await port.save(ctx, { body: draftBody('sibling') });
  if (!byAgent.ok || !byPerson.ok) throw new Error('the saves failed');

  const lineage = async (agentId: string) =>
    (await isolated.db.select().from(agentRows).where(eq(agentRows.id, agentId)))[0];
  expect(await lineage(byAgent.agentId)).toMatchObject({
    createdByAgentId: made.agentId,
    createdByAgentVersion: 1,
    createdByRunId: ctx.runId,
  });
  const created = async (agentId: string) =>
    (
      await isolated.db
        .select({ details: auditEventRows.details })
        .from(auditEventRows)
        .where(
          and(eq(auditEventRows.subjectId, agentId), eq(auditEventRows.action, 'agent-created')),
        )
    ).map((row) => AgentCreatedAuditDetailsSchema.nullable().parse(row.details));
  expect(await created(byAgent.agentId)).toEqual([
    expect.objectContaining({ builderRunId: ctx.runId, createdByAgentId: made.agentId }),
  ]);
  expect((await created(byPerson.agentId)).map((details) => details?.createdByAgentId)).toEqual([
    undefined,
  ]);
  expect(await lineage(byPerson.agentId)).toMatchObject({
    createdByAgentId: null,
    createdByAgentVersion: null,
    createdByRunId: null,
  });
}

async function answersCreatingAgentThatIsNotWorkspace() {
  const { port, ctx } = postgresFixture();
  const before = await isolated.db.$count(agentRows);

  const result = await port.save(ctx, {
    body: draftBody('orphan'),
    createdByAgent: { agentId: crypto.randomUUID(), version: 1 },
  });

  expect(result).toMatchObject({ ok: false, code: 'agent_not_found' });
  expect(await isolated.db.$count(agentRows)).toBe(before);
}

async function answersCreatingAgentAnotherWorkspaceAgentNot() {
  const { port, ctx } = postgresFixture();
  const foreignUser = crypto.randomUUID();
  const foreignMembership = crypto.randomUUID();
  const foreignPrincipal = crypto.randomUUID();
  await isolated.db
    .insert(users)
    .values({ id: foreignUser, email: `${foreignUser}@example.test`, name: 'F' });
  await isolated.db.transaction(async (tx) => {
    await tx.insert(memberships).values({
      id: foreignMembership,
      workspaceId: otherWorkspaceId,
      userId: foreignUser,
      role: 'builder',
    });
    await tx.insert(workspacePrincipals).values({
      id: foreignPrincipal,
      workspaceId: otherWorkspaceId,
      kind: 'membership',
      membershipId: foreignMembership,
    });
  });
  const [foreign] = await isolated.db
    .insert(agentRows)
    .values({
      workspaceId: otherWorkspaceId,
      name: 'foreign-creator',
      instructions: '',
      permissions: {
        readFiles: false,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      ownerPrincipalId: foreignPrincipal,
      createdBy: foreignUser,
    })
    .returning({ id: agentRows.id });
  const before = await isolated.db.$count(agentRows);

  const result = await port.save(ctx, {
    body: draftBody('stolen-lineage'),
    createdByAgent: { agentId: foreign?.id ?? '', version: 1 },
  });

  expect(result).toMatchObject({ ok: false, code: 'agent_not_found' });
  expect(await isolated.db.$count(agentRows)).toBe(before);
}

async function letsExactlyOneTwoConcurrentCreationsWin() {
  const { port, ctx } = postgresFixture();
  const today = startOfUtcDay(new Date());
  const base = await port.creationsSince(ctx, today);
  const quota = { since: today, limit: base + 1 };

  const results = await Promise.all([
    port.save(ctx, { body: draftBody(`race-${crypto.randomUUID().slice(0, 8)}`), quota }),
    port.save(ctx, { body: draftBody(`race-${crypto.randomUUID().slice(0, 8)}`), quota }),
  ]);

  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toEqual([
    expect.objectContaining({ code: 'quota_exceeded' }),
  ]);
  expect(await port.creationsSince(ctx, today)).toBe(base + 1);
}

async function letsExactlyOneTwoConcurrentSavesSame() {
  const { port, ctx } = postgresFixture();
  const body = draftBody('concurrent');
  const created = await port.save(ctx, { body });
  if (!created.ok) throw new Error(`the first save failed: ${created.code}`);
  const { agentId } = created;
  const results = await Promise.all([
    port.save(ctx, { agentId, baseVersion: 1, body }),
    port.save(ctx, { agentId, baseVersion: 1, body }),
  ]);
  const won = results.filter((result) => result.ok);
  expect(won).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toEqual([
    { ok: false, code: 'pointer_moved', current: won[0]?.version },
  ]);
  expect(await port.localVersion(ctx, agentId)).toBe(won[0]?.version);
}
