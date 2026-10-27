import { describe, expect, it } from 'vitest';

import {
  AgentVersionListResponseSchema,
  AgentVersionResourceSchema,
} from '@indx-workspace/contracts/agent-versions';

import type { AgentRecord } from '../agents/contract';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { FIXTURE_PERMISSIONS, FIXTURE_POLICY, versionRequest } from './fixtures';
import { createAgentVersion, listAgentVersions } from './handlers';
import { createInMemoryAgentVersionStoreProvider } from './memory-store';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const PRINCIPAL = '36377a6a-7a0b-4610-8efc-d31547dcc38a';
const MISSING_AGENT = '99999999-9999-4999-8999-999999999999';

async function setUp(
  options: {
    readonly knownPrincipalIds?: ReadonlySet<string>;
    readonly storedPolicy?: AgentRecord['policy'];
  } = {},
) {
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'Support triage',
      instructions: '',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId: PRINCIPAL, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the fixture agent');
  if (options.storedPolicy !== undefined && options.storedPolicy !== null) {
    await agents.forWorkspace(WORKSPACE).replacePolicy(created.agent.id, options.storedPolicy);
  }
  const agent = await agents.forWorkspace(WORKSPACE).get(created.agent.id);
  if (agent === null) throw new Error('the fixture agent exists');
  const provider = createInMemoryAgentVersionStoreProvider({
    agents,
    ...(options.knownPrincipalIds === undefined
      ? {}
      : { knownPrincipalIds: options.knownPrincipalIds }),
  });
  const store = await provider.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  return { agent, provider, store };
}

