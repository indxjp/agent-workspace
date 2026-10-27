/**
 * The store conformance suite — **one suite, two implementations**.
 *
 * It is written against {@link AgentStoreProvider}, not against any particular implementation, and
 * is exported as {@link describeAgentStoreConformance} so that both are held to the same
 * assertions without anyone rewriting them. It runs against:
 *
 *   1. `createInMemoryAgentStoreProvider()` — `Map`s, no database, always;
 *   2. `createRepositoryAgentStoreProvider()` over `packages/core/src/db/repositories/agents.ts`
 *      and a **real PostgreSQL**, whenever `TEST_DATABASE_URL` names one.
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
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { UnknownWorkspaceError } from '@agent-workspace/core/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentPermissions, AgentPolicy, CreateAgentInput } from '../../contracts/agents';
import type { AgentRecord } from './contract';
import { createInMemoryAgentStoreProvider } from './memory-store';
import {
  createRepositoryAgentStoreProvider,
  type AgentStoreProvider,
  type CreateAgentOutcome,
} from './store';

const PERMISSIONS: AgentPermissions = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

/** An id that names nothing, for the "this does not exist" assertions. */
const ABSENT = '55555555-5555-4555-8555-555555555555';

/** A model connection id no fixture ever creates. */
const FOREIGN_CONNECTION = '44444444-4444-4444-8444-444444444444';

function input(overrides: Partial<CreateAgentInput> = {}): CreateAgentInput {
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
}

/**
 * Builds a fixture. Called once per test, so no test can be made to pass by state another test
 * left behind — and, for the database run, so every test gets workspaces nothing else can see.
 */
export type MakeAgentStoreFixture = (options: {
  readonly withModelConnection: boolean;
}) => Promise<AgentStoreFixture>;

/** Run the conformance suite against a fixture factory. */
export function describeAgentStoreConformance(
  label: string,
  makeFixture: MakeAgentStoreFixture,
): void {
  const plain = (): Promise<AgentStoreFixture> => makeFixture({ withModelConnection: false });
  const withConnection = (): Promise<AgentStoreFixture> =>
    makeFixture({ withModelConnection: true });

  /** The connection the fixture promised, or a failure — never `null` flowing silently onward. */
  const connectionOf = (fixture: AgentStoreFixture): string => {
    if (fixture.modelConnection === null) {
      throw new Error('the fixture was asked for a model connection and produced none');
    }
    return fixture.modelConnection;
  };

  describe(label, () => {
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
  });
}

// ── Implementation 1: in memory ─────────────────────────────────────────────────────────────

