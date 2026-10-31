import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDatabaseAgentRepositoryProvider,
  createDatabaseAgentVersionEvaluationRepositoryProvider,
  createDatabaseAgentVersionRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  agentVersionPointers,
  agentVersions,
  agents as agentRows,
  auditEvents as auditEventRows,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { AgentCreatedAuditDetailsSchema } from '@indx-workspace/contracts/observability';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAgentFromVersion } from '../../../agent-versions/create-from-version';
import { setAgentPointer } from '../../../agent-versions/pointers';
import { createInMemoryAgentVersionStoreProvider } from '../../../agent-versions/memory-store';
import {
  createRepositoryAgentVersionStoreProvider,
  type AgentVersionStoreProvider,
} from '../../../agent-versions/store';
import { createInMemoryAgentStoreProvider } from '../../../agents/memory-store';
import { createRepositoryAgentStoreProvider, type AgentStoreProvider } from '../../../agents/store';
import type { SaveResult } from '../../ports';
import { startOfUtcDay } from '../../core/facts';
import { handleToolCall } from '../../shell';
import { BuilderAuthorization, makeMemoryPorts } from '../../testing/ports';
import { log } from '../../../telemetry/logger';
import { MemoryApproval } from '../approval/memory';
import { MemoryAudit } from '../audit/memory';
import { MemoryPolicy } from '../policy/memory';
import { callContextOf } from '../../testing/context';
import { draftBody } from '../checker/checker.contract';
import { createChecker } from '../checker/production';
import { MemoryAgentStore } from './memory';
import { createAgentStore } from './production';
import { describeAgentStoreConformance, type StoreFixture } from './store.contract';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

/**
 * The production adapter over `agents` and `versions`, with the person `principalId` in
 * `workspaceId`, and `otherWorkspaceId` a second workspace the stores resolve.
 */
function productionFixture(
  agents: AgentStoreProvider,
  versions: AgentVersionStoreProvider,
  person: {
    workspaceId: string;
    otherWorkspaceId: string;
    principalId: string;
    userId: string | null;
  },
  markBuiltin: StoreFixture['markBuiltin'],
  auditEvents: StoreFixture['auditEvents'],
): StoreFixture {
  const { workspaceId, otherWorkspaceId, principalId, userId } = person;
  const state = async (agentId: string) => {
    const store = await versions.forWorkspace(workspaceId);
    const listing = await store?.list(agentId);
    if (listing === null || listing === undefined) throw new Error('the agent exists');
    const pointer = (environment: string) =>
      listing.pointers.find((candidate) => candidate.environment === environment)?.number ?? null;
    return {
      versions: listing.versions.map(({ number, via, createdByPrincipalId }) => ({
        number,
        via,
        createdByPrincipalId,
      })),
      local: pointer('local'),
      production: pointer('production'),
    };
  };
  return {
    port: createAgentStore({
      agents,
      versions,
      pipeline: () => ({}),
      actorLabel: (_workspaceId, id) => Promise.resolve(`${id}@example.test`),
    }),
    ctx: callContextOf(workspaceId, 'builder', principalId, userId),
    viewer: callContextOf(workspaceId, 'viewer'),
    noCaller: callContextOf(workspaceId, null),
    otherWorkspace: callContextOf(otherWorkspaceId, 'builder', principalId),
    personId: principalId,
    markBuiltin,
    auditEvents,
    inspect: state,
    async seedProduction(agentId, version) {
      const store = await versions.forWorkspace(workspaceId);
      const agent = await agents.forWorkspace(workspaceId).get(agentId);
      if (store === null || agent === null) throw new Error('the agent exists');
      const moved = await setAgentPointer(
        { environment: 'production', version },
        agent,
        { principalId, userId, actor: `${principalId}@example.test` },
        { store },
      );
      if (moved.status !== 200) throw new Error(`promotion answered ${String(moved.status)}`);
    },
  };
}

describeAgentStoreConformance('the memory adapter', () => {
  const store = new MemoryAgentStore();
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  return Promise.resolve({
    port: store,
    ctx: callContextOf(workspaceId, 'builder', principalId),
    viewer: callContextOf(workspaceId, 'viewer'),
    noCaller: callContextOf(workspaceId, null),
    otherWorkspace: callContextOf(crypto.randomUUID(), 'builder', principalId),
    personId: principalId,
    markBuiltin: (agentId) => Promise.resolve(store.markBuiltin(workspaceId, agentId)),
    inspect: (agentId) => Promise.resolve(store.inspect(workspaceId, agentId)),
    auditEvents: (agentId) =>
      Promise.resolve(store.auditEvents(workspaceId).filter((row) => row.subjectId === agentId)),
    seedProduction: (agentId, version) =>
      Promise.resolve(store.seedProduction(workspaceId, agentId, version)),
  });
});

