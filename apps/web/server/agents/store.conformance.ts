/**
 * The agent store conformance suite — **one suite, two implementations**.
 *
 * It is written against {@link AgentStoreProvider}, not against any particular implementation, and
 * is exported as {@link describeAgentStoreConformance} so that both are held to the same
 * assertions without anyone rewriting them. It runs against:
 *
 *   1. `createInMemoryAgentStoreProvider()` — `Map`s, no database, always (`store.test.ts`);
 *   2. `createRepositoryAgentStoreProvider()` over `packages/core/src/db/repositories/agents.ts`
 *      and a **real PostgreSQL**, whenever `TEST_DATABASE_URL` names one
 *      (`store.postgres.test.ts`).
 *
 * That second run is the gate ADR-0024 §3 asks for: the two implementations are the same thing
 * because a suite says so, not because one was written by reading the other. Neither was.
 *
 * The section that matters most is **cross-workspace isolation** (spec §25). A missing workspace
 * filter is a cross-tenant data leak, so it is asserted from both directions on every method:
 * workspace B must not see A's row through `list` or `get`, must not change or delete it through
 * `update` or `delete`, and must be free to reuse A's agent name — because the uniqueness rule is
 * `(workspace_id, name)`, and a store that made names globally unique would be leaking A's names
 * to B through conflict responses.
 *
 * ## Why the fixture hands out workspace ids instead of the suite naming them
 *
 * The in-memory store invents a bucket for any workspace id. PostgreSQL does not: `workspace_id`
 * references `workspaces`, so the database run has to create rows. Making the ids part of the
 * fixture is what lets the same assertions run against both — and it buys a second thing, which is
 * that every database test gets *fresh* workspaces and therefore needs no `truncate`. A suite that
 * truncated would be deleting rows out from under `packages/core/src/db/seed.test.ts`, which runs
 * in a different worker at the same time and says it owns its database. Isolation here is by
 * construction: a private database (`createIsolatedTestDatabase`) and fresh workspaces inside it.
 */
import { describe, expect, it } from 'vitest';

import type { AgentPermissions, AgentPolicy, CreateAgentInput } from '../../contracts/agents';
import type { AgentRecord } from './contract';
import type { AgentStoreProvider, CreateAgentOutcome } from './store';

export const PERMISSIONS: AgentPermissions = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

/** An id that names nothing, for the "this does not exist" assertions. */
export const ABSENT = '55555555-5555-4555-8555-555555555555';

/** A model connection id no fixture ever creates. */
const FOREIGN_CONNECTION = '44444444-4444-4444-8444-444444444444';

export function input(overrides: Partial<CreateAgentInput> = {}): CreateAgentInput {
  return {
    name: 'Customer Support Agent',
    instructions: 'You help employees answer questions...',
    modelConnectionId: null,
    model: null,
    permissions: PERMISSIONS,
    ...overrides,
  };
}

/**
 * Assert an outcome is the success case and return the agent, so a set-up line stays one line.
 *
 * It throws rather than returning a placeholder when the outcome is anything else: a set-up step
 * that silently produced no agent would make the assertions below pass over nothing.
 */
function created(outcome: CreateAgentOutcome): AgentRecord {
  if (outcome.kind !== 'created') {
    throw new Error(`expected the agent to be created, but the store said "${outcome.kind}"`);
  }
  return outcome.agent;
}

/**
 * One set-up for one test: a provider, two workspaces that really exist in it, and — when asked
 * for — one model connection that really exists in the first of them.
 */
export interface AgentStoreFixture {
  readonly provider: AgentStoreProvider;
  readonly workspaceA: string;
  readonly workspaceB: string;
  /** Exact principal plus optional compatibility user attribution for {@link workspaceA}. */
  readonly ownerA: { readonly principalId: string; readonly userId: string | null };
  /** The same, for {@link workspaceB}. */
  readonly ownerB: { readonly principalId: string; readonly userId: string | null };
  /** A `model_connections.id` belonging to {@link workspaceA}, or `null` when none was asked for. */
  readonly modelConnection: string | null;
  /** Marks an agent archived at `at`, as the auto-archive sweep would (issue #1851). */
  readonly archive: (workspaceId: string, id: string, at: Date) => Promise<void>;
}

