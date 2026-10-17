import { afterEach, describe, expect, it } from 'vitest';

import { GET as getRoute, PUT as putRoute } from './route';
import { POST as createAgentRoute } from '../../route';
import type {
  AgentPolicy,
  AgentResource,
  AgentResourceAssignments,
} from '../../../../../contracts/agents';
import {
  createInMemoryAgentVersionStoreProvider,
  type InMemoryAgentVersionStoreProvider,
} from '../../../../../server/agent-versions/memory-store';
import {
  clearAgentVersionsRuntime,
  configureAgentVersionsRuntime,
} from '../../../../../server/agent-versions/runtime';
import { createInMemoryAgentStoreProvider } from '../../../../../server/agents/memory-store';
import type { AgentResourceStoreProvider } from '../../../../../server/agents/resource-store';
import {
  clearAgentsRuntime,
  configureAgentsRuntime,
  type WorkspaceResolution,
} from '../../../../../server/agents/runtime';
import {
  clearEnginesRegisteredForTests,
  registerEngineForTests,
} from '../../../../../server/engines/registry';
import { createMemoryDirectory } from '../../../../../server/rbac/memory-directory';
import { Principal } from '../../../../../server/rbac/principal';
import { clearRbacRuntime, configureRbacRuntime } from '../../../../../server/rbac/runtime';
import type { ResourceCatalogStoreProvider } from '../../../../../server/resources/catalog-store';

/**
 * `GET`/`PUT /api/agents/:id/policy` (S-13), driven with real `Request` objects. Mirrors
 * `resources.test.ts`'s shape in this same directory — the sibling sub-resource route this one was
 * copied from — including the header-driven test resolver `apps/web/server/agents/routes.test.ts`
 * explains at length: it hands an attacker full control of the workspace identity and then proves
 * workspace B still cannot reach workspace A's row.
 *
 * The role matrix itself (Owner/Admin/Builder-own/Builder-other/Viewer, crossed with `decide()`'s
 * four ownership answers) is `apps/web/server/rbac/authorisation-matrix.test.ts`'s job — it derives
 * the whole closed-world matrix from `tests/route-declarations/SDK-02-AGENT-POLICY-234.ts` and
 * `apps/web/server/rbac/declarations/SDK-02-AGENT-POLICY-234.ts` and asserts no cell is undecided.
 * This file proves the two routes actually reach the store, the catalog and the 409/400/503
 * refusals `decide()` cannot express.
 */
const WORKSPACE_A = '66666666-6666-4666-8666-666666666666';
const WORKSPACE_HEADER = 'x-test-workspace';
const ACTOR_HEADER = 'x-test-actor';
const SKILL_ID = '77777777-7777-4777-8777-777777777777';
const CONNECTOR_ID = '88888888-8888-4888-8888-888888888888';

const CREATE_BODY = JSON.stringify({
  name: 'Support triage',
  instructions: 'Answer support mail.',
  modelConnectionId: null,
  model: 'claude-sonnet-4-5',
  permissions: {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  },
});

function validPolicy(overrides: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    engine: 'claude-agent-sdk',
    tools: {
      base: 'claude_code_preset',
      autoApprove: [],
      deny: ['Bash'],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    skills: { mode: 'allowlist', names: ['triage'] },
    limits: { maxTurns: 20, maxBudgetUsd: null },
    ...overrides,
  };
}

afterEach(() => {
  clearAgentsRuntime();
  clearAgentVersionsRuntime();
  clearRbacRuntime();
});

/** Only `listSkills` — the one member the policy routes call — is real; the rest is unused. */
function fakeSkillCatalog(): ResourceCatalogStoreProvider {
  return {
    forWorkspace: () =>
      Promise.resolve({
        listSkills: () =>
          Promise.resolve([
            {
              id: SKILL_ID,
              name: 'triage',
              skillMd: '# Triage',
              enabled: true,
              createdBy: null,
              ownerPrincipalId: 'owner',
            },
          ]),
      } as unknown as Awaited<ReturnType<ResourceCatalogStoreProvider['forWorkspace']>>),
  };
}

