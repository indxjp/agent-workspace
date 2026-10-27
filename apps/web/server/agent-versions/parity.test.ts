import { describe, expect, it } from 'vitest';

import {
  AgentVersionResourceSchema,
  type CreateAgentVersionRequestInput,
} from '@indx-workspace/contracts/agent-versions';

import type { AgentRecord } from '../agents/contract';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { createAgentFromVersion } from './create-from-version';
import {
  FIXTURE_PERMISSIONS,
  FIXTURE_POLICY,
  dryRunOf,
  fixtureSurface,
  fromVersionRequest,
  versionRequest,
} from './fixtures';
import { createAgentVersion } from './handlers';
import { promoteAgent, rollbackAgent, setAgentPointer } from './pointers';
import {
  createInMemoryAgentVersionStoreProvider,
  type InMemoryAgentVersionStoreProvider,
  type SeededReference,
} from './memory-store';
import type { WorkspaceAgentVersionStore } from './store';

/**
 * C8, the dryRun parity (S1-05, issue #443): for every refusal the pipeline can answer, a dry run
 * and a save answer the same status, code and details, and neither leaves a row behind. For a
 * valid body the dry run names the number the save then takes.
 */
const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const PRINCIPAL = '36377a6a-7a0b-4610-8efc-d31547dcc38a';

interface Harness {
  readonly agent: AgentRecord;
  readonly provider: InMemoryAgentVersionStoreProvider;
  readonly store: WorkspaceAgentVersionStore;
}

async function harness(policy: AgentRecord['policy'] = null): Promise<Harness> {
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'Support triage',
      instructions: 'Answer support mail.',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId: PRINCIPAL, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the fixture agent');
  if (policy !== null) await agents.forWorkspace(WORKSPACE).replacePolicy(created.agent.id, policy);
  const agent = await agents.forWorkspace(WORKSPACE).get(created.agent.id);
  if (agent === null) throw new Error('the fixture agent exists');
  const provider = createInMemoryAgentVersionStoreProvider({
    agents,
    references: {
      [WORKSPACE]: {
        file: [{ id: 'f1', name: 'docs/a.md' }],
        skill: [{ id: 's1', name: 'retiring', deleting: true }],
        connector: [
          { id: 'c1', name: 'crm' },
          { id: 'c2', name: 'crm' },
          { id: 'c3', name: 'tickets' },
        ],
      },
    },
  });
  const store = await provider.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  return { agent, provider, store };
}

interface RefusalFixture {
  readonly name: string;
  readonly body: CreateAgentVersionRequestInput | Record<string, unknown>;
  readonly status: number;
  readonly code: string;
  /** The exact `details`, where the acceptance shape names them. */
  readonly details?: readonly string[];
  readonly registered?: readonly string[];
  readonly storedPolicy?: AgentRecord['policy'];
}

const valid = versionRequest();