/**
 * Builds a fixture. Called once per test, so no test can be made to pass by state another test
 * left behind — and, for the database run, so every test gets workspaces nothing else can see.
 */
export type MakeAgentStoreFixture = (options: {
  readonly withModelConnection: boolean;
}) => Promise<AgentStoreFixture>;

/** What every section receives: fixture factories bound to one {@link MakeAgentStoreFixture}. */
interface ConformanceContext {
  readonly plain: () => Promise<AgentStoreFixture>;
  readonly withConnection: () => Promise<AgentStoreFixture>;
  /** The connection the fixture promised, or a failure — never `null` flowing silently onward. */
  readonly connectionOf: (fixture: AgentStoreFixture) => string;
}

/** The create path: ids, timestamps, the name rule and the model-connection foreign key. */
function createCases({ plain, withConnection, connectionOf }: ConformanceContext): void {
  describe('create', () => {
    it('assigns an id and equal created/updated timestamps, and stamps the workspace', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const outcome = await store.create(input(), fixture.ownerA);
      expect(outcome.kind).toBe('created');
      if (outcome.kind !== 'created') return;
      expect(outcome.agent.id).not.toBe('');
      expect(outcome.agent.workspaceId).toBe(fixture.workspaceA);
      expect(outcome.agent.createdAt.getTime()).toBe(outcome.agent.updatedAt.getTime());
    });

    it('rejects a duplicate name inside one workspace (agents_workspace_name_key)', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      await store.create(input(), fixture.ownerA);
      const second = await store.create(input({ instructions: 'different' }), fixture.ownerA);
      expect(second.kind).toBe('name-conflict');
    });

    it('rejects a modelConnectionId the workspace does not have', async () => {
      const fixture = await withConnection();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const outcome = await store.create(
        input({ modelConnectionId: FOREIGN_CONNECTION }),
        fixture.ownerA,
      );
      expect(outcome.kind).toBe('unknown-model-connection');
    });

    it('accepts a modelConnectionId the workspace does have', async () => {
      const fixture = await withConnection();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const outcome = await store.create(
        input({ modelConnectionId: connectionOf(fixture) }),
        fixture.ownerA,
      );
      expect(outcome.kind).toBe('created');
    });

    it('copies the permissions, so a caller mutating its input cannot mutate the row', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const permissions = { ...PERMISSIONS };
      const outcome = await store.create(input({ permissions }), fixture.ownerA);
      permissions.unrestrictedNetwork = true;
      expect(outcome.kind === 'created' && outcome.agent.permissions.unrestrictedNetwork).toBe(
        false,
      );
    });
  });
}

/** Creating an agent together with its assignments, as one write (W2-3). */
function createWithAssignmentsCases({ plain }: ConformanceContext): void {
  describe('create with assignments (W2-3)', () => {
    const none = { files: [], skillIds: [], connectorIds: [] };

    it('creates the agent and its assignments in one write', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const outcome = await store.createWithAssignments(input(), fixture.ownerA, none);
      expect(outcome).toMatchObject({ kind: 'created', assignments: none });
      if (outcome.kind !== 'created') return;
      expect((await store.list()).map((agent) => agent.id)).toEqual([outcome.agent.id]);
    });

    it('leaves no agent row when an assignment names a skill the workspace does not have', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const outcome = await store.createWithAssignments(input(), fixture.ownerA, {
        ...none,
        skillIds: [ABSENT],
      });
      expect(outcome).toEqual({ kind: 'unknown-skill', id: ABSENT });
      expect(await store.list()).toEqual([]);
    });

    it('leaves no agent row when an assignment names a file the workspace does not have', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const outcome = await store.createWithAssignments(input(), fixture.ownerA, {
        ...none,
        files: [{ fileId: ABSENT, access: 'read' }],
      });
      expect(outcome).toEqual({ kind: 'unknown-file', id: ABSENT });
      expect(await store.list()).toEqual([]);
    });

    it('answers the create refusal before any assignment', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      await store.create(input(), fixture.ownerA);
      const outcome = await store.createWithAssignments(input(), fixture.ownerA, {
        ...none,
        connectorIds: [ABSENT],
      });
      expect(outcome.kind).toBe('name-conflict');
      expect(await store.list()).toHaveLength(1);
    });
  });
}