/** `skillsConfigured: false` leaves `skillCatalog` unwired, for the 503 test. */
function useMemoryRuntime(
  options: { readonly skillsConfigured?: boolean } = {},
): InMemoryAgentVersionStoreProvider {
  const skillsConfigured = options.skillsConfigured ?? true;
  const agents = createInMemoryAgentStoreProvider();
  const assignments = new Map<string, AgentResourceAssignments>();
  const agentResources: AgentResourceStoreProvider = {
    forWorkspace: (workspaceId) => ({
      get: async (agentId) => {
        if ((await agents.forWorkspace(workspaceId).get(agentId)) === null) return null;
        return (
          assignments.get(`${workspaceId}:${agentId}`) ?? {
            files: [],
            skillIds: [],
            connectorIds: [],
          }
        );
      },
      replace: async (agentId, next) => {
        if ((await agents.forWorkspace(workspaceId).get(agentId)) === null) {
          return { kind: 'not-found' as const };
        }
        assignments.set(`${workspaceId}:${agentId}`, next);
        return { kind: 'updated' as const, assignments: next };
      },
    }),
  };
  configureAgentsRuntime({
    agents,
    agentResources,
    ...(skillsConfigured ? { skillCatalog: fakeSkillCatalog() } : {}),
    resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
      const workspaceId = request.headers.get(WORKSPACE_HEADER);
      return Promise.resolve(
        workspaceId === null
          ? { kind: 'unauthenticated', reason: 'no test workspace header' }
          : { kind: 'workspace', workspaceId },
      );
    },
  });
  // Issue #616: a policy PUT saves a version, so the version store is part of the runtime.
  const versions = createInMemoryAgentVersionStoreProvider({
    agents,
    resources: agentResources,
    references: {
      [WORKSPACE_A]: {
        skill: [{ id: SKILL_ID, name: 'triage' }],
        connector: [{ id: CONNECTOR_ID, name: 'github' }],
      },
    },
  });
  configureAgentVersionsRuntime({ versions });
  configureRbacRuntime({
    directory: createMemoryDirectory({
      users: [
        {
          email: 'builder-a@example.test',
          name: 'Builder A',
          workspaceId: WORKSPACE_A,
          role: 'builder',
        },
        {
          email: 'builder-b@example.test',
          name: 'Builder B',
          workspaceId: WORKSPACE_A,
          role: 'builder',
        },
      ],
    }),
    identify: (request) => {
      const workspaceId = request.headers.get(WORKSPACE_HEADER);
      const actor = request.headers.get(ACTOR_HEADER);
      return Promise.resolve(
        workspaceId === null || actor === null
          ? null
          : Principal.fromApiKey({
              principalId:
                actor === 'builder-a@example.test'
                  ? '36377a6a-7a0b-4610-8efc-d31547dcc38a'
                  : 'c1353585-43d3-45dd-8276-edf59109fdfa',
              apiKeyId:
                actor === 'builder-a@example.test'
                  ? '04aa9a6d-4862-41ce-b910-b43ba3f4d12f'
                  : 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              workspaceId,
              role: 'builder',
              label:
                actor === 'builder-a@example.test'
                  ? 'Builder A policy key'
                  : 'Builder B policy key',
            }),
      );
    },
  });
  return versions;
}