describeAgentStoreConformance('the production adapter over in-memory stores', () => {
  const stored = createInMemoryAgentStoreProvider();
  const versions = createInMemoryAgentVersionStoreProvider({ agents: stored });
  // The memory store has no built-in rows; the adapter only reads the marker off what `get` returns.
  const builtinIds = new Set<string>();
  const agents: AgentStoreProvider = {
    forWorkspace: (id) => {
      const bound = stored.forWorkspace(id);
      return {
        ...bound,
        get: async (agentId) => {
          const agent = await bound.get(agentId);
          return agent !== null && builtinIds.has(agentId)
            ? { ...agent, builtin: 'builder' }
            : agent;
        },
      };
    },
  };
  return Promise.resolve(
    productionFixture(
      agents,
      versions,
      {
        workspaceId: crypto.randomUUID(),
        otherWorkspaceId: crypto.randomUUID(),
        principalId: crypto.randomUUID(),
        userId: null,
      },
      (agentId) => Promise.resolve(void builtinIds.add(agentId)),
      (agentId) =>
        Promise.resolve(
          versions
            .audits()
            .filter((row) => row.action === 'agent-created' && row.subjectId === agentId)
            .map((row) => ({ ...row, details: row.details ?? null })),
        ),
    ),
  );
});

describe('the workspace creation quota counts a console creation (#1851)', () => {
  it("refuses the Builder's next new agent once the console has used the limit", async () => {
    const agents = createInMemoryAgentStoreProvider();
    const versions = createInMemoryAgentVersionStoreProvider({ agents });
    const workspaceId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const pipeline = () => ({});
    const port = createAgentStore({
      agents,
      versions,
      pipeline,
      actorLabel: (_workspaceId, id) => Promise.resolve(id),
    });
    const store = await versions.forWorkspace(workspaceId);
    if (store === null) throw new Error('the workspace resolves');
    // The console route: the version pipeline with no Builder origin, so it writes no agent-created row.
    const fromConsole = await createAgentFromVersion(
      { version: { body: draftBody('From the console'), summary: 's', via: 'api' } },
      { principalId, ownerPrincipalId: principalId, userId: null, actorLabel: 'a person' },
      { ...pipeline(), store, agents: agents.forWorkspace(workspaceId) },
    );
    expect(fromConsole.status).toBe(201);

    const approval = new MemoryApproval();
    const ctx = callContextOf(workspaceId, 'builder', principalId);
    const args = { body: draftBody('From the Builder') };
    approval.approve(ctx, { tool: 'draft_save', arguments: args });
    const result = await handleToolCall(
      { name: 'draft_save', arguments: args, callId: 'c-1' },
      ctx,
      makeMemoryPorts({
        approval,
        store: port,
        policy: new MemoryPolicy({ creationsPerWorkspacePerDay: 1 }),
      }),
    );

    expect(result).toMatchObject({ ok: false, code: 'quota_exceeded' });
  });
});

describe('the Builder cannot save to an archived agent (#1851)', () => {
  it('refuses draft_save as agent_archived and writes no version, pointer move or audit row', async () => {
    const stored = createInMemoryAgentStoreProvider();
    const archived = new Set<string>();
    // The memory store cannot write `archived_at`, so the rows of `archived` are marked as they are read.
    const agents: AgentStoreProvider = {
      forWorkspace: (id) => {
        const bound = stored.forWorkspace(id);
        return {
          ...bound,
          get: async (agentId) => {
            const agent = await bound.get(agentId);
            return agent !== null && archived.has(agentId)
              ? { ...agent, archivedAt: new Date('2026-10-01T00:00:00.000Z') }
              : agent;
          },
        };
      },
    };
    const versions = createInMemoryAgentVersionStoreProvider({ agents });
    const workspaceId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const port = createAgentStore({
      agents,
      versions,
      pipeline: () => ({}),
      actorLabel: (_workspaceId, id) => Promise.resolve(id),
    });
    const ctx = callContextOf(workspaceId, 'builder', principalId);
    const made = await port.save(ctx, { body: draftBody('Frozen') });
    if (!made.ok) throw new Error(`the first save failed: ${made.code}`);
    archived.add(made.agentId);
    const before = {
      versions: versions.versionCount(),
      pointers: versions.pointerCount(),
      audits: versions.audits().length,
    };

    const approval = new MemoryApproval();
    // The memory authorization knows no agents; the person owns this one.
    const authorization = new BuilderAuthorization();
    authorization.access = () => Promise.resolve('allowed');
    const args = { agentId: made.agentId, baseVersion: made.version, body: draftBody('Edited') };
    approval.approve(ctx, { tool: 'draft_save', arguments: args });
    const checker = createChecker({ agents, versions, pipeline: () => ({}) });
    const result = await handleToolCall(
      { name: 'draft_save', arguments: args, callId: 'c-1' },
      ctx,
      makeMemoryPorts({ approval, authorization, checker, store: port }),
    );

    expect(result).toMatchObject({ ok: false, code: 'agent_archived' });
    // The store refuses on its own too, whatever the check before it said.
    expect(
      await port.save(ctx, { agentId: made.agentId, baseVersion: made.version, body: args.body }),
    ).toMatchObject({ ok: false, code: 'agent_archived' });
    expect({
      versions: versions.versionCount(),
      pointers: versions.pointerCount(),
      audits: versions.audits().length,
    }).toEqual(before);
    expect(await port.localVersion(ctx, made.agentId)).toBe(made.version);
  });
});

