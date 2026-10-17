import { describe, expect, it, vi } from 'vitest';

import { CreateAgentFromVersionResponseSchema } from '@indx-workspace/contracts/agent-versions';

import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import type { WorkspaceAgentStore } from '../agents/store';
import { createAgentFromVersion } from './create-from-version';
import { FIXTURE_POLICY, fixtureSurface, fromVersionRequest } from './fixtures';
import {
  createInMemoryAgentVersionStoreProvider,
  type InMemoryAgentVersionStoreProvider,
} from './memory-store';
import type { WorkspaceAgentVersionStore } from './store';

/**
 * `createAgentFromVersion` (S1-06, issue #444) on the memory stores: one write creates the agent,
 * its version `1` and the `local` pointer at it; a dry run checks without writing.
 */
const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const OWNER = {
  principalId: '36377a6a-7a0b-4610-8efc-d31547dcc38a',
  ownerPrincipalId: '36377a6a-7a0b-4610-8efc-d31547dcc38a',
  userId: null,
};

interface Harness {
  readonly agents: WorkspaceAgentStore;
  readonly provider: InMemoryAgentVersionStoreProvider;
  readonly store: WorkspaceAgentVersionStore;
}

async function harness(knownPrincipalIds?: ReadonlySet<string>): Promise<Harness> {
  const agentProvider = createInMemoryAgentStoreProvider();
  const provider = createInMemoryAgentVersionStoreProvider({
    agents: agentProvider,
    references: { [WORKSPACE]: { skill: [{ id: 's1', name: 'triage' }] } },
    ...(knownPrincipalIds === undefined ? {} : { knownPrincipalIds }),
  });
  const store = await provider.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  return { agents: agentProvider.forWorkspace(WORKSPACE), provider, store };
}