function request(
  method: string,
  url: string,
  options: { workspace?: string; body?: string; actor?: string } = {},
): Request {
  const headers = new Headers();
  if (options.workspace !== undefined) headers.set(WORKSPACE_HEADER, options.workspace);
  if (options.actor !== undefined) headers.set(ACTOR_HEADER, options.actor);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`https://example.invalid${url}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

function idContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function createAsBuilderA(): Promise<AgentResource> {
  const response = await createAgentRoute(
    request('POST', '/api/agents', {
      workspace: WORKSPACE_A,
      body: CREATE_BODY,
      actor: 'builder-a@example.test',
    }),
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as AgentResource;
}

describe('GET/PUT /api/agents/:id/policy', () => {
  it('answers 503, not 401, while the runtime is unconfigured', async () => {
    const response = await getRoute(
      request('GET', '/api/agents/x/policy', { workspace: WORKSPACE_A }),
      idContext('x'),
    );
    expect(response.status).toBe(503);
  });

  it('answers 503 agent_policy_not_configured when no skill catalog is wired', async () => {
    useMemoryRuntime({ skillsConfigured: false });
    const agent = await createAsBuilderA();
    const response = await getRoute(
      request('GET', `/api/agents/${agent.id}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
      }),
      idContext(agent.id),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'agent_policy_not_configured' },
    });
  });

  it('GET answers the compiled policy for a freshly created agent (NULL column)', async () => {
    useMemoryRuntime();
    const agent = await createAsBuilderA();
    const response = await getRoute(
      request('GET', `/api/agents/${agent.id}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
      }),
      idContext(agent.id),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const { policy, source } = (await response.json()) as {
      policy: Extract<AgentPolicy, { engine: 'claude-agent-sdk' }>;
      source: string;
    };
    // ADR-0076 D2: a NULL column is reported as compiled, so an export does not freeze it.
    expect(source).toBe('compiled');
    expect(policy.engine).toBe('claude-agent-sdk');
    // permissions.writeFiles/runCommands/unrestrictedNetwork are all false on CREATE_BODY.
    expect(policy.tools.deny).toEqual(
      expect.arrayContaining(['Write', 'Edit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']),
    );
    expect(policy.skills).toEqual({ mode: 'allowlist', names: [] });
    expect(policy.limits).toEqual({ maxTurns: null, maxBudgetUsd: null });
  });

  it('saves a PUT as one ui version and points local at it (issue #616)', async () => {
    const versions = useMemoryRuntime();
    const agent = await createAsBuilderA();
    const policy = validPolicy({ skills: { mode: 'all' } });

    const response = await putRoute(
      request('PUT', `/api/agents/${agent.id}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
        body: JSON.stringify(policy),
      }),
      idContext(agent.id),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ policy, source: 'stored' });
    const listing = await (await versions.forWorkspace(WORKSPACE_A))?.list(agent.id);
    expect(listing?.versions).toHaveLength(1);
    expect(listing?.versions[0]).toMatchObject({
      number: 1,
      via: 'ui',
      summary: 'Console edit: policy',
      body: { definition: { policy, policySource: 'stored' } },
    });
    expect(listing?.pointers).toMatchObject([{ environment: 'local', number: 1 }]);
    expect(listing?.materialisedVersionId).toBe(listing?.versions[0]?.id);
  });

  it('a Builder may replace the policy of the agent it created, and no other Builder may', async () => {
    useMemoryRuntime();
    const agent = await createAsBuilderA();
    // `mode: 'all'` sidesteps the skill-assignment check (covered by its own test below), so this
    // test is provably about own/other ownership and not about an unrelated 409.
    const policy = validPolicy({ skills: { mode: 'all' } });
    const putBody = JSON.stringify(policy);

    const readByOther = await getRoute(
      request('GET', `/api/agents/${agent.id}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-b@example.test',
      }),
      idContext(agent.id),
    );
    expect(readByOther.status, await readByOther.clone().text()).toBe(200);

    const deniedPut = await putRoute(
      request('PUT', `/api/agents/${agent.id}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-b@example.test',
        body: putBody,
      }),
      idContext(agent.id),
    );
    expect(deniedPut.status).toBe(403);

    const allowedPut = await putRoute(
      request('PUT', `/api/agents/${agent.id}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
        body: putBody,
      }),
      idContext(agent.id),
    );
    expect(allowedPut.status, await allowedPut.clone().text()).toBe(200);
    expect(await allowedPut.json()).toMatchObject({ policy, source: 'stored' });

    const readAfter = await getRoute(
      request('GET', `/api/agents/${agent.id}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
      }),
      idContext(agent.id),
    );
    expect(await readAfter.json()).toMatchObject({ policy, source: 'stored' });
  });

  it('a foreign workspace id and a malformed id both answer exactly what a nonexistent id answers', async () => {
    useMemoryRuntime();
    const agent = await createAsBuilderA();
    const absentId = '99999999-9999-4999-8999-999999999999';

    const absent = await getRoute(
      request('GET', `/api/agents/${absentId}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
      }),
      idContext(absentId),
    );
    const malformed = await getRoute(
      request('GET', '/api/agents/not-a-uuid/policy', {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
      }),
      idContext('not-a-uuid'),
    );
    expect(absent.status).toBe(404);
    expect(malformed.status).toBe(404);
    const absentBody: unknown = await absent.json();
    expect(absentBody).toEqual(await malformed.json());
    expect(absentBody).toMatchObject({ error: { code: 'agent_not_found' } });

    // Sanity: the agent really exists, so the 404s above are concealment, not a broken fixture.
    const real = await getRoute(
      request('GET', `/api/agents/${agent.id}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
      }),
      idContext(agent.id),
    );
    expect(real.status).toBe(200);
  });

  it('refuses a policy naming a skill the agent has no assignment for (409 skill_not_assigned)', async () => {
    useMemoryRuntime();
    const agent = await createAsBuilderA();
    const response = await putRoute(
      request('PUT', `/api/agents/${agent.id}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
        body: JSON.stringify(validPolicy({ skills: { mode: 'allowlist', names: ['unassigned'] } })),
      }),
      idContext(agent.id),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'skill_not_assigned' } });
  });

  it('refuses a parseable bypassPermissions policy regardless of role (400)', async () => {
    useMemoryRuntime();
    const agent = await createAsBuilderA();
    const response = await putRoute(
      request('PUT', `/api/agents/${agent.id}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
        body: JSON.stringify(
          validPolicy({
            skills: { mode: 'all' },
            tools: {
              base: 'claude_code_preset',
              autoApprove: [],
              deny: [],
              permissionMode: 'bypassPermissions',
              allowDangerouslySkipPermissions: true,
            },
          }),
        ),
      }),
      idContext(agent.id),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'dangerous_permission_mode_refused' },
    });
  });

  it('refuses a body that fails the contract with 400 invalid_policy', async () => {
    useMemoryRuntime();
    const agent = await createAsBuilderA();
    const invalid = await putRoute(
      request('PUT', `/api/agents/${agent.id}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
        body: JSON.stringify({ engine: 'claude-agent-sdk' }),
      }),
      idContext(agent.id),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_policy' } });
  });

  // ADR-0065's two engine refusals, at the route rather than only at `parsePolicyBody`: the
  // acceptance criteria of #317 are stated about `PUT /api/agents/:id/policy`, so they are checked
  // where a client actually meets them.
  it('refuses an unregistered engine with 400 unsupported_engine', async () => {
    useMemoryRuntime();
    const agent = await createAsBuilderA();
    const response = await putRoute(
      request('PUT', `/api/agents/${agent.id}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
        body: JSON.stringify({ ...validPolicy(), engine: 'acp' }),
      }),
      idContext(agent.id),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported_engine' } });
  });

  it('refuses the pre-ADR-0065 `provider` discriminant with 400 invalid_body', async () => {
    useMemoryRuntime();
    const agent = await createAsBuilderA();
    const withoutEngine = Object.fromEntries(
      Object.entries(validPolicy()).filter(([key]) => key !== 'engine'),
    );
    const response = await putRoute(
      request('PUT', `/api/agents/${agent.id}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
        body: JSON.stringify({ ...withoutEngine, provider: 'claude-agent-sdk' }),
      }),
      idContext(agent.id),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_body' } });

    // And it is not stored under the old name either: the agent still reads its compiled policy.
    const read = await getRoute(
      request('GET', `/api/agents/${agent.id}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
      }),
      idContext(agent.id),
    );
    const { policy } = (await read.json()) as { policy: AgentPolicy };
    expect(policy.engine).toBe('claude-agent-sdk');
    expect(policy.limits).toEqual({ maxTurns: null, maxBudgetUsd: null });
  });
});