describe.skipIf(!hasDatabase)('AgentStorePort on PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();

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
    return productionFixture(
      agents,
      versions,
      { workspaceId, otherWorkspaceId, principalId, userId },
      async (agentId) => {
        await isolated.db
          .update(agentRows)
          .set({ builtinKey: 'builder' })
          .where(eq(agentRows.id, agentId));
      },
      async (agentId) =>
        (
          await isolated.db
            .select()
            .from(auditEventRows)
            .where(
              and(
                eq(auditEventRows.subjectId, agentId),
                eq(auditEventRows.action, 'agent-created'),
              ),
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
    );
  }

  describeAgentStoreConformance('the production adapter over PostgreSQL', () =>
    Promise.resolve(postgresFixture()),
  );

  it('rolls a save back whole when its agent-created row is refused, and journals an error', async () => {
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
  });

  it('refuses a save as agent_archived when an archive commits after its version is written, and moves no pointer', async () => {
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
  });

  it("writes the creating agent, its version and the run on an agent-made agent, and nothing on a person's", async () => {
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
  });

  it('answers a creating agent that is not in the workspace with agent_not_found, and writes nothing', async () => {
    const { port, ctx } = postgresFixture();
    const before = await isolated.db.$count(agentRows);

    const result = await port.save(ctx, {
      body: draftBody('orphan'),
      createdByAgent: { agentId: crypto.randomUUID(), version: 1 },
    });

    expect(result).toMatchObject({ ok: false, code: 'agent_not_found' });
    expect(await isolated.db.$count(agentRows)).toBe(before);
  });

  it('answers a creating agent of another workspace with agent_not_found, on the tenant-paired foreign key', async () => {
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
  });

  it('lets exactly one of two concurrent creations win at the limit', async () => {
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
  });

  // Only PostgreSQL serialises the version store's check-then-write, so only it can promise this.
  it('lets exactly one of two concurrent saves from the same base win', async () => {
    const { port, ctx } = postgresFixture();
    const body = draftBody('concurrent');
    const created = await port.save(ctx, { body });
    if (!created.ok) throw new Error(`the first save failed: ${created.code}`);
    const { agentId } = created;
    const results = await Promise.all([
      port.save(ctx, { agentId, baseVersion: 1, body }),
      port.save(ctx, { agentId, baseVersion: 1, body }),
    ]);
    const won = results.filter((result): result is Extract<SaveResult, { ok: true }> => result.ok);
    expect(won).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, code: 'pointer_moved', current: won[0]?.version },
    ]);
    expect(await port.localVersion(ctx, agentId)).toBe(won[0]?.version);
  });
});

describe('what the Builder store may reach', () => {
  const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const sources = (dir: string) =>
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/u.test(file) && !/\.test\.|\.contract\./u.test(file))
      .map((file) => ({ file, text: readFileSync(path.join(dir, file), 'utf8') }));

  /** `text` with the `BUILDER_PROMPT` template literal sliced out; throws if it is not there. */
  const withoutPrompt = (text: string) => {
    const start = text.indexOf('export const BUILDER_PROMPT = `');
    const end = text.indexOf('\n`;\n', start);
    if (start < 0 || end < 0) throw new Error('definition.ts no longer declares BUILDER_PROMPT');
    return text.slice(0, start) + text.slice(end + '\n`;\n'.length);
  };

  it('never promotes, rolls back or deletes an agent', () => {
    // definition.ts stays scanned without its prompt, prose that tells the model it cannot promote.
    const scanned = sources(path.join(server, 'builder')).map(({ file, text }) => ({
      file,
      text: file === path.join('agent', 'definition.ts') ? withoutPrompt(text) : text,
    }));
    expect(scanned.map(({ file }) => file)).toContain(path.join('agent', 'definition.ts'));
    const named = scanned.filter(({ text }) => /promote|rollback|deleteAgent/iu.test(text));
    expect(named.map(({ file }) => file)).toEqual([]);
  });
});
