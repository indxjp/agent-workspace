/**
 * The agent-version store conformance suite (the version half of the port) — **one suite, every
 * implementation**: publish (`create`), `list` and `find`, version numbering, ordering, workspace
 * isolation and not-found.
 *
 * Written against {@link AgentVersionStoreProvider}, exported as
 * {@link describeAgentVersionStoreConformance}, and run against the in-memory provider (always) and
 * the repository-backed one over a real PostgreSQL (when `TEST_DATABASE_URL` names one).
 *
 * Not covered here: pointers, materialisation and reference resolution (`pointers.test.ts`,
 * `pipeline.test.ts`, `create-from-version.postgres.test.ts`), and immutability beyond what the
 * port exposes: it has no update, so "immutable" is held as "a later publish changes no earlier
 * record" (the database trigger is core's own test).
 */
import crypto from 'node:crypto';

import {
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

import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { createRepositoryAgentStoreProvider } from '../agents/store';
import { FIXTURE_PERMISSIONS } from './fixtures';
import { createInMemoryAgentVersionStoreProvider } from './memory-store';
import {
  createRepositoryAgentVersionStoreProvider,
  type AgentVersionStoreProvider,
  type WorkspaceAgentVersionStore,
} from './store';

/** One set-up for one test: a provider, two workspaces, and agents and principals that exist. */
export interface AgentVersionStoreFixture {
  readonly provider: AgentVersionStoreProvider;
  readonly workspaceA: string;
  readonly workspaceB: string;
  /** A new agent in `workspaceId`. */
  readonly agentIn: (workspaceId: string) => Promise<string>;
  /** A principal of `workspaceId`, who may author a version there. */
  readonly principalIn: (workspaceId: string) => string;
  /** A principal id no workspace has. */
  readonly unknownPrincipalId: string;
}

export type MakeAgentVersionStoreFixture = () => Promise<AgentVersionStoreFixture>;

const ABSENT = '55555555-5555-4555-8555-555555555555';

async function storeOf(
  fixture: AgentVersionStoreFixture,
  workspaceId: string,
): Promise<WorkspaceAgentVersionStore> {
  const store = await fixture.provider.forWorkspace(workspaceId);
  if (store === null) throw new Error('the fixture workspace exists');
  return store;
}

async function publish(
  fixture: AgentVersionStoreFixture,
  workspaceId: string,
  agentId: string,
  summary: string,
  body: unknown = { summary },
) {
  const store = await storeOf(fixture, workspaceId);
  const outcome = await store.create(agentId, {
    summary,
    via: 'api',
    body,
    createdByPrincipalId: fixture.principalIn(workspaceId),
  });
  if (outcome.kind !== 'created') throw new Error(`expected "created", got "${outcome.kind}"`);
  return outcome.version;
}

export function describeAgentVersionStoreConformance(
  label: string,
  makeFixture: MakeAgentVersionStoreFixture,
): void {
  describe(label, () => {
    it('numbers an agent versions 1, 2, 3 and returns what was published', async () => {
      const fixture = await makeFixture();
      const agentId = await fixture.agentIn(fixture.workspaceA);
      const body = { definition: { name: 'x' }, surfaces: [] };

      const first = await publish(fixture, fixture.workspaceA, agentId, 'one', body);
      const second = await publish(fixture, fixture.workspaceA, agentId, 'two');
      const third = await publish(fixture, fixture.workspaceA, agentId, 'three');

      expect([first.number, second.number, third.number]).toEqual([1, 2, 3]);
      expect(first).toMatchObject({
        workspaceId: fixture.workspaceA,
        agentId,
        summary: 'one',
        via: 'api',
        body,
        createdByPrincipalId: fixture.principalIn(fixture.workspaceA),
      });
      expect(new Set([first.id, second.id, third.id]).size).toBe(3);
      expect(first.createdAt).toBeInstanceOf(Date);
    });

    it('numbers each agent from 1, independently', async () => {
      const fixture = await makeFixture();
      const one = await fixture.agentIn(fixture.workspaceA);
      const other = await fixture.agentIn(fixture.workspaceA);
      await publish(fixture, fixture.workspaceA, one, 'a');
      await publish(fixture, fixture.workspaceA, one, 'b');

      expect((await publish(fixture, fixture.workspaceA, other, 'c')).number).toBe(1);
    });

    it('lists every version oldest first, with no pointer before one is set', async () => {
      const fixture = await makeFixture();
      const agentId = await fixture.agentIn(fixture.workspaceA);
      for (const summary of ['one', 'two', 'three']) {
        await publish(fixture, fixture.workspaceA, agentId, summary);
      }

      const listing = await (await storeOf(fixture, fixture.workspaceA)).list(agentId);

      expect(listing?.versions.map((v) => [v.number, v.summary])).toEqual([
        [1, 'one'],
        [2, 'two'],
        [3, 'three'],
      ]);
      expect(listing?.pointers).toEqual([]);
      expect(listing?.materialisedVersionId).toBeNull();
    });

    it('lists an agent with no version as an empty history, not as missing', async () => {
      const fixture = await makeFixture();
      const agentId = await fixture.agentIn(fixture.workspaceA);

      const listing = await (await storeOf(fixture, fixture.workspaceA)).list(agentId);

      expect(listing?.versions).toEqual([]);
    });

    it('finds a version by number, and answers null for one that does not exist', async () => {
      const fixture = await makeFixture();
      const agentId = await fixture.agentIn(fixture.workspaceA);
      const store = await storeOf(fixture, fixture.workspaceA);
      await publish(fixture, fixture.workspaceA, agentId, 'one');
      const second = await publish(fixture, fixture.workspaceA, agentId, 'two');

      expect(await store.find(agentId, 2)).toEqual(second);
      expect((await store.find(agentId, 1))?.summary).toBe('one');
      expect(await store.find(agentId, 3)).toBeNull();
      expect(await store.find(agentId, 0)).toBeNull();
    });

    it('changes no earlier record when a later version is published', async () => {
      const fixture = await makeFixture();
      const agentId = await fixture.agentIn(fixture.workspaceA);
      const store = await storeOf(fixture, fixture.workspaceA);
      const first = await publish(fixture, fixture.workspaceA, agentId, 'one', { n: 1 });

      await publish(fixture, fixture.workspaceA, agentId, 'two', { n: 2 });

      expect(await store.find(agentId, 1)).toEqual(first);
      expect((await store.list(agentId))?.versions[0]).toEqual(first);
    });

    it('answers not-found when publishing to an agent that does not exist', async () => {
      const fixture = await makeFixture();
      const store = await storeOf(fixture, fixture.workspaceA);

      const outcome = await store.create(ABSENT, {
        summary: 's',
        via: 'ui',
        body: {},
        createdByPrincipalId: fixture.principalIn(fixture.workspaceA),
      });

      expect(outcome).toEqual({ kind: 'not-found' });
      expect(await store.list(ABSENT)).toBeNull();
      expect(await store.find(ABSENT, 1)).toBeNull();
    });

    it('refuses an author who is not a principal of the workspace', async () => {
      const fixture = await makeFixture();
      const agentId = await fixture.agentIn(fixture.workspaceA);
      const store = await storeOf(fixture, fixture.workspaceA);

      const outcome = await store.create(agentId, {
        summary: 's',
        via: 'ui',
        body: {},
        createdByPrincipalId: fixture.unknownPrincipalId,
      });

      expect(outcome).toEqual({ kind: 'unknown-principal' });
      expect((await store.list(agentId))?.versions).toEqual([]);
    });

    it('does not let one workspace see, find or publish to another workspace agent', async () => {
      const fixture = await makeFixture();
      const agentId = await fixture.agentIn(fixture.workspaceA);
      await publish(fixture, fixture.workspaceA, agentId, 'secret');
      const foreign = await storeOf(fixture, fixture.workspaceB);

      expect(await foreign.list(agentId)).toBeNull();
      expect(await foreign.find(agentId, 1)).toBeNull();
      expect(
        await foreign.create(agentId, {
          summary: 'intruder',
          via: 'api',
          body: {},
          createdByPrincipalId: fixture.principalIn(fixture.workspaceB),
        }),
      ).toEqual({ kind: 'not-found' });
      const owner = await storeOf(fixture, fixture.workspaceA);
      expect((await owner.list(agentId))?.versions).toHaveLength(1);
    });

    it('hands out no store for a workspace that does not exist', async () => {
      const fixture = await makeFixture();

      expect(await fixture.provider.forWorkspace(ABSENT)).toBeNull();
    });
  });
}

// ── Implementation 1: in memory ─────────────────────────────────────────────────────────────

describeAgentVersionStoreConformance('the in-memory agent-version store', () => {
  const workspaceA = crypto.randomUUID();
  const workspaceB = crypto.randomUUID();
  const principals = new Map<string, string>();
  const known = new Set<string>();
  const agentStore = createInMemoryAgentStoreProvider();
  const inner = createInMemoryAgentVersionStoreProvider({
    agents: agentStore,
    knownPrincipalIds: known,
  });
  const principalIn = (workspaceId: string): string => {
    let id = principals.get(workspaceId);
    if (id === undefined) {
      id = crypto.randomUUID();
      principals.set(workspaceId, id);
      known.add(id);
    }
    return id;
  };
  return Promise.resolve({
    // The memory provider answers every workspace; the port's `null` is the database's, so the
    // fixture's two workspaces are the only ones that "exist".
    provider: {
      forWorkspace: (id: string) =>
        id === workspaceA || id === workspaceB ? inner.forWorkspace(id) : Promise.resolve(null),
    },
    workspaceA,
    workspaceB,
    agentIn: async (workspaceId: string) => {
      const created = await agentStore.forWorkspace(workspaceId).create(
        {
          name: `agent-${crypto.randomUUID()}`,
          instructions: 'x',
          modelConnectionId: null,
          model: null,
          permissions: FIXTURE_PERMISSIONS,
        },
        { principalId: principalIn(workspaceId), userId: null },
      );
      if (created.kind !== 'created') throw new Error('the memory store creates the agent');
      return created.agent.id;
    },
    principalIn,
    unknownPrincipalId: crypto.randomUUID(),
  });
});

// ── Implementation 2: PostgreSQL ────────────────────────────────────────────────────────────

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[agent-versions/store.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the PostgreSQL half ' +
      'of this conformance suite did NOT run. A green result without it says nothing about whether ' +
      'the database-backed agent-version store satisfies the same contract as the in-memory one.',
  );
}