/**
 * ADR-0065 D3's "refuse, never ignore", at agent save (#318).
 *
 * The test descriptor is a `claude-agent-sdk` descriptor with a capability removed, and it
 * *replaces* the built-in one (see `apps/web/server/engines/registry.ts`): `AgentPolicy` has one
 * arm, so no policy body can name a different engine and still parse, and a deployment that
 * installs the engine without MCP is the state this refusal is actually about.
 */
describe('PUT /api/agents/:id/policy — engine capability check', () => {
  afterEach(() => {
    clearEnginesRegisteredForTests();
  });

  function registerClaudeWithout(capability: 'mcp' | 'skills'): void {
    registerEngineForTests({
      id: 'claude-agent-sdk',
      displayName: `Claude Agent SDK (test: no ${capability})`,
      version: 'test',
      capabilities: {
        mcp: capability !== 'mcp',
        skills: capability !== 'skills',
        subagents: false,
        resume: true,
        fork: false,
        interrupt: true,
        streamingText: false,
        reasoning: true,
        maxTurns: 'native',
        maxBudget: 'native',
        wireProtocols: ['anthropic-messages'],
      },
    });
  }

  async function createWithAssignments(
    assignments: AgentResourceAssignments,
  ): Promise<AgentResource> {
    const response = await createAgentRoute(
      request('POST', '/api/agents', {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
        body: JSON.stringify({ agent: JSON.parse(CREATE_BODY) as unknown, assignments }),
      }),
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const { agent } = (await response.json()) as { agent: AgentResource };
    return agent;
  }

  async function put(agentId: string, policy: AgentPolicy): Promise<Response> {
    return putRoute(
      request('PUT', `/api/agents/${agentId}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
        body: JSON.stringify(policy),
      }),
      idContext(agentId),
    );
  }

  it('refuses an agent with a connector on an engine whose mcp is false', async () => {
    useMemoryRuntime();
    const agent = await createWithAssignments({
      files: [],
      skillIds: [],
      connectorIds: [CONNECTOR_ID],
    });
    registerClaudeWithout('mcp');

    const response = await put(agent.id, validPolicy({ skills: { mode: 'allowlist', names: [] } }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      // The capability rides in `details` as one entry, so a client branches on it, not on prose.
      error: { code: 'engine_capability_unsupported', details: ['mcp'] },
    });
  });

  it('refuses an agent with a skill on an engine whose skills is false', async () => {
    useMemoryRuntime();
    const agent = await createWithAssignments({
      files: [],
      skillIds: [SKILL_ID],
      connectorIds: [],
    });
    registerClaudeWithout('skills');

    const response = await put(agent.id, validPolicy());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: 'engine_capability_unsupported', details: ['skills'] },
    });
  });

  it('does not store the refused policy: the agent still reads its compiled one', async () => {
    useMemoryRuntime();
    const agent = await createWithAssignments({
      files: [],
      skillIds: [],
      connectorIds: [CONNECTOR_ID],
    });
    registerClaudeWithout('mcp');
    await put(agent.id, validPolicy({ skills: { mode: 'allowlist', names: [] } }));

    const read = await getRoute(
      request('GET', `/api/agents/${agent.id}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
      }),
      idContext(agent.id),
    );
    const { policy } = (await read.json()) as { policy: AgentPolicy };
    expect(policy.limits).toEqual({ maxTurns: null, maxBudgetUsd: null });
  });

  it('accepts the same agent on the engine as this deployment really registers it', async () => {
    // "Nothing changes for claude-agent-sdk agents": the same connector, the same policy, no test
    // descriptor — a 200. Without this, the two refusals above would also pass for an engine that
    // refused everything.
    useMemoryRuntime();
    const agent = await createWithAssignments({
      files: [],
      skillIds: [SKILL_ID],
      connectorIds: [CONNECTOR_ID],
    });

    const response = await put(agent.id, validPolicy());

    expect(response.status, await response.clone().text()).toBe(200);
  });

  it('refuses an engine with no skills only when a skill would really be materialised', async () => {
    // An allowlist naming nothing hands the engine no skill, so there is nothing to refuse — the
    // check is about what a run receives, not about what the agent happens to be assigned.
    useMemoryRuntime();
    const agent = await createWithAssignments({
      files: [],
      skillIds: [SKILL_ID],
      connectorIds: [],
    });
    registerClaudeWithout('skills');

    const response = await put(agent.id, validPolicy({ skills: { mode: 'allowlist', names: [] } }));

    expect(response.status, await response.clone().text()).toBe(200);
  });
});

