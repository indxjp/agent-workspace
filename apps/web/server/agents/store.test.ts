/** Shared store conformance, database lineage constraints, and durability across real process exits. */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { UnknownWorkspaceError } from '@agent-workspace/core/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInMemoryAgentStoreProvider } from './memory-store';
import { createAgentRestartDriver } from './store-restart.test-support';
import { createRepositoryAgentStoreProvider, type AgentStoreProvider } from './store';
import {
  ABSENT,
  describeAgentStoreConformance,
  input,
  PERMISSIONS,
  type MakeAgentStoreFixture,
} from './store.conformance';

describeAgentStoreConformance('the in-memory agent store', ({ withModelConnection }) => {
  const modelConnection = withModelConnection ? crypto.randomUUID() : null;
  // An explicit set — empty when no connection was asked for — rather than `undefined`. The
  // in-memory store reads `undefined` as "do not check the foreign key", and a run that skipped
  // the check would not be the same thing as the PostgreSQL run, which cannot skip it.
  const provider = createInMemoryAgentStoreProvider({
    knownModelConnectionIds: new Set(modelConnection === null ? [] : [modelConnection]),
    // The fixtures seed no files, skills or connectors, as the PostgreSQL run seeds none.
    knownAssignableIds: new Set(),
  });
  return Promise.resolve({
    provider,
    workspaceA: crypto.randomUUID(),
    workspaceB: crypto.randomUUID(),
    // The in-memory store enforces no foreign key, so any id documents "some member" as well as
    // a real one would.
    ownerA: { principalId: crypto.randomUUID(), userId: crypto.randomUUID() },
    ownerB: { principalId: crypto.randomUUID(), userId: crypto.randomUUID() },
    modelConnection,
    archive: (workspaceId, id, at) => {
      provider.archive(workspaceId, id, at);
      return Promise.resolve();
    },
  });
});

describe('the in-memory store’s injected clock and id source', () => {
  it('uses them, so a test can make timestamps and ids deterministic', async () => {
    let tick = 0;
    let counter = 0;
    const provider = createInMemoryAgentStoreProvider({
      now: () => new Date(1_700_000_000_000 + tick++ * 1000),
      newId: () => `00000000-0000-4000-8000-00000000000${counter++}`,
    });
    const store = provider.forWorkspace('11111111-1111-4111-8111-111111111111');
    const outcome = await store.create(input(), {
      principalId: '22222222-2222-4222-8222-222222222222',
      userId: '33333333-3333-4333-8333-333333333333',
    });
    expect(outcome.kind === 'created' && outcome.agent.id).toBe(
      '00000000-0000-4000-8000-000000000000',
    );
    if (outcome.kind !== 'created') return;
    const updated = await store.update(outcome.agent.id, { instructions: 'changed' });
    expect(updated.kind === 'updated' && updated.agent.updatedAt.getTime()).toBeGreaterThan(
      outcome.agent.updatedAt.getTime(),
    );
  });
});

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[agents/store.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the PostgreSQL ' +
      'half of this conformance suite did NOT run. A green result without it says nothing about ' +
      'whether the database-backed agent store satisfies the same contract as the in-memory one.',
  );
}

/** `apps/web/server/agents/<this file>` → the repository root, five levels up. */
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

// Seed foreign-key rows through the test-only escape, independently of the store under test.
type CoreDb = typeof import('@agent-workspace/core/db/unscoped');

interface PostgresAgentDatabase {
  readonly core: CoreDb;
  readonly isolated: Awaited<ReturnType<CoreDb['createIsolatedTestDatabase']>>;
}

async function openPostgresAgentDatabase(): Promise<PostgresAgentDatabase> {
  const dist = path.join(repoRoot, 'packages', 'core', 'dist', 'db', 'repositories', 'unscoped.js');
  if (!existsSync(dist)) {
    throw new Error(
      `${dist} does not exist. Run \`pnpm --filter @agent-workspace/core run build\` before \`pnpm test\`.`,
    );
  }
  const core = await import('@agent-workspace/core/db/unscoped');
  return { core, isolated: await core.createIsolatedTestDatabase('aw_w2db02_agents') };
}