const REFUSALS: readonly RefusalFixture[] = [
  {
    name: 'a body that does not parse',
    body: { ...valid, summary: ' padded ' },
    status: 400,
    code: 'invalid_agent_version',
  },
  {
    name: 'an engine nothing publishes',
    body: {
      ...valid,
      body: { ...valid.body, definition: { ...valid.body.definition, policy: { engine: 'acp' } } },
    },
    status: 400,
    code: 'unsupported_engine',
  },
  {
    name: 'a published engine this deployment does not register',
    body: valid,
    registered: ['pi'],
    status: 400,
    code: 'unsupported_engine',
  },
  {
    // The decision of the storage design: a skill being deleted is a 409, not an unknown name.
    name: 'a skill that is being deleted',
    body: versionRequest({ resources: { skills: ['retiring'] } }),
    status: 409,
    code: 'skill_deleting',
    details: ['retiring'],
  },
  {
    name: 'bypassPermissions',
    body: versionRequest({
      policy: {
        ...FIXTURE_POLICY,
        tools: {
          ...FIXTURE_POLICY.tools,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
        },
      },
    }),
    status: 400,
    code: 'dangerous_permission_mode_refused',
  },
  {
    name: 'a missing skill',
    body: versionRequest({ resources: { skills: ['triage'] } }),
    status: 422,
    code: 'agent_definition_references_missing',
    details: ['skill:triage'],
  },
  {
    name: 'an ambiguous connector',
    body: versionRequest({ resources: { connectors: ['crm'] } }),
    status: 409,
    code: 'agent_definition_reference_ambiguous',
  },
  {
    name: 'a connector on an engine without mcp',
    body: versionRequest({
      policy: { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
      resources: { connectors: ['tickets'] },
    }),
    status: 422,
    code: 'engine_capability_unsupported',
    details: ['mcp'],
  },
  {
    name: 'U+0000 in a stored string',
    body: {
      ...valid,
      body: {
        ...valid.body,
        definition: {
          ...valid.body.definition,
          agent: { ...valid.body.definition.agent, instructions: 'before\u0000after' },
        },
      },
    },
    status: 400,
    code: 'invalid_agent_version',
    details: [
      'body.definition.agent.instructions: must not contain U+0000 or an unpaired UTF-16 ' +
        'surrogate, which the version store cannot hold',
    ],
  },
  {
    name: 'U+0000 in a name the pipeline resolves',
    body: versionRequest({ modelConnectionName: 'a\u0000b' }),
    status: 400,
    code: 'invalid_agent_version',
    details: [
      'body.definition.agent.modelConnectionName: must not contain U+0000 or an unpaired UTF-16 ' +
        'surrogate, which the version store cannot hold',
    ],
  },
  {
    name: 'an unpaired surrogate in a stored string',
    body: {
      ...valid,
      body: {
        ...valid.body,
        definition: {
          ...valid.body.definition,
          agent: { ...valid.body.definition.agent, instructions: 'half \uD83D of an emoji' },
        },
      },
    },
    status: 400,
    code: 'invalid_agent_version',
    details: [
      'body.definition.agent.instructions: must not contain U+0000 or an unpaired UTF-16 ' +
        'surrogate, which the version store cannot hold',
    ],
  },
  {
    name: 'an engine switch that would widen',
    body: versionRequest({
      policy: { engine: 'openai-agents', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
    }),
    storedPolicy: {
      ...FIXTURE_POLICY,
      tools: { ...FIXTURE_POLICY.tools, deny: ['mcp__github__*'] },
    },
    status: 422,
    code: 'engine_switch_would_widen',
  },
];

describe('dryRun parity (C8)', () => {
  it.each(REFUSALS)(
    'answers $name the same with and without dryRun, and writes nothing',
    async (fixture) => {
      const { agent, provider, store } = await harness(fixture.storedPolicy ?? null);
      const dependencies = {
        store,
        ...(fixture.registered === undefined ? {} : { registered: fixture.registered }),
      };
      const dryRun = await createAgentVersion(
        { ...fixture.body, dryRun: true },
        agent,
        PRINCIPAL,
        dependencies,
      );
      const save = await createAgentVersion(fixture.body, agent, PRINCIPAL, dependencies);

      expect(dryRun.status).toBe(fixture.status);
      expect(dryRun.body).toMatchObject({ error: { code: fixture.code } });
      if (fixture.details !== undefined) {
        expect(dryRun.body).toMatchObject({ error: { details: fixture.details } });
      }
      expect(save).toEqual(dryRun);
      expect(provider.versionCount()).toBe(0);
      expect(provider.pointerCount()).toBe(0);
    },
  );

  it('answers the number a save then takes, and the dry run writes no row', async () => {
    const { agent, provider, store } = await harness();
    const first = await createAgentVersion(dryRunOf(valid), agent, PRINCIPAL, { store });
    expect(first).toEqual({ status: 200, body: { ok: true, number: 1 } });
    expect(provider.versionCount()).toBe(0);

    const saved = await createAgentVersion(valid, agent, PRINCIPAL, { store });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ number: 1, createdByPrincipalId: PRINCIPAL });

    const second = await createAgentVersion(dryRunOf(valid), agent, PRINCIPAL, { store });
    expect(second).toEqual({ status: 200, body: { ok: true, number: 2 } });
    const savedAgain = await createAgentVersion(valid, agent, PRINCIPAL, { store });
    expect(savedAgain.body).toMatchObject({ number: 2 });
    expect(provider.versionCount()).toBe(2);
  });

  it('accepts a read-write grant on an agent without writeFiles in both modes (#133 narrows)', async () => {
    const { agent, provider, store } = await harness();
    const body = versionRequest({
      resources: { files: [{ path: 'docs/a.md', access: 'read-write' }] },
    });
    expect(await createAgentVersion(dryRunOf(body), agent, PRINCIPAL, { store })).toEqual({
      status: 200,
      body: { ok: true, number: 1 },
    });
    const saved = await createAgentVersion(body, agent, PRINCIPAL, { store });
    expect(saved.status).toBe(201);
    expect(provider.versionCount()).toBe(1);
  });
});