/** Reading: an empty list, a stable order and an absent id. */
function listAndGetCases({ plain }: ConformanceContext): void {
  describe('list and get', () => {
    it('returns an empty list for a workspace with no agents, not a failure', async () => {
      const fixture = await plain();
      expect(await fixture.provider.forWorkspace(fixture.workspaceA).list()).toEqual([]);
    });

    it('returns a total, stable order', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      await store.create(input({ name: 'One' }), fixture.ownerA);
      await store.create(input({ name: 'Two' }), fixture.ownerA);
      await store.create(input({ name: 'Three' }), fixture.ownerA);
      const first = (await store.list()).map((a) => a.id);
      const second = (await store.list()).map((a) => a.id);
      expect(first).toEqual(second);
      expect(first).toHaveLength(3);
    });

    it('returns null for an id nothing has ever used', async () => {
      const fixture = await plain();
      expect(await fixture.provider.forWorkspace(fixture.workspaceA).get(ABSENT)).toBeNull();
    });
  });
}

/** Patching: partial updates, the name rule and the model-connection foreign key. */
function updateCases({ plain, withConnection }: ConformanceContext): void {
  describe('update', () => {
    it('changes only the fields the patch carries, and moves updated_at', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const agent = created(await store.create(input(), fixture.ownerA));
      const outcome = await store.update(agent.id, { name: 'Renamed' });
      expect(outcome.kind).toBe('updated');
      if (outcome.kind !== 'updated') return;
      expect(outcome.agent.name).toBe('Renamed');
      expect(outcome.agent.instructions).toBe('You help employees answer questions...');
      expect(outcome.agent.updatedAt.getTime()).toBeGreaterThanOrEqual(
        outcome.agent.createdAt.getTime(),
      );
    });

    it('can set a nullable field back to null', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const agent = created(
        await store.create(input({ model: 'claude-sonnet-4-5' }), fixture.ownerA),
      );
      const outcome = await store.update(agent.id, { model: null });
      expect(outcome.kind === 'updated' && outcome.agent.model).toBeNull();
    });

    it('lets an agent keep its own name (the conflict check excludes the row being updated)', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const agent = created(await store.create(input(), fixture.ownerA));
      const outcome = await store.update(agent.id, { name: agent.name });
      expect(outcome.kind).toBe('updated');
    });

    it('rejects renaming onto another agent’s name in the same workspace', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      await store.create(input({ name: 'Taken' }), fixture.ownerA);
      const agent = created(await store.create(input({ name: 'Free' }), fixture.ownerA));
      const outcome = await store.update(agent.id, { name: 'Taken' });
      expect(outcome.kind).toBe('name-conflict');
    });

    it('reports not-found for an id that does not exist', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const outcome = await store.update(ABSENT, { name: 'X' });
      expect(outcome.kind).toBe('not-found');
    });

    it('rejects a modelConnectionId the workspace does not have', async () => {
      const fixture = await withConnection();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const agent = created(await store.create(input(), fixture.ownerA));
      const outcome = await store.update(agent.id, { modelConnectionId: FOREIGN_CONNECTION });
      expect(outcome.kind).toBe('unknown-model-connection');
    });
  });
}

/** Deleting, and the name it frees. */
function deleteCases({ plain }: ConformanceContext): void {
  describe('delete', () => {
    it('removes the agent and reports not-found the second time', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const agent = created(await store.create(input(), fixture.ownerA));
      expect((await store.delete(agent.id)).kind).toBe('deleted');
      expect(await store.get(agent.id)).toBeNull();
      expect((await store.delete(agent.id)).kind).toBe('not-found');
    });

    it('frees the name for reuse', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const agent = created(await store.create(input(), fixture.ownerA));
      await store.delete(agent.id);
      expect((await store.create(input(), fixture.ownerA)).kind).toBe('created');
    });
  });
}