describe('createAgentVersion', () => {
  it('stores the normalised body without dryRun and answers the published resource', async () => {
    const { agent, store } = await setUp();
    const result = await createAgentVersion(versionRequest(), agent, PRINCIPAL, { store });
    expect(result.status).toBe(201);
    const resource = AgentVersionResourceSchema.parse(result.body);
    expect(resource.body.surfaces).toEqual([]);
    const listing = await store.list(agent.id);
    expect(listing?.versions[0]?.body).not.toHaveProperty('dryRun');
    expect(listing?.versions[0]?.body).toMatchObject({ definition: { policySource: 'stored' } });
  });

  it("refuses via 'builder' from a client with 400 invalid_agent_version, and saves nothing", async () => {
    const { agent, store } = await setUp();
    const result = await createAgentVersion(
      { ...versionRequest(), via: 'builder' },
      agent,
      PRINCIPAL,
      { store },
    );
    expect(result).toMatchObject({
      status: 400,
      body: {
        error: { code: 'invalid_agent_version', details: [expect.stringMatching(/^via: /u)] },
      },
    });
    expect((await store.list(agent.id))?.versions).toEqual([]);
  });

  it('refuses a version that pins a bundle the workspace does not hold, and saves nothing (issue #790)', async () => {
    const { agent, store } = await setUp();
    const digest = 'a'.repeat(64);
    const request = versionRequest({ toolBundles: [{ tool: 'lookup', digest }] });

    const refused = await createAgentVersion(request, agent, PRINCIPAL, {
      store,
      toolBundles: () => Promise.resolve([digest]),
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ error: { code: 'tool_bundle_unknown' } });
    expect((await store.list(agent.id))?.versions).toEqual([]);

    const saved = await createAgentVersion(request, agent, PRINCIPAL, {
      store,
      toolBundles: () => Promise.resolve([]),
    });
    expect(saved.status).toBe(201);
  });

  it('refuses a domain-declaring code tool where the sandbox cannot enforce domains, and saves nothing (#1018)', async () => {
    const { agent, store } = await setUp();
    const digest = 'a'.repeat(64);
    const request = versionRequest({
      toolBundles: [{ tool: 'lookup', digest, allowedDomains: ['api.example.com'] }],
    });
    const deps = {
      store,
      toolBundles: () => Promise.resolve([]),
      toolHost: true,
    };

    const refused = await createAgentVersion(request, agent, PRINCIPAL, {
      ...deps,
      toolDomainsRefusal: 'cannot enforce restricted yet',
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      error: { code: 'network_policy_unsupported', details: ['tool:lookup'] },
    });
    expect((await store.list(agent.id))?.versions).toEqual([]);

    const saved = await createAgentVersion(request, agent, PRINCIPAL, {
      ...deps,
      toolDomainsRefusal: null,
    });
    expect(saved.status).toBe(201);
  });

  it('stores the policy carried across an engine switch, keeping the denial it narrows to', async () => {
    const { agent, store } = await setUp({
      storedPolicy: { ...FIXTURE_POLICY, tools: { ...FIXTURE_POLICY.tools, deny: ['Bash'] } },
    });
    const result = await createAgentVersion(
      versionRequest({
        policy: { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
      }),
      agent,
      PRINCIPAL,
      { store },
    );
    expect(result.status).toBe(201);
    const carried = {
      engine: 'pi',
      skills: { mode: 'all' },
      limits: FIXTURE_POLICY.limits,
      withheldPermissions: ['runCommands'],
    };
    expect(AgentVersionResourceSchema.parse(result.body).body.definition.policy).toEqual(carried);
    const listed = AgentVersionListResponseSchema.parse(
      (await listAgentVersions(agent.id, store)).body,
    );
    expect(listed.items[0]?.body.definition.policy).toEqual(carried);
  });

  it('stores a compiled policy as authored: nothing is carried', async () => {
    const { agent, store } = await setUp({
      storedPolicy: { ...FIXTURE_POLICY, tools: { ...FIXTURE_POLICY.tools, deny: ['Bash'] } },
    });
    const result = await createAgentVersion(
      versionRequest({ policySource: 'compiled' }),
      agent,
      PRINCIPAL,
      { store },
    );
    expect(result.status).toBe(201);
    expect(AgentVersionResourceSchema.parse(result.body).body.definition.policy).toEqual(
      FIXTURE_POLICY,
    );
  });

  it('answers 404 agent_not_found when the store no longer has the agent', async () => {
    const { agent, store } = await setUp();
    const gone = { ...agent, id: MISSING_AGENT };
    expect(await createAgentVersion(versionRequest(), gone, PRINCIPAL, { store })).toMatchObject({
      status: 404,
      body: { error: { code: 'agent_not_found' } },
    });
    expect(
      await createAgentVersion({ ...versionRequest(), dryRun: true }, gone, PRINCIPAL, { store }),
    ).toMatchObject({ status: 404, body: { error: { code: 'agent_not_found' } } });
  });

  it('throws on an unknown principal: RBAC authenticated it, so the invariant is broken', async () => {
    const { agent, store } = await setUp({ knownPrincipalIds: new Set() });
    await expect(createAgentVersion(versionRequest(), agent, PRINCIPAL, { store })).rejects.toThrow(
      /principal invariant/u,
    );
  });
});

describe('listAgentVersions', () => {
  it('answers 404 agent_not_found for an agent the store does not have', async () => {
    const { store } = await setUp();
    expect(await listAgentVersions(MISSING_AGENT, store)).toMatchObject({
      status: 404,
      body: { error: { code: 'agent_not_found' } },
    });
  });

  it('lists items and pointers in the published shape', async () => {
    const { agent, provider, store } = await setUp();
    const saved = await createAgentVersion(versionRequest(), agent, PRINCIPAL, { store });
    const resource = AgentVersionResourceSchema.parse(saved.body);
    provider.point({
      workspaceId: WORKSPACE,
      agentId: agent.id,
      environment: 'local',
      versionId: resource.id,
      number: resource.number,
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    const result = await listAgentVersions(agent.id, store);
    expect(result.status).toBe(200);
    const listing = AgentVersionListResponseSchema.parse(result.body);
    expect(listing.items.map((item) => item.number)).toEqual([1]);
    expect(listing.pointers).toEqual([
      { environment: 'local', number: 1, updatedAt: '2026-10-01T00:00:00.000Z' },
    ]);
  });

  it('throws on a stored body that does not parse — the pipeline is its only writer', async () => {
    const { agent, store } = await setUp();
    await store.create(agent.id, {
      summary: 'Corrupt',
      via: 'api',
      body: { definition: 'not a definition' },
      createdByPrincipalId: PRINCIPAL,
    });
    await expect(listAgentVersions(agent.id, store)).rejects.toThrow(/broken invariant/u);
  });
});