/**
 * C8 for `POST /api/agents {version}` (S1-06, issue #444): the dry run asks what the transaction
 * would refuse — the pipeline, then the agent name, then each surface (C9) — so a dry run and a
 * save answer the same problem and neither writes. The harness agent is named "Support triage",
 * so a body that keeps the fixture name conflicts unless the pipeline refuses it first.
 */
describe('create-from-version dryRun parity (C8)', () => {
  const FROM_VERSION_REFUSALS: readonly {
    readonly name: string;
    readonly body: unknown;
    readonly status: number;
    readonly code: string;
    readonly registered?: readonly string[];
    readonly details?: readonly string[];
  }[] = [
    ...REFUSALS.filter((fixture) => fixture.storedPolicy === undefined).map((fixture) => ({
      name: fixture.name,
      body: { version: fixture.body },
      status: fixture.status,
      code: fixture.code,
      ...(fixture.registered === undefined ? {} : { registered: fixture.registered }),
    })),
    {
      name: 'a name another agent has',
      body: fromVersionRequest(),
      status: 409,
      code: 'agent_name_conflict',
    },
    {
      name: 'a surface another agent serves on local',
      body: fromVersionRequest({
        name: 'Fresh agent',
        surfaces: [fixtureSurface('help', 'Fresh agent'), fixtureSurface('main', 'Fresh agent')],
      }),
      status: 409,
      code: 'surface_name_taken',
      details: ['surface:main'],
    },
  ];

  it.each(FROM_VERSION_REFUSALS)(
    'answers $name the same with and without dryRun, and writes nothing',
    async (fixture) => {
      const { agent, provider, store } = await harness();
      const saved = await createAgentVersion(
        versionRequest({ surfaces: [fixtureSurface('main')] }),
        agent,
        PRINCIPAL,
        { store },
      );
      const version = AgentVersionResourceSchema.parse(saved.body);
      provider.point({
        workspaceId: WORKSPACE,
        agentId: agent.id,
        environment: 'local',
        versionId: version.id,
        number: version.number,
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      });
      const agents = { list: () => Promise.resolve([agent]) };
      const dependencies = {
        store,
        agents,
        ...(fixture.registered === undefined ? {} : { registered: fixture.registered }),
      };
      const owner = {
        principalId: PRINCIPAL,
        ownerPrincipalId: PRINCIPAL,
        userId: null,
        actorLabel: 'owner key',
      };
      const raw = typeof fixture.body === 'object' && fixture.body !== null ? fixture.body : {};
      const dryRun = await createAgentFromVersion({ ...raw, dryRun: true }, owner, dependencies);
      const save = await createAgentFromVersion(fixture.body, owner, dependencies);

      expect(dryRun.status).toBe(fixture.status);
      expect(dryRun.body).toMatchObject({ error: { code: fixture.code } });
      if (fixture.details !== undefined) {
        expect(dryRun.body).toMatchObject({ error: { details: fixture.details } });
      }
      expect(save).toEqual(dryRun);
      expect(provider.versionCount()).toBe(1);
      expect(provider.pointerCount()).toBe(1);
    },
  );
});