describeAgentStoreConformance('the in-memory agent store', ({ withModelConnection }) => {
  const modelConnection = withModelConnection ? crypto.randomUUID() : null;
  return Promise.resolve({
    // An explicit set — empty when no connection was asked for — rather than `undefined`. The
    // in-memory store reads `undefined` as "do not check the foreign key", and a run that skipped
    // the check would not be the same thing as the PostgreSQL run, which cannot skip it.
    provider: createInMemoryAgentStoreProvider({
      knownModelConnectionIds: new Set(modelConnection === null ? [] : [modelConnection]),
      // The fixtures seed no files, skills or connectors, as the PostgreSQL run seeds none.
      knownAssignableIds: new Set(),
    }),
    workspaceA: crypto.randomUUID(),
    workspaceB: crypto.randomUUID(),
    // The in-memory store enforces no foreign key, so any id documents "some member" as well as
    // a real one would.
    ownerA: { principalId: crypto.randomUUID(), userId: crypto.randomUUID() },
    ownerB: { principalId: crypto.randomUUID(), userId: crypto.randomUUID() },
    modelConnection,
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

// ── Implementation 2: PostgreSQL ────────────────────────────────────────────────────────────

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[agents/store.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the PostgreSQL half of ' +
      'this conformance suite did NOT run. A green result without it says nothing about whether ' +
      'the database-backed agent store satisfies the same contract as the in-memory one.',
  );
}

/** `apps/web/server/agents/<this file>` → the repository root, five levels up. */
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

/**
 * The **declared** escape, not the public surface.
 *
 * A conformance suite has to insert the rows the repository under test reads — workspaces, users,
 * memberships, a model connection — and it cannot do that through the layer it is testing without
 * asserting that a function agrees with itself. That needs the raw handle and the table objects,
 * and since verification round 1 those live behind `@agent-workspace/core/db/unscoped`, which
 * throws when it is loaded by a process that has not identified itself as a test runner. This file
 * is such a process; a route handler is not. `packages/core/src/db/index.ts` records why.
 */
type CoreDb = typeof import('@agent-workspace/core/db/unscoped');

describe.skipIf(!hasDatabase)('the PostgreSQL agent store', () => {
  /**
   * The escape subpath is loaded through a dynamic import inside `beforeAll`, not statically at the
   * top of the file, so that the `dist` check below can name the build command rather than letting
   * the import fail with a resolver message nobody can act on. CI builds core before it tests —
   * `Build packages/core` precedes `Test` in `.github/workflows/ci.yml`.
   */
  let core: CoreDb;
  let isolated: Awaited<ReturnType<CoreDb['createIsolatedTestDatabase']>>;

  beforeAll(async () => {
    const dist = path.join(
      repoRoot,
      'packages',
      'core',
      'dist',
      'db',
      'repositories',
      'unscoped.js',
    );
    // A positive assertion before the import, so the failure names its own remedy. Deliberately
    // not a skip: TEST_DATABASE_URL is set, so this half of the suite was asked for and must
    // either run or fail (ADR-0015).
    if (!existsSync(dist)) {
      throw new Error(
        `${dist} does not exist. Run \`pnpm --filter @agent-workspace/core run build\` before ` +
          '`pnpm test`; CI does this in a step of its own.',
      );
    }
    core = await import('@agent-workspace/core/db/unscoped');
    isolated = await core.createIsolatedTestDatabase('aw_w2db02_agents');
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  describeAgentStoreConformance(
    'over a real PostgreSQL, against the same suite',
    async ({ withModelConnection }) => {
      const workspaceA = crypto.randomUUID();
      const workspaceB = crypto.randomUUID();
      // `workspaces_slug_format` wants a URL-safe slug: a canonical UUID is lower-case hex and
      // hyphens, starts and ends with a hex digit, and is 36 characters — inside the pattern.
      await isolated.db.insert(core.workspaces).values([
        { id: workspaceA, slug: workspaceA, name: 'Workspace A' },
        { id: workspaceB, slug: workspaceB, name: 'Workspace B' },
      ]);

      // `created_by` is tenant-paired to `memberships` (issue #117), so every fixture needs a real
      // member per workspace, not merely a real workspace.
      const ownerUserA = crypto.randomUUID();
      const ownerUserB = crypto.randomUUID();
      const membershipA = crypto.randomUUID();
      const membershipB = crypto.randomUUID();
      const principalA = crypto.randomUUID();
      const principalB = crypto.randomUUID();
      await isolated.db.insert(core.users).values([
        { id: ownerUserA, email: `${ownerUserA}@example.test`, name: 'Owner A' },
        { id: ownerUserB, email: `${ownerUserB}@example.test`, name: 'Owner B' },
      ]);
      await isolated.db.transaction(async (tx) => {
        await tx.insert(core.memberships).values([
          { id: membershipA, workspaceId: workspaceA, userId: ownerUserA, role: 'owner' },
          { id: membershipB, workspaceId: workspaceB, userId: ownerUserB, role: 'owner' },
        ]);
        await tx.insert(core.workspacePrincipals).values([
          {
            id: principalA,
            workspaceId: workspaceA,
            kind: 'membership',
            membershipId: membershipA,
          },
          {
            id: principalB,
            workspaceId: workspaceB,
            kind: 'membership',
            membershipId: membershipB,
          },
        ]);
      });

      let modelConnection: string | null = null;
      if (withModelConnection) {
        modelConnection = crypto.randomUUID();
        await isolated.db.insert(core.modelConnections).values({
          id: modelConnection,
          workspaceId: workspaceA,
          name: 'Primary',
          provider: 'anthropic',
          config: {},
        });
      }

      return {
        provider: createRepositoryAgentStoreProvider({
          repositories: core.createDatabaseAgentRepositoryProvider(isolated.db),
          scopes: core.createDatabaseWorkspaceScopeResolver(isolated.db),
        }),
        workspaceA,
        workspaceB,
        ownerA: { principalId: principalA, userId: ownerUserA },
        ownerB: { principalId: principalB, userId: ownerUserB },
        modelConnection,
      };
    },
  );

  it('refuses by name when the workspace it was scoped to does not exist', async () => {
    const store = createRepositoryAgentStoreProvider({
      repositories: core.createDatabaseAgentRepositoryProvider(isolated.db),
      scopes: core.createDatabaseWorkspaceScopeResolver(isolated.db),
    }).forWorkspace(ABSENT);
    // Not an empty list. "This workspace has no agents" and "this workspace was deleted while you
    // held a session for it" are different facts, and only one of them is survivable (ADR-0015).
    await expect(store.list()).rejects.toThrow(UnknownWorkspaceError);
    await expect(store.get(ABSENT)).rejects.toThrow(/no workspace has id/u);
  });

  describe('lineage and archive columns (issue #1851)', () => {
    /** A workspace with one owner principal, and the repository scoped to it. */
    async function fixture() {
      const workspaceId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const membershipId = crypto.randomUUID();
      const principalId = crypto.randomUUID();
      await isolated.db
        .insert(core.workspaces)
        .values({ id: workspaceId, slug: workspaceId, name: 'Lineage' });
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
        if (outcome.kind !== 'created')
          throw new Error(`could not create ${name}: ${outcome.kind}`);
        return outcome.agent;
      };
      return { workspaceId, principalId, repository, make };
    }

    it('writes an agent with lineage and reads it back; a person-made agent has none', async () => {
      const { repository, make } = await fixture();
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

    it('refuses a partial lineage with the CHECK', async () => {
      const { workspaceId, principalId, make } = await fixture();
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

    it('keeps the version and run when the creating agent is deleted', async () => {
      const { repository, make } = await fixture();
      const creator = await make('creator');
      const made = await make('made', { agentId: creator.id, version: 1, runId: 'run_abc' });
      expect(await repository.delete(creator.id)).toEqual({ kind: 'deleted' });
      expect((await repository.get(made.id))?.createdByAgent).toEqual({
        agentId: null,
        version: 1,
        runId: 'run_abc',
      });
    });

    it('refuses a creator from another workspace', async () => {
      const home = await fixture();
      const foreign = await fixture();
      const creator = await foreign.make('creator');
      await expect(
        home.make('made', { agentId: creator.id, version: 1, runId: 'run_abc' }),
      ).rejects.toMatchObject({ cause: { constraint: 'agents_created_by_agent_workspace_fk' } });
    });

    it('reads archived_at back as archivedAt without hiding the agent from the list', async () => {
      const { repository, make } = await fixture();
      const agent = await make('to-archive');
      const archivedAt = new Date('2026-02-03T04:05:06.007Z');
      await isolated.db.update(core.agents).set({ archivedAt }).where(eq(core.agents.id, agent.id));
      expect((await repository.get(agent.id))?.archivedAt).toEqual(archivedAt);
      expect((await repository.list()).map((a) => a.id)).toContain(agent.id);
    });
  });

  /**
   * The acceptance criterion of this whole task, as a gate rather than as a transcript.
   *
   * > an agent created before a process restart is still there after it
   *
   * A test that created an agent and read it back in the same process would prove nothing about a
   * restart: the pool, the module graph and every `Map` would still be alive. So the agent is
   * created by a **child process that then exits**, and read by a **second child process** that
   * never shared anything with the first. The parent only spawns them and compares their output —
   * including their pids, which are asserted to differ, so "the same process answered twice"
   * cannot pass this.
   *
   * Both children go through the production path: `createRepositoryAgentStoreProvider` from
   * `./store.ts`, over the providers `openDatabaseRoot` hands out — the one entry point
   * `@agent-workspace/core/db` has, and the same one `apps/web/instrumentation.ts` calls. Nothing
   * is stubbed, and nothing here touches the declared escape subpath. The writer is told only a
   * workspace id and a name; the reader is told only the workspace id.
   *
   * `./store.ts` is loaded by the children **as TypeScript**, which Node 24 strips natively. Its
   * one value import, `@agent-workspace/core/db`, resolves to the same built `dist` the child
   * imports directly.
   */
  it('keeps an agent across a real process restart: two processes, one database', async () => {
    // The child lives in the OS temporary directory, not in the repository. Two reasons, and the
    // second was measured: nothing there is type-checked, linted, formatted or tracked, and
    // Node's type stripping refuses outright for any file under `node_modules`
    // (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), which is where `tests/auth.test.ts` puts
    // its own fixture.
    const dir = mkdtempSync(path.join(tmpdir(), 'aw-w2db02-restart-'));
    const script = path.join(dir, 'agent-process.ts');
    // A `file:` URL, not a bare absolute path. The previous form wrote the repository root
    // straight into the specifier; on Windows that is `C:/…`, which Node's ESM loader reads as a
    // URL whose scheme is `c:` and refuses with ERR_UNSUPPORTED_ESM_URL_SCHEME. Measured here on
    // Windows 11 with Node 24.19.0, where this test failed before the change and passes after it.
    const specifier = (...segments: string[]): string =>
      pathToFileURL(path.join(repoRoot, ...segments)).href;
    writeFileSync(
      script,
      [
        "import { openDatabaseRoot } from '" +
          specifier('packages', 'core', 'dist', 'db', 'index.js') +
          "';",
        "import { createRepositoryAgentStoreProvider } from '" +
          specifier('apps', 'web', 'server', 'agents', 'store.ts') +
          "';",
        '',
        'const [mode, url, workspaceId, name, principalId, userId] = process.argv.slice(2);',
        '// The production path exactly: the only database entry point the public surface has,',
        '// reading the same environment contract `apps/web/instrumentation.ts` reads. The child',
        '// imports `dist/db/index.js` and nothing else, so if the escape subpath were the only',
        '// way to reach PostgreSQL this fixture would not compile.',
        "const root = await openDatabaseRoot({ DATABASE_URL: url, DATABASE_POOL_MAX: '2' });",
        'const store = createRepositoryAgentStoreProvider({',
        '  repositories: root.agents,',
        '  scopes: root.scopes,',
        '}).forWorkspace(workspaceId);',
        "if (mode === 'write') {",
        '  const outcome = await store.create({',
        '    name,',
        "    instructions: 'written before the restart',",
        '    modelConnectionId: null,',
        '    model: null,',
        '    permissions: { readFiles: true, writeFiles: false, runCommands: false, unrestrictedNetwork: false },',
        '  }, { principalId, userId });',
        '  console.log(JSON.stringify({ pid: process.pid, mode, outcome: outcome.kind }));',
        "} else if (mode === 'read') {",
        '  const agents = await store.list();',
        '  console.log(JSON.stringify({ pid: process.pid, mode, names: agents.map((a) => a.name) }));',
        '} else {',
        '  // The explicit else, in a fixture as much as anywhere: an unrecognised mode must fail',
        '  // the test rather than print nothing and exit 0 (ADR-0015).',
        '  console.error(`unknown mode ${mode}`);',
        '  process.exit(2);',
        '}',
        'await root.close();',
      ].join('\n'),
      'utf8',
    );

    const workspaceId = crypto.randomUUID();
    const ownerId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const name = `Survivor ${crypto.randomUUID()}`;
    const run = (mode: string): { pid: number; mode: string; names?: string[]; outcome?: string } =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            // Node reparses `store.ts` as an ES module because `apps/web/package.json` declares
            // no `type`, and says so on stderr every time. The warning is about the app's
            // manifest, not about this test, and that manifest is not this task's to edit — so
            // the noise is silenced by name rather than by silencing every warning.
            '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
            script,
            mode,
            isolated.url,
            workspaceId,
            name,
            principalId,
            ownerId,
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
        ).trim(),
      ) as { pid: number; mode: string; names?: string[]; outcome?: string };

    try {
      // The workspace exists before either child runs; the scope resolver refuses otherwise, and
      // this is the parent's own connection rather than a third child, so a failure here is a
      // legible database error and not an exit code. A membership exists too, because the
      // `created_by` the writer stamps (issue #117) is tenant-paired to `memberships`.
      await isolated.db
        .insert(core.workspaces)
        .values({ id: workspaceId, slug: workspaceId, name: 'Restart' });
      await isolated.db
        .insert(core.users)
        .values({ id: ownerId, email: `${ownerId}@example.test`, name: 'Restart Owner' });
      await isolated.db.transaction(async (tx) => {
        await tx
          .insert(core.memberships)
          .values({ id: membershipId, workspaceId, userId: ownerId, role: 'owner' });
        await tx.insert(core.workspacePrincipals).values({
          id: principalId,
          workspaceId,
          kind: 'membership',
          membershipId,
        });
      });

      const writer = run('write');
      expect(writer.outcome).toBe('created');

      // The writer has exited by now — `execFileSync` returns only when it has. Nothing of it is
      // left: no pool, no module graph, no process.
      const reader = run('read');
      expect(reader.names).toEqual([name]);
      expect(reader.pid).not.toBe(writer.pid);
      expect(reader.pid).not.toBe(process.pid);

      // Printed, not summarised: this line is the acceptance evidence for W2-DB-02, and a PR that
      // quotes it is quoting the run rather than describing it (ADR-0016).
      console.log(
        `[restart] pid ${String(writer.pid)} ${String(writer.outcome)} "${name}" and exited; ` +
          `pid ${String(reader.pid)} then read ${JSON.stringify(reader.names)} from the same database`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