describe('PUT /api/agents/:id/policy — an engine switch carries the narrowing (ADR-0074 D12)', () => {
  async function created(): Promise<AgentResource> {
    const response = await createAgentRoute(
      request('POST', '/api/agents', {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
        body: CREATE_BODY,
      }),
    );
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as AgentResource;
  }

  async function put(agentId: string, policy: AgentPolicy): Promise<Response> {
    return putRoute(
      request('PUT', `/api/agents/${agentId}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
        body: JSON.stringify(policy),
      }),
      idContext(agentId),
    );
  }

  async function read(agentId: string): Promise<AgentPolicy> {
    const response = await getRoute(
      request('GET', `/api/agents/${agentId}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
      }),
      idContext(agentId),
    );
    return ((await response.json()) as { policy: AgentPolicy }).policy;
  }

  const OPENAI_BODY: AgentPolicy = {
    engine: 'openai-agents',
    skills: { mode: 'allowlist', names: [] },
    limits: { maxTurns: 20, maxBudgetUsd: null },
  };

  it("writes the Claude arm's Bash denial and plan mode into the new arm as withheld switches", async () => {
    useMemoryRuntime();
    const agent = await created();
    const stored = validPolicy({ skills: { mode: 'allowlist', names: [] } });
    if (stored.engine !== 'claude-agent-sdk') throw new Error('fixture');
    expect(
      (await put(agent.id, { ...stored, tools: { ...stored.tools, permissionMode: 'plan' } }))
        .status,
    ).toBe(200);

    const response = await put(agent.id, OPENAI_BODY);

    expect(response.status, await response.clone().text()).toBe(200);
    const expected = { ...OPENAI_BODY, withheldPermissions: ['writeFiles', 'runCommands'] };
    expect(await response.json()).toEqual({ policy: expected, source: 'stored' });
    expect(await read(agent.id)).toEqual(expected);
  });

  it('refuses 422 engine_switch_would_widen naming every MCP denial, and stores nothing', async () => {
    useMemoryRuntime();
    const agent = await created();
    const stored = validPolicy({ skills: { mode: 'allowlist', names: [] } });
    if (stored.engine !== 'claude-agent-sdk') throw new Error('fixture');
    const narrowed: AgentPolicy = {
      ...stored,
      tools: { ...stored.tools, deny: ['Bash', 'mcp__github__delete_repo', 'mcp__jira__*'] },
    };
    expect((await put(agent.id, narrowed)).status).toBe(200);
    // `github` is a connector of the workspace, so its rule is stored by id (ADR-0113 SD13, #1109).
    const storedDeny = `mcp__connector-${CONNECTOR_ID}__delete_repo`;

    const response = await put(agent.id, OPENAI_BODY);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'engine_switch_would_widen',
        details: [storedDeny, 'mcp__jira__*'],
        message: expect.stringContaining(`${storedDeny} (github), mcp__jira__*.`) as unknown,
      },
    });
    expect(await read(agent.id)).toEqual({
      ...narrowed,
      tools: { ...narrowed.tools, deny: ['Bash', storedDeny, 'mcp__jira__*'] },
    });
  });

  describe('connectorNames: the stored connector-<id> rules, labelled for a person (#1121)', () => {
    const GONE_ID = '99999999-9999-4999-8999-999999999999';

    async function body(agentId: string): Promise<Record<string, unknown>> {
      const response = await getRoute(
        request('GET', `/api/agents/${agentId}/policy`, {
          workspace: WORKSPACE_A,
          actor: 'builder-a@example.test',
        }),
        idContext(agentId),
      );
      return (await response.json()) as Record<string, unknown>;
    }

    function denying(deny: string[]): AgentPolicy {
      const stored = validPolicy({ skills: { mode: 'allowlist', names: [] } });
      if (stored.engine !== 'claude-agent-sdk') throw new Error('fixture');
      return { ...stored, tools: { ...stored.tools, deny } };
    }

    it('answers the connector name next to the stored rule, on GET and on the PUT that saved it', async () => {
      useMemoryRuntime();
      const agent = await created();
      const server = `connector-${CONNECTOR_ID}`;

      const saved = await put(agent.id, denying(['mcp__github__delete_repo']));

      expect(saved.status).toBe(200);
      const expected = {
        policy: denying([`mcp__${server}__delete_repo`]),
        source: 'stored',
        connectorNames: { [server]: 'github' },
      };
      expect(await saved.json()).toEqual(expected);
      expect(await body(agent.id)).toEqual(expected);
    });

    it('omits the field when no rule is stored by connector id', async () => {
      useMemoryRuntime();
      const agent = await created();
      expect((await put(agent.id, denying(['Bash', 'mcp__jira__*']))).status).toBe(200);

      expect(await body(agent.id)).not.toHaveProperty('connectorNames');
    });

    it('opens no version store for a policy with no rule stored by connector id', async () => {
      const versions = useMemoryRuntime();
      const agent = await created();
      expect((await put(agent.id, denying(['Bash', 'mcp__jira__*']))).status).toBe(200);
      configureAgentVersionsRuntime({
        versions: {
          ...versions,
          forWorkspace: () => Promise.reject(new Error('unexpected version store read')),
        },
      });

      expect(await body(agent.id)).toEqual({
        policy: denying(['Bash', 'mcp__jira__*']),
        source: 'stored',
      });
    });

    it('leaves the rule of a connector the workspace no longer has unlabelled', async () => {
      useMemoryRuntime();
      const agent = await created();
      const gone = `mcp__connector-${GONE_ID}__x`;
      expect((await put(agent.id, denying([gone]))).status).toBe(200);

      const response = await body(agent.id);

      expect(response).not.toHaveProperty('connectorNames');
      expect(response['policy']).toEqual(denying([gone]));
    });
  });

  it('carries nothing for an agent with no stored policy: its checkboxes are the whole narrowing', async () => {
    useMemoryRuntime();
    const agent = await created();

    const response = await put(agent.id, OPENAI_BODY);

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ policy: OPENAI_BODY, source: 'stored' });
  });

  it('carries withheld switches back into tools.deny on the reverse switch', async () => {
    useMemoryRuntime();
    const agent = await created();
    expect(
      (await put(agent.id, { ...OPENAI_BODY, withheldPermissions: ['runCommands'] })).status,
    ).toBe(200);
    const back = validPolicy({ skills: { mode: 'allowlist', names: [] } });
    if (back.engine !== 'claude-agent-sdk') throw new Error('fixture');

    const response = await put(agent.id, { ...back, tools: { ...back.tools, deny: [] } });

    expect(response.status, await response.clone().text()).toBe(200);
    const { policy } = (await response.json()) as { policy: AgentPolicy };
    expect(policy.engine === 'claude-agent-sdk' && policy.tools.deny).toEqual([
      'Bash',
      'BashOutput',
      'KillShell',
    ]);
  });

  it('replaces verbatim on the same engine, which is how an owner widens on purpose', async () => {
    useMemoryRuntime();
    const agent = await created();
    expect(
      (await put(agent.id, { ...OPENAI_BODY, withheldPermissions: ['runCommands'] })).status,
    ).toBe(200);

    const response = await put(agent.id, OPENAI_BODY);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ policy: OPENAI_BODY, source: 'stored' });
  });
});