/**
 * S1-22 (issue #504, ADR-0101 as amended): a version whose `runtimeProfileName` is `null` is
 * materialised with the workspace's default runtime profile, on both paths that write an agent
 * row — create-from-version and a pointer move — and with `null` when the workspace has none, as
 * core's `resolveDefinition` does. A pointer move keeps a profile the agent already has (issue
 * #832, core's `appliedRuntimeProfileId`). The stored version body keeps `null` either way.
 */
describe("the workspace's default runtime profile (S1-22)", () => {
  const LOCAL_PROFILE = '0b8f3c39-5f0a-4c55-8f22-6f6e5d1d0a01';
  const GPU_PROFILE = '0b8f3c39-5f0a-4c55-8f22-6f6e5d1d0a02';

  async function workspace(defaultRuntimeProfileId: string | null) {
    const agents = createInMemoryAgentStoreProvider({
      knownRuntimeProfileIds: new Set([LOCAL_PROFILE, GPU_PROFILE]),
    });
    const provider = createInMemoryAgentVersionStoreProvider({
      agents,
      references: {
        [WORKSPACE]: {
          'runtime-profile': [
            { id: LOCAL_PROFILE, name: 'local' },
            { id: GPU_PROFILE, name: 'gpu' },
          ],
        },
      },
      ...(defaultRuntimeProfileId === null
        ? {}
        : { defaultRuntimeProfiles: { [WORKSPACE]: defaultRuntimeProfileId } }),
    });
    const store = await provider.forWorkspace(WORKSPACE);
    if (store === null) throw new Error('the memory store answers every workspace');
    return { agents: agents.forWorkspace(WORKSPACE), provider, store };
  }

  const owner = {
    principalId: PRINCIPAL,
    ownerPrincipalId: PRINCIPAL,
    userId: null,
    actorLabel: 'owner key',
  };

  it.each([
    ['with a default', LOCAL_PROFILE, null, LOCAL_PROFILE],
    ['without a default', null, null, null],
    ['with a default and a named profile', LOCAL_PROFILE, 'gpu', GPU_PROFILE],
  ] as const)(
    'create-from-version %s materialises the resolved profile and keeps the body as written',
    async (_name, defaultId, runtimeProfileName, expected) => {
      const h = await workspace(defaultId);
      const request = fromVersionRequest({ name: 'Fresh agent', runtimeProfileName });
      const dryRun = await createAgentFromVersion({ ...request, dryRun: true }, owner, {
        store: h.store,
        agents: h.agents,
      });
      expect(dryRun).toEqual({ status: 200, body: { ok: true, number: 1 } });

      const created = await createAgentFromVersion(request, owner, {
        store: h.store,
        agents: h.agents,
      });
      expect(created.status).toBe(201);
      const agents = await h.agents.list();
      expect(agents.map((row) => row.runtimeProfileId)).toEqual([expected]);
      const [agent] = agents;
      if (agent === undefined) throw new Error('the agent was created');
      const listing = await h.store.list(agent.id);
      expect(listing?.versions[0]?.body).toMatchObject({
        definition: { agent: { runtimeProfileName } },
      });
    },
  );

  it.each([
    ['with a default', LOCAL_PROFILE, null, LOCAL_PROFILE],
    ['without a default', null, null, null],
    // Issue #832: a version naming no profile keeps the one the agent already has.
    ['onto an agent with a profile', LOCAL_PROFILE, GPU_PROFILE, GPU_PROFILE],
  ] as const)(
    'a pointer move %s materialises the resolved profile onto the agent row',
    async (_name, defaultId, current, expected) => {
      const h = await workspace(defaultId);
      const created = await h.agents.create(
        {
          name: 'Support triage',
          instructions: 'Before any version.',
          modelConnectionId: null,
          model: null,
          runtimeProfileId: current,
          permissions: FIXTURE_PERMISSIONS,
        },
        owner,
      );
      if (created.kind !== 'created') throw new Error('the memory store creates the agent');
      const saved = await createAgentVersion(versionRequest(), created.agent, PRINCIPAL, {
        store: h.store,
      });
      expect(saved.status).toBe(201);

      const moved = await setAgentPointer(
        { environment: 'local', version: 1 },
        created.agent,
        { principalId: PRINCIPAL, userId: null, actor: 'builder key' },
        { store: h.store },
      );
      expect(moved.status).toBe(200);
      expect((await h.agents.get(created.agent.id))?.runtimeProfileId).toBe(expected);
    },
  );
});

