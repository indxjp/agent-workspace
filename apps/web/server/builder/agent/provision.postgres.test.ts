/**
 * `ensureBuilderAgent` on PostgreSQL (#1848 slice 1): the real repositories and version pipeline,
 * with the shipped body a fixture (slice 2 supplies the Builder's own).
 */
import crypto from 'node:crypto';

import { and, count, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
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

import { createRepositoryAgentStoreProvider } from '../../agents/store';
import { versionRequest } from '../../agent-versions/fixtures';
import { createRepositoryAgentVersionStoreProvider } from '../../agent-versions/store';
import { ensureBuilderAgent, type EnsureBuilderAgentDependencies } from './provision';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[provision.postgres.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so ensureBuilderAgent ' +
      'was NOT exercised against the real core repository.',
  );
}

const BUILDER_NAME = 'builder';

describe.skipIf(!hasDatabase)('ensureBuilderAgent on PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  let agentStores: ReturnType<typeof createRepositoryAgentStoreProvider>;
  let versionStores: ReturnType<typeof createRepositoryAgentVersionStoreProvider>;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_bld_1848_provision');
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
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  /** A workspace with one Owner membership and its principal. */
  async function workspace(slug: string): Promise<{ id: string; principalId: string }> {
    const id = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({ id, slug, name: slug });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: slug });
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, workspaceId: id, userId, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalId,
        workspaceId: id,
        kind: 'membership',
        membershipId,
      });
    });
    return { id, principalId };
  }

  function dependencies(
    ws: { id: string; principalId: string },
    instructions = 'Build agents.',
  ): EnsureBuilderAgentDependencies {
    return {
      shippedBody: versionRequest({ name: BUILDER_NAME, instructions }).body,
      owner: {
        principalId: ws.principalId,
        ownerPrincipalId: ws.principalId,
        userId: null,
        actorLabel: 'platform',
      },
      versions: versionStores,
      agents: agentStores,
    };
  }

  async function builders(workspaceId: string) {
    return isolated.db
      .select({ id: agents.id, builtinKey: agents.builtinKey })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), isNotNull(agents.builtinKey)));
  }

  async function auditCount(workspaceId: string): Promise<number> {
    const [row] = await isolated.db
      .select({ total: count() })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, workspaceId));
    return row?.total ?? 0;
  }

  async function state(workspaceId: string, agentId: string) {
    const versions = await (await versionStores.forWorkspace(workspaceId))?.list(agentId);
    if (versions === null || versions === undefined) throw new Error('no listing');
    return {
      versions: versions.versions.map((version) => version.number),
      pointers: Object.fromEntries(versions.pointers.map((p) => [p.environment, p.number])),
    };
  }

  it('creates exactly one Builder per workspace, and calling it again changes nothing', async () => {
    const ws = await workspace('provision-once');
    const deps = dependencies(ws);

    const first = await ensureBuilderAgent(ws.id, deps);
    expect(first).toMatchObject({ kind: 'created', version: 1 });
    const rows = await builders(ws.id);
    expect(rows.map((row) => row.builtinKey)).toEqual(['builder']);
    const agentId = rows[0]?.id ?? '';
    expect(await state(ws.id, agentId)).toEqual({
      versions: [1],
      pointers: { local: 1, production: 1 },
    });

    const audits = await auditCount(ws.id);
    const second = await ensureBuilderAgent(ws.id, deps);
    expect(second).toEqual({ kind: 'unchanged', agentId, version: 1 });
    expect(await builders(ws.id)).toHaveLength(1);
    expect(await state(ws.id, agentId)).toEqual({
      versions: [1],
      pointers: { local: 1, production: 1 },
    });
    expect(await auditCount(ws.id)).toBe(audits);
  });

  it('creates one new version on both pointers when the shipped body changes', async () => {
    const ws = await workspace('provision-update');
    const created = await ensureBuilderAgent(ws.id, dependencies(ws));
    if (created.kind !== 'created') throw new Error('expected a created Builder');

    const changed = dependencies(ws, 'Build agents, better.');
    expect(await ensureBuilderAgent(ws.id, changed)).toEqual({
      kind: 'updated',
      agentId: created.agentId,
      version: 2,
    });
    expect(await state(ws.id, created.agentId)).toEqual({
      versions: [1, 2],
      pointers: { local: 2, production: 2 },
    });
    expect(await ensureBuilderAgent(ws.id, changed)).toMatchObject({
      kind: 'unchanged',
      version: 2,
    });
    expect(await state(ws.id, created.agentId)).toMatchObject({ versions: [1, 2] });
  });

  it('runs two concurrent calls to one Builder', async () => {
    const ws = await workspace('provision-race');
    const deps = dependencies(ws);
    const outcomes = await Promise.all([
      ensureBuilderAgent(ws.id, deps),
      ensureBuilderAgent(ws.id, deps),
    ]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['created', 'unchanged']);
    expect(await builders(ws.id)).toHaveLength(1);
  });

  it('creates at most one version when two concurrent calls ship a changed body', async () => {
    const ws = await workspace('provision-race-update');
    const created = await ensureBuilderAgent(ws.id, dependencies(ws));
    if (created.kind !== 'created') throw new Error('expected a created Builder');

    const changed = dependencies(ws, 'Build agents, concurrently.');
    const outcomes = await Promise.all([
      ensureBuilderAgent(ws.id, changed),
      ensureBuilderAgent(ws.id, changed),
    ]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['unchanged', 'updated']);
    expect(outcomes.map((outcome) => ('version' in outcome ? outcome.version : null))).toEqual([
      2, 2,
    ]);
    expect(await state(ws.id, created.agentId)).toEqual({
      versions: [1, 2],
      pointers: { local: 2, production: 2 },
    });
  });

  it('refuses, and writes nothing, when a user agent already has the Builder name', async () => {
    const ws = await workspace('provision-collision');
    const deps = dependencies(ws);
    const taken = await agentStores.forWorkspace(ws.id).create(
      {
        name: BUILDER_NAME,
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions: {
          readFiles: false,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      },
      { principalId: ws.principalId, userId: null },
    );
    expect(taken.kind).toBe('created');

    const outcome = await ensureBuilderAgent(ws.id, deps);
    expect(outcome).toMatchObject({ kind: 'refused', result: { status: 409 } });
    expect(await builders(ws.id)).toEqual([]);
  });

  it('gives each workspace its own Builder', async () => {
    const a = await workspace('provision-tenant-a');
    const b = await workspace('provision-tenant-b');
    const [first, second] = await Promise.all([
      ensureBuilderAgent(a.id, dependencies(a)),
      ensureBuilderAgent(b.id, dependencies(b)),
    ]);
    expect(first.kind).toBe('created');
    expect(second.kind).toBe('created');
    expect(await builders(a.id)).toHaveLength(1);
    expect(await builders(b.id)).toHaveLength(1);
  });
});