// Every workspace needs its own membership principal to satisfy tenant-paired ownership keys.
async function seedWorkspaceWithOwner({ core, isolated }: PostgresAgentDatabase): Promise<{
  readonly workspaceId: string;
  readonly userId: string;
  readonly principalId: string;
}> {
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await isolated.db
    .insert(core.workspaces)
    .values({ id: workspaceId, slug: workspaceId, name: 'Workspace' });
  await isolated.db
    .insert(core.users)
    .values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
  await isolated.db.transaction(async (tx) => {
    await tx
      .insert(core.memberships)
      .values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(core.workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  return { workspaceId, userId, principalId };
}

function agentStoreProviderFor({ core, isolated }: PostgresAgentDatabase): AgentStoreProvider {
  return createRepositoryAgentStoreProvider({
    repositories: core.createDatabaseAgentRepositoryProvider(isolated.db),
    scopes: core.createDatabaseWorkspaceScopeResolver(isolated.db),
  });
}

async function postgresConformanceFixture(
  database: PostgresAgentDatabase,
  { withModelConnection }: Parameters<MakeAgentStoreFixture>[0],
): ReturnType<MakeAgentStoreFixture> {
  const { core, isolated } = database;
  const a = await seedWorkspaceWithOwner(database);
  const b = await seedWorkspaceWithOwner(database);

  let modelConnection: string | null = null;
  if (withModelConnection) {
    modelConnection = crypto.randomUUID();
    await isolated.db.insert(core.modelConnections).values({
      id: modelConnection,
      workspaceId: a.workspaceId,
      name: 'Primary',
      provider: 'anthropic',
      config: {},
    });
  }

  return {
    provider: agentStoreProviderFor(database),
    workspaceA: a.workspaceId,
    workspaceB: b.workspaceId,
    ownerA: { principalId: a.principalId, userId: a.userId },
    ownerB: { principalId: b.principalId, userId: b.userId },
    modelConnection,
    archive: async (workspaceId, id, at) => {
      const scope = await core
        .createDatabaseWorkspaceScopeResolver(isolated.db)
        .forWorkspaceId(workspaceId);
      if (scope === null) throw new Error('the fixture workspace has no scope');
      await core
        .createDatabaseAgentRepositoryProvider(isolated.db)
        .forScope(scope)
        .archive([id], at);
    },
  };
}
async function lineageFixture(database: PostgresAgentDatabase) {
  const { core, isolated } = database;
  const { workspaceId, principalId } = await seedWorkspaceWithOwner(database);
  const scope = await core
    .createDatabaseWorkspaceScopeResolver(isolated.db)
    .forWorkspaceId(workspaceId);
  if (scope === null) throw new Error('the workspace just inserted has no scope');
  const repository = core.createDatabaseAgentRepositoryProvider(isolated.db).forScope(scope);
  const row = (name: string) => ({
    name,
    instructions: '',
    modelConnectionId: null,
    model: null,
    permissions: PERMISSIONS,
    ownerPrincipalId: principalId,
  });
  const make = async (
    name: string,
    createdByAgent?: { agentId: string; version: number; runId: string },
  ) => {
    const outcome = await repository.create({
      ...row(name),
      ...(createdByAgent === undefined ? {} : { createdByAgent }),
    });
    if (outcome.kind !== 'created') throw new Error(`could not create ${name}: ${outcome.kind}`);
    return outcome.agent;
  };
  return { workspaceId, principalId, repository, make };
}

function lineageReadCases(database: () => PostgresAgentDatabase): void {
  it('writes an agent with lineage and reads it back; a person-made agent has none', async () => {
    const { repository, make } = await lineageFixture(database());
    const builder = await make('builder-like');
    const made = await make('made', { agentId: builder.id, version: 4, runId: 'run_abc' });
    const person = await repository.get(builder.id);
    expect(person?.createdByAgent).toBeUndefined();
    expect(person?.archivedAt).toBeUndefined();
    expect((await repository.get(made.id))?.createdByAgent).toEqual({
      agentId: builder.id,
      version: 4,
      runId: 'run_abc',
    });
  });

  it('keeps the version and run when the creating agent is deleted', async () => {
    const { repository, make } = await lineageFixture(database());
    const creator = await make('creator');
    const made = await make('made', { agentId: creator.id, version: 1, runId: 'run_abc' });
    expect(await repository.delete(creator.id)).toEqual({ kind: 'deleted' });
    expect((await repository.get(made.id))?.createdByAgent).toEqual({
      agentId: null,
      version: 1,
      runId: 'run_abc',
    });
  });
}

function lineageConstraintCases(currentDatabase: () => PostgresAgentDatabase): void {
  it('refuses a partial lineage with the CHECK', async () => {
    const database = currentDatabase();
    const { core, isolated } = database;
    const { workspaceId, principalId, make } = await lineageFixture(database);
    const creator = await make('creator');
    const refusal = async (lineage: {
      createdByAgentId?: string;
      createdByAgentVersion?: number;
      createdByRunId?: string;
    }): Promise<unknown> => {
      try {
        await isolated.db.insert(core.agents).values({
          workspaceId,
          name: `partial-${crypto.randomUUID()}`,
          instructions: '',
          permissions: PERMISSIONS,
          ownerPrincipalId: principalId,
          ...lineage,
        });
      } catch (error) {
        return error;
      }
      return null;
    };
    // drizzle wraps the driver error; the constraint name is on its cause.
    const lineageCheck = { cause: { constraint: 'agents_created_by_agent_lineage_check' } };
    expect(await refusal({ createdByAgentVersion: 1 })).toMatchObject(lineageCheck);
    expect(await refusal({ createdByRunId: 'run_abc' })).toMatchObject(lineageCheck);
    expect(await refusal({ createdByAgentId: creator.id })).toMatchObject(lineageCheck);
  });

  it('refuses a creator from another workspace', async () => {
    const home = await lineageFixture(currentDatabase());
    const foreign = await lineageFixture(currentDatabase());
    const creator = await foreign.make('creator');
    await expect(
      home.make('made', { agentId: creator.id, version: 1, runId: 'run_abc' }),
    ).rejects.toMatchObject({ cause: { constraint: 'agents_created_by_agent_workspace_fk' } });
  });
}

function archiveCases(currentDatabase: () => PostgresAgentDatabase): void {
  it('reads archived_at back as archivedAt without hiding the agent from the list', async () => {
    const database = currentDatabase();
    const { core, isolated } = database;
    const { repository, make } = await lineageFixture(database);
    const agent = await make('to-archive');
    const archivedAt = new Date('2026-02-03T04:05:06.007Z');
    await isolated.db.update(core.agents).set({ archivedAt }).where(eq(core.agents.id, agent.id));
    expect((await repository.get(agent.id))?.archivedAt).toEqual(archivedAt);
    expect((await repository.list()).map((a) => a.id)).toContain(agent.id);
  });
}

function restartCases(currentDatabase: () => PostgresAgentDatabase): void {
  it('keeps an agent across a real process restart: two processes, one database', async () => {
    const database = currentDatabase();
    // Outside node_modules: native Node type stripping refuses TypeScript beneath it.
    const dir = mkdtempSync(path.join(tmpdir(), 'aw-w2db02-restart-'));
    const name = `Survivor ${crypto.randomUUID()}`;
    const run = createAgentRestartDriver({
      directory: dir,
      repoRoot,
      url: database.isolated.url,
      name,
    });
    try {
      const owner = await seedWorkspaceWithOwner(database);

      const writer = run('write', owner);
      expect(writer.outcome).toBe('created');

      const reader = run('read', owner);
      expect(reader.names).toEqual([name]);
      expect(reader.pid).not.toBe(writer.pid);
      expect(reader.pid).not.toBe(process.pid);

      console.log(
        `[restart] pid ${String(writer.pid)} ${String(writer.outcome)} "${name}" and exited; ` +
          `pid ${String(reader.pid)} then read ${JSON.stringify(reader.names)} from the same database`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
}

describe.skipIf(!hasDatabase)('the PostgreSQL agent store', () => {
  let database: PostgresAgentDatabase;
  const currentDatabase = () => database;
  beforeAll(async () => {
    database = await openPostgresAgentDatabase();
  }, 180_000);
  afterAll(async () => {
    await database.isolated.close();
  });

  describeAgentStoreConformance('over a real PostgreSQL, against the same suite', (options) =>
    postgresConformanceFixture(database, options),
  );

  it('refuses by name when the workspace it was scoped to does not exist', async () => {
    const store = agentStoreProviderFor(database).forWorkspace(ABSENT);
    await expect(store.list()).rejects.toThrow(UnknownWorkspaceError);
    await expect(store.get(ABSENT)).rejects.toThrow(/no workspace has id/u);
  });

  describe('lineage and archive columns (issue #1851)', () => {
    lineageReadCases(currentDatabase);
    lineageConstraintCases(currentDatabase);
    archiveCases(currentDatabase);
  });
  restartCases(currentDatabase);
});