describe('promote and rollback dryRun parity (C8, #615)', () => {
  const actor = { principalId: PRINCIPAL, userId: null, actor: 'builder key' };

  it('answers what the move answers, apart from saved, and records history only when it moves', async () => {
    const h = await harness();
    for (const instructions of ['Version one.', 'Version two.']) {
      const saved = await createAgentVersion(versionRequest({ instructions }), h.agent, PRINCIPAL, {
        store: h.store,
      });
      expect(saved.status).toBe(201);
    }
    const deps = { store: h.store };
    const point = (version: number) =>
      setAgentPointer({ environment: 'local', version }, h.agent, actor, deps);
    const history = async () =>
      (await h.store.listMoves(h.agent.id, null, 10)).map((row) => [
        row.environment,
        row.number,
        row.reason,
      ]);

    expect((await point(1)).status).toBe(200);
    expect((await promoteAgent({}, h.agent, actor, deps)).status).toBe(200);
    expect((await point(2)).status).toBe(200);
    for (const [move, expected] of [
      [promoteAgent, { environment: 'production', from: 1, to: 2, bar: null }],
      [rollbackAgent, { environment: 'production', from: 2, to: 1, bar: null }],
    ] as const) {
      const before = await history();
      const checked = await move({ dryRun: true }, h.agent, actor, deps);
      expect(checked).toEqual({ status: 200, body: { ...expected, saved: false } });
      expect(await history()).toEqual(before);
      const applied = await move({}, h.agent, actor, deps);
      expect(applied).toEqual({ status: 200, body: { ...expected, saved: true } });
    }
    expect(await history()).toEqual([
      ['production', 1, 'rollback'],
      ['production', 2, 'promote'],
      ['local', 2, 'set'],
      ['production', 1, 'promote'],
      ['local', 1, 'set'],
    ]);
  });

  it('answers 409 skill_deleting when a skill of the target version is marked for deletion since it was saved', async () => {
    const seeded = { skill: [{ id: 's9', name: 'soon-gone' }] as SeededReference[] };
    const agents = createInMemoryAgentStoreProvider();
    const created = await agents.forWorkspace(WORKSPACE).create(
      {
        name: 'Rolled',
        instructions: 'x',
        modelConnectionId: null,
        model: null,
        permissions: FIXTURE_PERMISSIONS,
      },
      { principalId: PRINCIPAL, userId: null },
    );
    if (created.kind !== 'created') throw new Error('the memory store creates the agent');
    const provider = createInMemoryAgentVersionStoreProvider({
      agents,
      references: { [WORKSPACE]: seeded },
    });
    const store = await provider.forWorkspace(WORKSPACE);
    if (store === null) throw new Error('the memory store answers every workspace');
    const saved = await createAgentVersion(
      versionRequest({ resources: { skills: ['soon-gone'] } }),
      created.agent,
      PRINCIPAL,
      { store },
    );
    expect(saved.status).toBe(201);

    seeded.skill = [{ id: 's9', name: 'soon-gone', deleting: true }];
    const moved = await setAgentPointer(
      { environment: 'local', version: 1 },
      created.agent,
      actor,
      { store },
    );
    expect(moved.status).toBe(409);
    expect(moved.body).toMatchObject({
      error: { code: 'skill_deleting', details: ['soon-gone'] },
    });
  });

  it('refuses nothing_to_roll_back the same in both modes', async () => {
    const h = await harness();
    const deps = { store: h.store };
    const checked = await rollbackAgent({ dryRun: true }, h.agent, actor, deps);
    const applied = await rollbackAgent({}, h.agent, actor, deps);
    expect(checked).toEqual(applied);
    expect(applied.status).toBe(409);
    expect(h.provider.pointerCount()).toBe(0);
  });
});