describe('createAgentFromVersion', () => {
  it('creates the agent, version 1 and local -> 1 in one write', async () => {
    const h = await harness();
    const result = await createAgentFromVersion(
      fromVersionRequest({ resources: { skills: ['triage'] } }),
      OWNER,
      { store: h.store, agents: h.agents },
    );
    expect(result.status).toBe(201);
    const body = CreateAgentFromVersionResponseSchema.parse(result.body);
    expect(body.agent).toMatchObject({
      name: 'Support triage',
      instructions: 'Answer support mail.',
      ownerPrincipalId: OWNER.principalId,
      createdBy: null,
    });
    expect(body.version).toMatchObject({
      agentId: body.agent.id,
      number: 1,
      createdByPrincipalId: OWNER.principalId,
    });
    expect(body.version.body.definition.policy).toEqual(FIXTURE_POLICY);
    expect((await h.agents.get(body.agent.id))?.policy).toEqual(FIXTURE_POLICY);
    expect(h.provider.assignmentsOf(body.agent.id)).toEqual({
      skillIds: ['s1'],
      connectorIds: [],
      files: [],
    });
    expect((await h.store.list(body.agent.id))?.pointers).toMatchObject([
      { environment: 'local', number: 1 },
    ]);
  });

  it('stores a compiled policy as NULL on the row and as authored in the version', async () => {
    const h = await harness();
    const result = await createAgentFromVersion(
      fromVersionRequest({ policySource: 'compiled' }),
      OWNER,
      { store: h.store, agents: h.agents },
    );
    const body = CreateAgentFromVersionResponseSchema.parse(result.body);
    expect((await h.agents.get(body.agent.id))?.policy).toBeNull();
    expect(body.version.body.definition.policySource).toBe('compiled');
  });

  it('answers a dry run with {ok: true, number: 1} and writes nothing', async () => {
    const h = await harness();
    const result = await createAgentFromVersion(fromVersionRequest({ dryRun: true }), OWNER, {
      store: h.store,
      agents: h.agents,
    });
    expect(result).toEqual({ status: 200, body: { ok: true, number: 1 } });
    expect(await h.agents.list()).toEqual([]);
    expect(h.provider.versionCount()).toBe(0);
    expect(h.provider.pointerCount()).toBe(0);
  });

  it('throws on an unknown principal: RBAC authenticated it, so the invariant is broken', async () => {
    const h = await harness(new Set());
    await expect(
      createAgentFromVersion(fromVersionRequest(), OWNER, { store: h.store, agents: h.agents }),
    ).rejects.toThrow(/principal invariant/u);
    expect(await h.agents.list()).toEqual([]);
  });

  it('re-resolves once on reference-gone and retries the create', async () => {
    const h = await harness();
    const createAgentWithFirstVersion = vi
      .fn<WorkspaceAgentVersionStore['createAgentWithFirstVersion']>()
      .mockResolvedValueOnce({ kind: 'reference-gone', referenceKind: 'skill' })
      .mockImplementation((input) => h.store.createAgentWithFirstVersion(input));
    const result = await createAgentFromVersion(
      fromVersionRequest({ resources: { skills: ['triage'] } }),
      OWNER,
      { store: { ...h.store, createAgentWithFirstVersion }, agents: h.agents },
    );
    expect(result.status).toBe(201);
    expect(createAgentWithFirstVersion).toHaveBeenCalledTimes(2);
  });

  it('refuses a domain-declaring code tool where the sandbox cannot enforce domains, and creates nothing (#1018)', async () => {
    const h = await harness();
    const request = fromVersionRequest({
      toolBundles: [
        { tool: 'lookup', digest: 'a'.repeat(64), allowedDomains: ['api.example.com'] },
      ],
    });
    const deps = {
      store: h.store,
      agents: h.agents,
      toolBundles: () => Promise.resolve([]),
      toolHost: true,
    };

    const refused = await createAgentFromVersion(request, OWNER, {
      ...deps,
      toolDomainsRefusal: 'cannot enforce restricted yet',
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      error: { code: 'network_policy_unsupported', details: ['tool:lookup'] },
    });
    expect(await h.agents.list()).toEqual([]);
    expect(h.provider.versionCount()).toBe(0);
    expect(h.provider.pointerCount()).toBe(0);

    const created = await createAgentFromVersion(request, OWNER, {
      ...deps,
      toolDomainsRefusal: null,
    });
    expect(created.status).toBe(201);
  });

  it('a surface served by its own new agent is not a conflict: C9 compares other agents', async () => {
    const h = await harness();
    const result = await createAgentFromVersion(
      fromVersionRequest({ surfaces: [fixtureSurface('main'), fixtureSurface('help')] }),
      OWNER,
      { store: h.store, agents: h.agents },
    );
    expect(result.status).toBe(201);
    expect(h.provider.pointerCount()).toBe(1);
  });

  it('answers a dry run and a save of a blank agent name the same 400, writing nothing', async () => {
    const h = await harness();
    for (const name of ['   ', '\t\n']) {
      const body = fromVersionRequest({ name });
      const dependencies = { store: h.store, agents: h.agents };
      const dryRun = await createAgentFromVersion({ ...body, dryRun: true }, OWNER, dependencies);
      const save = await createAgentFromVersion(body, OWNER, dependencies);
      expect(dryRun).toEqual({
        status: 400,
        body: {
          error: {
            code: 'invalid_agent_version',
            message: 'The body is not a version request.',
            details: ['version.body.definition.agent.name: must not be blank'],
          },
        },
      });
      expect(save).toEqual(dryRun);
    }
    expect(await h.agents.list()).toEqual([]);
  });

  it('names the same surface in a dry run and a save when several are taken (C8)', async () => {
    const h = await harness();
    const owner = await createAgentFromVersion(
      fromVersionRequest({
        name: 'Surface owner',
        surfaces: [
          fixtureSurface('alpha', 'Surface owner'),
          fixtureSurface('zeta', 'Surface owner'),
        ],
      }),
      OWNER,
      { store: h.store, agents: h.agents },
    );
    expect(owner.status).toBe(201);
    // The store's C9 check names the first conflict in sorted order (alpha); the body lists zeta first.
    const body = fromVersionRequest({
      surfaces: [fixtureSurface('zeta'), fixtureSurface('alpha')],
    });
    const dependencies = { store: h.store, agents: h.agents };
    const dryRun = await createAgentFromVersion({ ...body, dryRun: true }, OWNER, dependencies);
    const save = await createAgentFromVersion(body, OWNER, dependencies);
    expect(dryRun).toMatchObject({
      status: 409,
      body: { error: { code: 'surface_name_taken', details: ['surface:zeta'] } },
    });
    expect(save).toEqual(dryRun);
    expect(await h.agents.list()).toHaveLength(1);
  });

  it('answers 422 agent_subagent_unusable when the store finds a nesting the pipeline missed', async () => {
    const h = await harness();
    const store = {
      ...h.store,
      createAgentWithFirstVersion: () =>
        Promise.resolve({
          kind: 'subagent-nesting' as const,
          unusable: ['ghost'],
          parents: ['boss'],
        }),
    };
    const result = await createAgentFromVersion(fromVersionRequest(), OWNER, {
      store,
      agents: h.agents,
    });
    expect(result).toMatchObject({
      status: 422,
      body: {
        error: { code: 'agent_subagent_unusable', details: ['subagent:ghost', 'parent:boss'] },
      },
    });
    expect(await h.agents.list()).toEqual([]);
  });
});
