import { describe, expect, it } from 'vitest';

import type { AgentVersionPointerRecord } from '@agent-workspace/core/db';
import type { AgentResourceAssignments } from '@indx-workspace/contracts/agents';

import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import type { AgentResourceStoreProvider } from '../agents/resource-store';
import { DomainError } from '../errors';
import { FIXTURE_PERMISSIONS, FIXTURE_POLICY, versionRequest, type FixtureEdits } from './fixtures';
import { createAgentVersion } from './handlers';
import { createInMemoryAgentVersionStoreProvider } from './memory-store';
import { setAgentPointer } from './pointers';
import {
  createRunAgentReader,
  engineOfVersion,
  resolveSessionVersion,
  runAgentFromVersion,
  versionToPin,
} from './session-version';

/**
 * Which version a conversation runs (issue #612), on the memory stores: a session pins the
 * pointer it started on, and a run of it composes from that version after `local` has moved on
 * and rewritten the row. `apps/web/formal/release-sessions.test.ts` replays the release model.
 */
const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const OTHER_WORKSPACE = '77777777-7777-4777-8777-777777777777';
const OWNER = '36377a6a-7a0b-4610-8efc-d31547dcc38a';
const ACTOR = { principalId: OWNER, userId: null, actor: 'builder key' };
const ROW_ASSIGNMENTS: AgentResourceAssignments = {
  files: [],
  skillIds: ['row-skill'],
  connectorIds: [],
};