/** Clearing the archive mark (issue #1851). */
function restoreCases({ plain }: ConformanceContext): void {
  describe('restore', () => {
    const actor = { principalId: 'principal-1', userId: null, label: 'Ada' } as const;

    it('leaves an agent that is not archived as it is, and reports an unknown id as not-found', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const agent = created(await store.create(input(), fixture.ownerA));
      const outcome = await store.restore(agent.id, actor);
      expect(outcome.kind).toBe('not-archived');
      expect((await store.restore(ABSENT, actor)).kind).toBe('not-found');
    });

    it('clears the archive mark of an archived agent', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const agent = created(await store.create(input(), fixture.ownerA));
      await fixture.archive(fixture.workspaceA, agent.id, new Date('2026-02-03T04:05:06.007Z'));
      expect((await store.get(agent.id))?.archivedAt).toBeDefined();
      const outcome = await store.restore(agent.id, { ...fixture.ownerA, label: 'Ada' });
      expect(outcome.kind).toBe('restored');
      if (outcome.kind !== 'restored') return;
      expect(outcome.agent.archivedAt).toBeUndefined();
      expect((await store.get(agent.id))?.archivedAt).toBeUndefined();
    });
  });
}

/** The agent policy column (S-13). */
function policyCases({ plain }: ConformanceContext): void {
  // ── S-13 ────────────────────────────────────────────────────────────────────────────────
  describe('policy', () => {
    const policy = (): AgentPolicy => ({
      engine: 'claude-agent-sdk',
      tools: {
        base: 'claude_code_preset',
        autoApprove: [],
        deny: ['Bash'],
        permissionMode: 'default',
        allowDangerouslySkipPermissions: false,
      },
      skills: { mode: 'allowlist', names: ['support'] },
      limits: { maxTurns: 25, maxBudgetUsd: 5 },
    });

    it('a freshly created agent reads a NULL policy, not a default one', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const agent = created(await store.create(input(), fixture.ownerA));
      expect(agent.policy).toBeNull();
      expect((await store.get(agent.id))?.policy).toBeNull();
    });

    it('round-trips a replaced policy through the store', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const agent = created(await store.create(input(), fixture.ownerA));
      const outcome = await store.replacePolicy(agent.id, policy());
      expect(outcome.kind).toBe('updated');
      if (outcome.kind !== 'updated') return;
      expect(outcome.agent.policy).toEqual(policy());
      expect((await store.get(agent.id))?.policy).toEqual(policy());
    });

    it('round-trips an openai-agents arm with the switches it withholds (ADR-0074 D12)', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const agent = created(await store.create(input(), fixture.ownerA));
      const withholding: AgentPolicy = {
        engine: 'openai-agents',
        withheldPermissions: ['writeFiles', 'runCommands'],
        skills: { mode: 'all' },
        limits: { maxTurns: null, maxBudgetUsd: null },
      };
      const outcome = await store.replacePolicy(agent.id, withholding);
      expect(outcome.kind).toBe('updated');
      expect((await store.get(agent.id))?.policy).toEqual(withholding);
    });

    it('round-trips a mastra arm with its concurrency and withheld switches (ADR-0084)', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const agent = created(await store.create(input(), fixture.ownerA));
      const mastra: AgentPolicy = {
        engine: 'mastra',
        toolCallConcurrency: 4,
        withheldPermissions: ['runCommands'],
        skills: { mode: 'allowlist', names: ['support'] },
        limits: { maxTurns: 12, maxBudgetUsd: null },
      };
      const outcome = await store.replacePolicy(agent.id, mastra);
      expect(outcome.kind).toBe('updated');
      expect((await store.get(agent.id))?.policy).toEqual(mastra);
    });

    it('writes a policy back to NULL', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      const agent = created(await store.create(input(), fixture.ownerA));
      await store.replacePolicy(agent.id, policy());
      const outcome = await store.replacePolicy(agent.id, null);
      expect(outcome.kind === 'updated' && outcome.agent.policy).toBeNull();
    });

    it('reports not-found for an id that does not exist', async () => {
      const fixture = await plain();
      const store = fixture.provider.forWorkspace(fixture.workspaceA);
      expect((await store.replacePolicy(ABSENT, policy())).kind).toBe('not-found');
    });

    it('cannot reach another workspace’s agent', async () => {
      const fixture = await plain();
      const a = fixture.provider.forWorkspace(fixture.workspaceA);
      const b = fixture.provider.forWorkspace(fixture.workspaceB);
      const agent = created(await a.create(input(), fixture.ownerA));
      expect((await b.replacePolicy(agent.id, policy())).kind).toBe('not-found');
      expect((await a.get(agent.id))?.policy).toBeNull();
    });
  });
}

