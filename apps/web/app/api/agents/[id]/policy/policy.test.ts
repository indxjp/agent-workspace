import { describe, expect, it } from 'vitest';
import { GET as getRoute, PUT as putRoute } from './route';
import type { AgentPolicy } from '../../../../../contracts/agents';
import {
  createAsBuilderA,
  idContext,
  request,
  useMemoryRuntime,
  validPolicy,
  WORKSPACE_A,
} from './policy.test-support';

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