describe.skipIf(!hasDatabase)('the PostgreSQL agent-version store', () => {
  let isolated: IsolatedTestDatabase;
  let provider: AgentVersionStoreProvider;
  const principals = new Map<string, string>();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w34_agent_version_store');
    provider = createRepositoryAgentVersionStoreProvider({
      repositories: createDatabaseAgentVersionRepositoryProvider(isolated.db),
      evaluations: createDatabaseAgentVersionEvaluationRepositoryProvider(isolated.db),
      scopes: createDatabaseWorkspaceScopeResolver(isolated.db),
    });
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  /** A workspace with one owner principal (user, membership, principal). */
  async function createWorkspace(): Promise<string> {
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: 'Workspace' });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    principals.set(workspaceId, principalId);
    return workspaceId;
  }

  describeAgentVersionStoreConformance(
    'over a real PostgreSQL, against the same suite',
    async () => {
      const workspaceA = await createWorkspace();
      const workspaceB = await createWorkspace();
      const agentStore = createRepositoryAgentStoreProvider({
        repositories: createDatabaseAgentRepositoryProvider(isolated.db),
        scopes: createDatabaseWorkspaceScopeResolver(isolated.db),
      });
      const principalIn = (workspaceId: string): string => {
        const id = principals.get(workspaceId);
        if (id === undefined) throw new Error('the workspace has a principal');
        return id;
      };
      return {
        provider,
        workspaceA,
        workspaceB,
        agentIn: async (workspaceId) => {
          const created = await agentStore.forWorkspace(workspaceId).create(
            {
              name: `agent-${crypto.randomUUID()}`,
              instructions: 'x',
              modelConnectionId: null,
              model: null,
              permissions: FIXTURE_PERMISSIONS,
            },
            { principalId: principalIn(workspaceId), userId: null },
          );
          if (created.kind !== 'created') throw new Error(`agent create said "${created.kind}"`);
          return created.agent.id;
        },
        principalIn,
        unknownPrincipalId: crypto.randomUUID(),
      };
    },
  );
});