/** Cross-workspace isolation (spec §25). */
function isolationCases({ plain }: ConformanceContext): void {
  // ── spec §25 ────────────────────────────────────────────────────────────────────────────
  //
  // Both stores come from the SAME provider, so they share storage. If any of these pass because
  // the two workspaces happen not to share a backing store, the test is worthless — hence the
  // first assertion, which proves the sharing before the isolation is asserted.
  describe('cross-workspace isolation (spec §25)', () => {
    it('the two stores really do share one backing store', async () => {
      const fixture = await plain();
      const a = fixture.provider.forWorkspace(fixture.workspaceA);
      const again = fixture.provider.forWorkspace(fixture.workspaceA);
      const agent = created(await a.create(input(), fixture.ownerA));
      expect(await again.get(agent.id)).not.toBeNull();
    });

    it('list never returns another workspace’s agents', async () => {
      const fixture = await plain();
      const a = fixture.provider.forWorkspace(fixture.workspaceA);
      const b = fixture.provider.forWorkspace(fixture.workspaceB);
      await a.create(input({ name: 'A-only' }), fixture.ownerA);
      expect(await b.list()).toEqual([]);
      await b.create(input({ name: 'B-only' }), fixture.ownerB);
      expect((await a.list()).map((x) => x.name)).toEqual(['A-only']);
      expect((await b.list()).map((x) => x.name)).toEqual(['B-only']);
    });

    it('get reports another workspace’s agent as absent, not as forbidden', async () => {
      const fixture = await plain();
      const a = fixture.provider.forWorkspace(fixture.workspaceA);
      const b = fixture.provider.forWorkspace(fixture.workspaceB);
      const agent = created(await a.create(input(), fixture.ownerA));
      expect(await b.get(agent.id)).toBeNull();
    });

    it('update cannot reach another workspace’s agent', async () => {
      const fixture = await plain();
      const a = fixture.provider.forWorkspace(fixture.workspaceA);
      const b = fixture.provider.forWorkspace(fixture.workspaceB);
      const agent = created(await a.create(input(), fixture.ownerA));
      const outcome = await b.update(agent.id, { name: 'Hijacked' });
      expect(outcome.kind).toBe('not-found');
      const still = await a.get(agent.id);
      expect(still?.name).toBe('Customer Support Agent');
    });

    it('delete cannot reach another workspace’s agent', async () => {
      const fixture = await plain();
      const a = fixture.provider.forWorkspace(fixture.workspaceA);
      const b = fixture.provider.forWorkspace(fixture.workspaceB);
      const agent = created(await a.create(input(), fixture.ownerA));
      expect((await b.delete(agent.id)).kind).toBe('not-found');
      expect(await a.get(agent.id)).not.toBeNull();
    });

    it('uniqueness is per workspace, so B may reuse a name A has taken', async () => {
      const fixture = await plain();
      const a = fixture.provider.forWorkspace(fixture.workspaceA);
      const b = fixture.provider.forWorkspace(fixture.workspaceB);
      await a.create(input({ name: 'General' }), fixture.ownerA);
      expect((await b.create(input({ name: 'General' }), fixture.ownerB)).kind).toBe('created');
    });
  });
}

/** Run the conformance suite against a fixture factory. */
export function describeAgentStoreConformance(
  label: string,
  makeFixture: MakeAgentStoreFixture,
): void {
  const context: ConformanceContext = {
    plain: () => makeFixture({ withModelConnection: false }),
    withConnection: () => makeFixture({ withModelConnection: true }),
    connectionOf: (fixture) => {
      if (fixture.modelConnection === null) {
        throw new Error('the fixture was asked for a model connection and produced none');
      }
      return fixture.modelConnection;
    },
  };

  describe(label, () => {
    createCases(context);
    createWithAssignmentsCases(context);
    listAndGetCases(context);
    updateCases(context);
    deleteCases(context);
    restoreCases(context);
    policyCases(context);
    isolationCases(context);
  });
}