async function harness() {
  const agentProvider = createInMemoryAgentStoreProvider();
  const agents = agentProvider.forWorkspace(WORKSPACE);
  const provider = createInMemoryAgentVersionStoreProvider({
    agents: agentProvider,
    references: {
      [WORKSPACE]: {
        skill: [
          { id: 'skill-triage', name: 'triage' },
          { id: 'skill-refunds', name: 'refunds' },
        ],
        connector: [{ id: 'connector-crm', name: 'crm' }],
        file: [{ id: 'file-notes', name: 'docs/notes.md' }],
      },
    },
  });
  const store = await provider.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  const created = await agents.create(
    {
      name: 'Support triage',
      instructions: 'Before any version.',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId: OWNER, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the agent');
  const agentId = created.agent.id;

  /** Save version `number` of `row` and point each of `environments` at it; answers its id. */
  const pushTo = async (
    row: { readonly id: string; readonly name: string },
    number: number,
    edits: FixtureEdits,
    environments: readonly ('local' | 'production')[] = ['local'],
  ): Promise<string> => {
    const saved = await createAgentVersion(
      versionRequest({ name: row.name, ...edits }),
      row as Parameters<typeof createAgentVersion>[1],
      OWNER,
      { store },
    );
    if (saved.status !== 201) throw new Error(`the version saves: ${JSON.stringify(saved)}`);
    for (const environment of environments) {
      const moved = await setAgentPointer(
        { environment, version: number },
        row as Parameters<typeof setAgentPointer>[1],
        ACTOR,
        { store },
      );
      if (moved.status !== 200) throw new Error(`the pointer moves: ${JSON.stringify(moved)}`);
    }
    const record = await store.find(row.id, number);
    if (record === null) throw new Error('the version exists');
    return record.id;
  };

  /** Save the next version and point `local` at it, as `aw push` does; answers its id. */
  const push = async (number: number, edits: FixtureEdits): Promise<string> => {
    const row = await agents.get(agentId);
    if (row === null) throw new Error('the agent exists');
    return pushTo(row, number, edits);
  };

  const assignments: AgentResourceStoreProvider = {
    forWorkspace: (workspaceId) => ({
      get: (id) =>
        Promise.resolve(workspaceId === WORKSPACE && id === agentId ? ROW_ASSIGNMENTS : null),
      replace: () => Promise.reject(new Error('unused')),
    }),
  };
  const read = createRunAgentReader({
    agents: agentProvider,
    assignments,
    versions: async (workspaceId) => {
      const versions = await provider.forWorkspace(workspaceId);
      if (versions === null) return null;
      return {
        findById: async (versionId) =>
          (await versions.list(agentId))?.versions.find((version) => version.id === versionId) ??
          null,
        resolveDefinition: (references) => versions.resolveDefinition(references),
        list: (id) => versions.list(id),
        agentsByName: (names) => versions.agentsByName(names),
      };
    },
  });

  /** Another agent of the workspace with one version, pointed at by each of `environments`. */
  const addAgent = async (
    name: string,
    edits: FixtureEdits,
    environments: readonly ('local' | 'production')[] = ['local'],
  ) => {
    const created = await agents.create(
      {
        name,
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions: FIXTURE_PERMISSIONS,
      },
      { principalId: OWNER, userId: null },
    );
    if (created.kind !== 'created') throw new Error('the memory store creates the agent');
    await pushTo(created.agent, 1, edits, environments);
    return created.agent;
  };

  /** Point the main agent's `production` at its version `number`. */
  const promote = async (number: number): Promise<void> => {
    const row = await agents.get(agentId);
    if (row === null) throw new Error('the agent exists');
    const moved = await setAgentPointer(
      { environment: 'production', version: number },
      row,
      ACTOR,
      {
        store,
      },
    );
    if (moved.status !== 200) throw new Error(`the pointer moves: ${JSON.stringify(moved)}`);
  };
  return { agentId, agents, store, push, pushTo, read, addAgent, promote };
}

const pointer = (
  environment: 'local' | 'production',
  versionId: string,
): AgentVersionPointerRecord => ({
  agentId: 'agent',
  environment,
  versionId,
  number: 1,
  updatedAt: new Date(0),
});

describe('resolveSessionVersion (Lean startSession)', () => {
  it('refuses a started session before it reads the pointer, then a missing pointer, then pins', () => {
    expect(resolveSessionVersion(true, null)).toEqual({
      kind: 'refused',
      code: 'session_already_started',
    });
    expect(resolveSessionVersion(true, 2)).toEqual({
      kind: 'refused',
      code: 'session_already_started',
    });
    expect(resolveSessionVersion(false, null)).toEqual({ kind: 'refused', code: 'no_pointer' });
    expect(resolveSessionVersion(false, 2)).toEqual({ kind: 'pin', version: 2 });
  });
});

describe('versionToPin', () => {
  it('pins the version the environment points at', () => {
    const pointers = [pointer('production', 'v1'), pointer('local', 'v2')];
    expect(versionToPin(pointers, 'local')).toBe('v2');
    expect(versionToPin(pointers, 'production')).toBe('v1');
  });

  it('keeps a legacy agent, which has no pointer, unpinned instead of refusing it', () => {
    expect(versionToPin([], 'local')).toBeNull();
    expect(versionToPin([pointer('production', 'v1')], 'local')).toBeNull();
  });
});

describe('createRunAgentReader', () => {
  it('composes a session pinned to v1 from v1 after local moved to v2 and rewrote the row', async () => {
    const h = await harness();
    const v1 = await h.push(1, {
      instructions: 'Version one.',
      resources: { skills: ['triage'] },
    });
    await h.push(2, { instructions: 'Version two.', resources: { skills: ['refunds'] } });
    expect((await h.agents.get(h.agentId))?.instructions).toBe('Version two.');

    const pinned = await h.read(WORKSPACE, h.agentId, v1);

    expect(pinned.agent).toMatchObject({
      id: h.agentId,
      instructions: 'Version one.',
      permissions: FIXTURE_PERMISSIONS,
      policy: FIXTURE_POLICY,
    });
    expect(pinned.assignments).toEqual({ files: [], skillIds: ['skill-triage'], connectorIds: [] });
  });

  it('composes a legacy session (no pin) from the row and its assignments', async () => {
    const h = await harness();
    await h.push(1, { instructions: 'Version one.' });

    const legacy = await h.read(WORKSPACE, h.agentId, null);

    expect(legacy.agent).toEqual(await h.agents.get(h.agentId));
    expect(legacy.assignments).toBe(ROW_ASSIGNMENTS);
  });

  it('refuses a pinned version whose skill the workspace no longer resolves, with a typed code', async () => {
    const h = await harness();
    const v1 = await h.push(1, { resources: { skills: ['triage'] } });
    const refusal: unknown = await createRunAgentReader({
      agents: { forWorkspace: () => h.agents },
      assignments: {
        forWorkspace: () => ({
          get: () => Promise.reject(new Error('unused')),
          replace: () => Promise.reject(new Error('unused')),
        }),
      },
      versions: () =>
        Promise.resolve({
          findById: async () => (await h.store.list(h.agentId))?.versions[0] ?? null,
          resolveDefinition: () =>
            Promise.resolve({
              kind: 'unresolved',
              missing: [{ kind: 'skill', name: 'triage' }],
              ambiguous: [],
            }),
          list: () => Promise.resolve(null),
          agentsByName: () => Promise.resolve(new Map()),
        }),
    })(WORKSPACE, h.agentId, v1).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DomainError);
    expect(refusal).toMatchObject({ code: 'agent_definition_references_missing' });
  });

  it('reads the row only inside the caller’s workspace', async () => {
    const h = await harness();
    await expect(h.read(OTHER_WORKSPACE, h.agentId, null)).rejects.toThrow(
      /is no longer in workspace/u,
    );
  });

  it('refuses a pin that names another agent’s version', async () => {
    const h = await harness();
    const v1 = await h.push(1, {});
    const other = await h.agents.create(
      {
        name: 'Other',
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions: FIXTURE_PERMISSIONS,
      },
      { principalId: OWNER, userId: null },
    );
    if (other.kind !== 'created') throw new Error('the memory store creates the agent');
    await expect(h.read(WORKSPACE, other.agent.id, v1)).rejects.toThrow(/is gone/u);
  });
});

describe('createRunAgentReader subagents (ADR-0133 D14)', () => {
  const BILLING = { description: 'Answers billing questions.', instructions: 'Billing, local.' };
  const unusable = (reason: RegExp) => ({
    code: 'agent_subagent_unusable',
    publicMessage: expect.stringMatching(reason) as unknown,
  });

  it('runs a pinned version with no subagents, and a legacy session, with none', async () => {
    const h = await harness();
    const v1 = await h.push(1, {});
    expect((await h.read(WORKSPACE, h.agentId, v1)).subagents).toEqual([]);
    expect((await h.read(WORKSPACE, h.agentId, null)).subagents).toEqual([]);
  });

  it('resolves a subagent from its local version while the parent runs local', async () => {
    const h = await harness();
    await h.addAgent('Billing', BILLING);
    const v1 = await h.push(1, { subagents: ['Billing'] });

    const { subagents } = await h.read(WORKSPACE, h.agentId, v1);

    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      name: 'Billing',
      description: BILLING.description,
      instructions: BILLING.instructions,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
      policy: FIXTURE_POLICY,
    });
  });

  it('resolves a subagent from its production version when the parent runs its production one', async () => {
    const h = await harness();
    const billing = await h.addAgent('Billing', BILLING, ['local', 'production']);
    await h.pushTo(billing, 2, { ...BILLING, instructions: 'Billing, newer.' });
    const v1 = await h.push(1, { subagents: ['Billing'] });
    await h.promote(1);

    expect((await h.read(WORKSPACE, h.agentId, v1)).subagents[0]?.instructions).toBe(
      'Billing, local.',
    );

    const v2 = await h.push(2, { subagents: ['Billing'] });
    expect((await h.read(WORKSPACE, h.agentId, v2)).subagents[0]?.instructions).toBe(
      'Billing, newer.',
    );
  });

  it('refuses a subagent that has no version in the environment the parent runs', async () => {
    const h = await harness();
    await h.addAgent('Billing', BILLING, ['local', 'production']);
    const v1 = await h.push(1, { subagents: ['Billing'] });
    await h.promote(1);
    const record = await h.store.find(h.agentId, 1);
    const row = await h.agents.get(h.agentId);
    if (record === null || row === null) throw new Error('the parent exists');
    const noProduction: typeof h.store.list = async (id) => {
      const listing = await h.store.list(id);
      return listing === null
        ? null
        : { ...listing, pointers: listing.pointers.filter((p) => p.environment !== 'production') };
    };

    await expect(
      runAgentFromVersion(row, record, {
        resolveDefinition: (references) => h.store.resolveDefinition(references),
        list: (id) => (id === h.agentId ? h.store.list(id) : noProduction(id)),
        agentsByName: (names) => h.store.agentsByName(names),
      }),
    ).rejects.toMatchObject(unusable(/"Billing" has no version in the production environment/u));
    expect(v1).toBe(record.id);
  });

  it('refuses a subagent the workspace does not have', async () => {
    const h = await harness();
    await h.addAgent('Billing', BILLING);
    const v1 = await h.push(1, { subagents: ['Billing'] });
    const record = await h.store.find(h.agentId, 1);
    const row = await h.agents.get(h.agentId);
    if (record === null || row === null) throw new Error('the parent exists');

    await expect(
      runAgentFromVersion(row, record, {
        resolveDefinition: (references) => h.store.resolveDefinition(references),
        list: (id) => h.store.list(id),
        agentsByName: () => Promise.resolve(new Map()),
      }),
    ).rejects.toMatchObject(unusable(/"Billing" is not an agent of this workspace/u));
    expect(v1).toBe(record.id);
  });

  it('refuses a subagent with no description', async () => {
    const h = await harness();
    const billing = await h.addAgent('Billing', BILLING);
    const v1 = await h.push(1, { subagents: ['Billing'] });
    await h.pushTo(billing, 2, { instructions: 'No description.' });

    await expect(h.read(WORKSPACE, h.agentId, v1)).rejects.toMatchObject(
      unusable(/"Billing" has no description/u),
    );
  });

  it('refuses a subagent that declares subagents of its own', async () => {
    const h = await harness();
    const billing = await h.addAgent('Billing', BILLING);
    await h.addAgent('Legal', { description: 'Reviews contracts.' });
    // Saving and pointing refuse nesting, so only a version saved before it was named can reach this.
    await h.pushTo(billing, 2, { ...BILLING, subagents: ['Legal'] }, []);
    await h.push(1, { subagents: ['Billing'] });
    const record = await h.store.find(h.agentId, 1);
    const row = await h.agents.get(h.agentId);
    if (record === null || row === null) throw new Error('the parent exists');
    const nested: typeof h.store.list = async (id) => {
      const listing = await h.store.list(id);
      const second = listing?.versions.find((version) => version.number === 2);
      if (listing === null || id !== billing.id || second === undefined) return listing;
      return {
        ...listing,
        pointers: listing.pointers.map((p) => ({ ...p, versionId: second.id })),
      };
    };

    await expect(
      runAgentFromVersion(row, record, {
        resolveDefinition: (references) => h.store.resolveDefinition(references),
        list: nested,
        agentsByName: (names) => h.store.agentsByName(names),
      }),
    ).rejects.toMatchObject(unusable(/"Billing" declares subagents of its own/u));
  });

  it('refuses a subagent granted a resource the parent is not', async () => {
    const h = await harness();
    const billing = await h.addAgent('Billing', BILLING);
    const v1 = await h.push(1, { subagents: ['Billing'] });
    await h.pushTo(billing, 2, { ...BILLING, resources: { skills: ['triage'] } });

    await expect(h.read(WORKSPACE, h.agentId, v1)).rejects.toMatchObject(
      unusable(/"Billing" is granted skill:triage that the parent is not/u),
    );
  });

  it('refuses a subagent granted a connector the parent is not', async () => {
    const h = await harness();
    const billing = await h.addAgent('Billing', BILLING);
    const v1 = await h.push(1, { subagents: ['Billing'] });
    await h.pushTo(billing, 2, { ...BILLING, resources: { connectors: ['crm'] } });

    await expect(h.read(WORKSPACE, h.agentId, v1)).rejects.toMatchObject(
      unusable(/"Billing" is granted connector:crm that the parent is not/u),
    );
  });

  it('compares a file grant at its effective access: read-write under read refuses, read under read-write runs', async () => {
    const WRITES = { ...FIXTURE_PERMISSIONS, writeFiles: true };
    const grant = (access: 'read' | 'read-write') => ({
      permissions: WRITES,
      resources: { files: [{ path: 'docs/notes.md', access }] },
    });
    const h = await harness();
    const billing = await h.addAgent('Billing', { ...BILLING, ...grant('read-write') });
    const reads = await h.push(1, { subagents: ['Billing'], ...grant('read') });

    await expect(h.read(WORKSPACE, h.agentId, reads)).rejects.toMatchObject(
      unusable(/"Billing" is granted file:docs\/notes\.md that the parent is not/u),
    );

    await h.pushTo(billing, 2, { ...BILLING, ...grant('read') });
    const writes = await h.push(2, { subagents: ['Billing'], ...grant('read-write') });
    expect((await h.read(WORKSPACE, h.agentId, writes)).subagents).toHaveLength(1);
  });
});

describe('engineOfVersion', () => {
  it('answers the stored policy’s engine, and the default for a compiled one', async () => {
    const h = await harness();
    await h.push(1, {});
    await h.push(2, { policySource: 'compiled' });
    const [stored, compiled] = (await h.store.list(h.agentId))?.versions ?? [];
    if (stored === undefined || compiled === undefined) throw new Error('two versions exist');
    expect(engineOfVersion(stored)).toBe('claude-agent-sdk');
    expect(engineOfVersion(compiled)).toBe('claude-agent-sdk');
  });
});