/**
 * `aw.agents.import` (ADR-0076) is a client-side composition: `POST /api/agents` with the resolved
 * assignments, then — for a stored policy — this `PUT`. So an imported `openai-agents` definition
 * meets exactly the checks a hand-made `PUT` does, on an agent whose column is still NULL: a
 * creation, not a switch, so nothing is carried (ADR-0074 D12).
 */
describe('PUT /api/agents/:id/policy — the step that stores an imported openai-agents definition', () => {
  async function imported(assignments: AgentResourceAssignments): Promise<AgentResource> {
    const response = await createAgentRoute(
      request('POST', '/api/agents', {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
        body: JSON.stringify({ agent: JSON.parse(CREATE_BODY) as unknown, assignments }),
      }),
    );
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { agent: AgentResource }).agent;
  }

  async function put(agentId: string, policy: unknown): Promise<Response> {
    return putRoute(
      request('PUT', `/api/agents/${agentId}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
        body: JSON.stringify(policy),
      }),
      idContext(agentId),
    );
  }

  const OPENAI_DEFINITION_POLICY: AgentPolicy = {
    engine: 'openai-agents',
    skills: { mode: 'allowlist', names: [] },
    limits: { maxTurns: 20, maxBudgetUsd: null },
    withheldPermissions: ['writeFiles', 'runCommands'],
  };

  it('stores the definition verbatim, withheld switches included, with nothing carried', async () => {
    useMemoryRuntime();
    const agent = await imported({ files: [], skillIds: [], connectorIds: [] });

    const response = await put(agent.id, OPENAI_DEFINITION_POLICY);

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ policy: OPENAI_DEFINITION_POLICY, source: 'stored' });
  });

  it('refuses 422 engine_capability_unsupported when the definition assigns a skill', async () => {
    useMemoryRuntime();
    const agent = await imported({ files: [], skillIds: [SKILL_ID], connectorIds: [] });

    const response = await put(agent.id, {
      ...OPENAI_DEFINITION_POLICY,
      skills: { mode: 'allowlist', names: ['triage'] },
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: 'engine_capability_unsupported', details: ['skills'] },
    });
  });

  it('refuses 400 for a withheld switch the contract does not know', async () => {
    useMemoryRuntime();
    const agent = await imported({ files: [], skillIds: [], connectorIds: [] });

    const response = await put(agent.id, {
      ...OPENAI_DEFINITION_POLICY,
      withheldPermissions: ['launchMissiles'],
    });

    expect(response.status).toBe(400);
  });

  it('refuses 400 unsupported_engine for an engine this deployment does not register', async () => {
    useMemoryRuntime();
    const agent = await imported({ files: [], skillIds: [], connectorIds: [] });

    const response = await put(agent.id, { ...OPENAI_DEFINITION_POLICY, engine: 'no-such-engine' });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported_engine' } });
  });
});
