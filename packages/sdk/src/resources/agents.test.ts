import { describe, expect, expectTypeOf, it } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { HttpClient } from '../http.js';
import type { BuiltinAgentProblemCode } from '../index.js';
import { fetchDouble, fixtures, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { AgentsClient, type ListAgentsOptions } from './agents.js';
import type {
  AgentPolicy,
  AgentResource,
  CreateAgentInput,
  CreateAgentOptions,
  CreateAgentWithAssignmentsResponse,
} from '@indx-workspace/contracts/agents';
import type {
  AgentVersionCheckResponse,
  CreateAgentFromVersionRequestInput,
  CreateAgentFromVersionResponse,
} from '@indx-workspace/contracts/agent-versions';
import type { RequestOptions } from '../http.js';

const AGENT = '77777777-7777-4777-8777-777777777777';

const agent = {
  id: AGENT,
  workspaceId: '44444444-4444-4444-8444-444444444444',
  name: 'Support triage',
  instructions: 'Answer support mail.',
  modelConnectionId: null,
  model: 'claude-sonnet-4-5',
  runtimeProfileId: null,
  permissions: {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  },
  createdBy: null,
  ownerPrincipalId: 'principal-1',
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

const assignments = { files: [], skillIds: [], connectorIds: [], storageGrants: [] };
const principalIds = ['99999999-9999-4999-8999-999999999999'];

const policy: AgentPolicy = {
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
};

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly agents: AgentsClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { agents: new AgentsClient(http), calls: api.calls };
}

describe('AgentsClient.list/get', () => {
  it('reads the list envelope and the bare item', async () => {
    const { agents, calls } = client(() => json(200, { agents: [agent] }));
    expect(await agents.list()).toEqual([agent]);
    expect(calls[0]?.url.pathname).toBe('/api/agents');
  });

  it('reads lineage and archivedAt on get and list, and none on a person-made agent (#1851)', async () => {
    const made = {
      ...agent,
      createdByAgent: { agentId: AGENT, version: 2, runId: 'run_abc' },
      archivedAt: '2026-09-22T10:00:00.000Z',
    };
    const { agents } = client((request) =>
      request.url.pathname === '/api/agents'
        ? json(200, { agents: [made, agent] })
        : json(200, made),
    );
    const [first, second] = await agents.list();
    expect(first?.createdByAgent).toEqual({ agentId: AGENT, version: 2, runId: 'run_abc' });
    expect(first?.archivedAt).toBe('2026-09-22T10:00:00.000Z');
    expect(second).not.toHaveProperty('createdByAgent');
    expect(second).not.toHaveProperty('archivedAt');
    expect((await agents.get(AGENT)).createdByAgent?.version).toBe(2);
    expectTypeOf(first?.createdByAgent?.agentId).toEqualTypeOf<string | null | undefined>();
    expectTypeOf(first?.archivedAt).toEqualTypeOf<string | undefined>();
  });

  it("lists archived agents only when asked with archived: 'include' (#1851)", async () => {
    const { agents, calls } = client(() => json(200, { agents: [agent] }));
    await agents.list();
    await agents.list({ archived: 'include' });
    expect(calls[0]?.url.search).toBe('');
    expect(calls[1]?.url.search).toBe('?archived=include');
    expectTypeOf<Parameters<AgentsClient['list']>[0]>().toEqualTypeOf<
      ListAgentsOptions | undefined
    >();
    expectTypeOf<{ archived: 'include' }>().toExtend<ListAgentsOptions>();
    expectTypeOf<ListAgentsOptions['archived']>().toEqualTypeOf<'include' | undefined>();
  });

  it('surfaces a missing agent by code', async () => {
    const { agents } = client(() =>
      json(404, { error: { code: 'agent_not_found', message: 'No such agent.' } }),
    );
    const failure = await agents.get(AGENT).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('agent_not_found');
  });
});

describe('AgentsClient.restore (#1851)', () => {
  it('posts to the restore path with no body and reads the agent', async () => {
    const { agents, calls } = client(() => json(200, agent));
    expect(await agents.restore(AGENT)).toEqual(agent);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/agents/${AGENT}/restore`);
    expect(calls[0]?.json).toBeUndefined();
  });

  it('surfaces a refusal by status and code', async () => {
    const { agents } = client(() =>
      json(403, { error: { code: 'forbidden', message: 'Not allowed.' } }),
    );
    const problem = (await agents.restore(AGENT).catch((e: unknown) => e)) as ApiProblemError;
    expect(problem).toBeInstanceOf(ApiProblemError);
    expect([problem.status, problem.code]).toEqual([403, 'forbidden']);
  });
});

describe('AgentsClient.create', () => {
  it('without assignments: posts the bare input and reads the bare 201', async () => {
    const { agents, calls } = client(() => json(201, agent));
    const input = {
      name: 'Support triage',
      instructions: 'Answer support mail.',
      modelConnectionId: null,
      model: 'claude-sonnet-4-5',
      permissions: agent.permissions,
    };
    expect(await agents.create(input)).toEqual(agent);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe('/api/agents');
    expect(call?.json).toEqual(input);
  });

  it('K-2: with assignments, issues exactly one request whose body is { agent, assignments }', async () => {
    const { agents, calls } = client(() => json(201, { agent, assignments }));
    const input = {
      name: 'Support triage',
      instructions: 'Answer support mail.',
      modelConnectionId: null,
      model: 'claude-sonnet-4-5',
      permissions: agent.permissions,
    };
    const result = await agents.create(input, { assignments });
    expect(result).toEqual({ agent, assignments });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe('/api/agents');
    expect(call?.json).toEqual({ agent: input, assignments });
  });
});

describe('AgentsClient.create from a version (S1-09, issue #447)', () => {
  const version = fixtures.agentVersion();
  const fromVersion = {
    version: { summary: version.summary, via: 'api', body: version.body },
  } satisfies CreateAgentFromVersionRequestInput;

  it('posts {version} as given and reads the 201 agent and version', async () => {
    const created = { agent: fixtures.agent(), version };
    const { agents, calls } = client(() => json(201, created));
    expect(await agents.create(fromVersion)).toEqual(created);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/agents');
    expect(calls[0]?.json).toEqual(fromVersion);
  });

  it('with dryRun: true, sends the flag and reads the 200 check', async () => {
    const { agents, calls } = client(() => json(200, { ok: true, number: 1 }));
    expect(await agents.create({ ...fromVersion, dryRun: true })).toEqual({ ok: true, number: 1 });
    expect(calls[0]?.json).toEqual({ ...fromVersion, dryRun: true });
  });

  it('forwards an assignments option beside the version, so the server refuses the mixed body', async () => {
    const { agents, calls } = client(() =>
      json(400, {
        error: {
          code: 'invalid_agent_version',
          message: 'The body is not a create-from-version request.',
          details: ['(root): Unrecognized key: "assignments"'],
        },
      }),
    );
    // An untyped caller's options: the typed version overloads take RequestOptions only.
    const options: RequestOptions & CreateAgentOptions = { assignments };
    const failure = await agents.create(fromVersion, options).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('invalid_agent_version');
    expect(calls[0]?.json).toEqual({ ...fromVersion, assignments });
  });

  it('surfaces 409 agent_name_conflict by status and code', async () => {
    const { agents } = client(() =>
      json(409, { error: { code: 'agent_name_conflict', message: 'The name is taken.' } }),
    );
    const failure = await agents.create(fromVersion).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    const problem = failure as ApiProblemError;
    expect([problem.status, problem.code]).toEqual([409, 'agent_name_conflict']);
  });

  it('surfaces 403 builder_name_reserved on a create and on a rename', async () => {
    const { agents } = client(() =>
      json(403, { error: { code: 'builder_name_reserved', message: 'This name is reserved.' } }),
    );
    for (const refused of [
      agents.create(fromVersion),
      agents.update(AGENT, { name: 'hr-onboarding-coordinator' }),
    ]) {
      const problem = (await refused.catch((e: unknown) => e)) as ApiProblemError;
      expect(problem).toBeInstanceOf(ApiProblemError);
      expect([problem.status, problem.code]).toEqual([403, 'builder_name_reserved']);
    }
  });

  it('types the built-in agent problem codes, builder_name_reserved among them', () => {
    expectTypeOf<BuiltinAgentProblemCode>().toEqualTypeOf<
      'builtin_agent_read_only' | 'builder_name_reserved'
    >();
  });

  it('takes the legacy path for a legacy input carrying version: undefined', async () => {
    const { agents, calls } = client(() => json(201, agent));
    const legacy = {
      name: 'Support triage',
      instructions: '',
      modelConnectionId: null,
      model: null,
      permissions: agent.permissions,
    };
    const maybeVersion: CreateAgentFromVersionRequestInput['version'] | undefined = undefined;
    const input = { ...legacy, version: maybeVersion };
    expect(await agents.create(input)).toEqual(agent);
    expect(calls[0]?.json).toEqual(legacy);
  });

  it('takes the legacy path for an untyped non-object input, so the server answers it', async () => {
    const { agents, calls } = client(() =>
      json(400, { error: { code: 'invalid_request', message: 'The body is not an agent.' } }),
    );
    const untyped: unknown = null;
    const failure = await agents.create(untyped as CreateAgentInput).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect(calls).toHaveLength(1);
  });

  it('resolves each input shape to its own answer type', async () => {
    const agents = client(() => json(500, { error: { code: 'internal', message: 'No.' } })).agents;
    const legacy = {
      name: 'Support triage',
      instructions: '',
      modelConnectionId: null,
      model: null,
      permissions: agent.permissions,
    };
    const plain = agents.create(legacy);
    const withAssignments = agents.create(legacy, { assignments });
    const created = agents.create(fromVersion);
    const checked = agents.create({ ...fromVersion, dryRun: true });
    expectTypeOf(plain).resolves.toEqualTypeOf<AgentResource>();
    expectTypeOf(withAssignments).resolves.toEqualTypeOf<CreateAgentWithAssignmentsResponse>();
    expectTypeOf(created).resolves.toEqualTypeOf<CreateAgentFromVersionResponse>();
    expectTypeOf(checked).resolves.toEqualTypeOf<AgentVersionCheckResponse>();
    const settled = await Promise.allSettled([plain, withAssignments, created, checked]);
    expect(settled.map((outcome) => outcome.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
      'rejected',
    ]);
  });
});

describe('AgentsClient.getResourceAssignments/replaceResourceAssignments', () => {
  it('reads and replaces the assignments envelope', async () => {
    const { agents, calls } = client(() => json(200, { assignments }));
    expect(await agents.getResourceAssignments(AGENT)).toEqual(assignments);
    expect(calls[0]?.url.pathname).toBe(`/api/agents/${AGENT}/resources`);

    const replaced = await agents.replaceResourceAssignments(AGENT, assignments);
    expect(replaced).toEqual(assignments);
    expect(calls[1]?.method).toBe('PUT');
    expect(calls[1]?.json).toEqual(assignments);
  });
});

describe('AgentsClient.getGrants/replaceGrants', () => {
  it('reads and atomically replaces the principal-id list', async () => {
    const { agents, calls } = client(() => json(200, { principalIds }));
    expect(await agents.getGrants(AGENT)).toEqual(principalIds);
    expect(calls[0]?.url.pathname).toBe(`/api/agents/${AGENT}/grants`);

    expect(await agents.replaceGrants(AGENT, principalIds)).toEqual(principalIds);
    expect(calls[1]?.method).toBe('PUT');
    expect(calls[1]?.json).toEqual({ principalIds });
  });

  it('refuses a successful response containing a malformed principal id', async () => {
    const { agents } = client(() => json(200, { principalIds: ['not-a-uuid'] }));
    const failure = await agents.getGrants(AGENT).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContractViolationError);
  });
});

describe('AgentsClient.getPolicy', () => {
  it('reads the policy envelope and unwraps it', async () => {
    const { agents, calls } = client(() => json(200, { policy }));
    expect(await agents.getPolicy(AGENT)).toEqual(policy);
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.pathname).toBe(`/api/agents/${AGENT}/policy`);
    expect(call?.json).toBeUndefined();
  });

  it('surfaces 403 and 404 by code', async () => {
    const denied = client(() => json(403, { error: { code: 'forbidden', message: 'No.' } }));
    const forbiddenErr = await denied.agents.getPolicy(AGENT).catch((e: unknown) => e);
    expect((forbiddenErr as ApiProblemError).status).toBe(403);
    expect((forbiddenErr as ApiProblemError).code).toBe('forbidden');

    const missing = client(() =>
      json(404, { error: { code: 'agent_not_found', message: 'No such agent.' } }),
    );
    const notFound = await missing.agents.getPolicy(AGENT).catch((e: unknown) => e);
    expect((notFound as ApiProblemError).status).toBe(404);
    expect((notFound as ApiProblemError).code).toBe('agent_not_found');
  });

  it('refuses a 200 missing a required field, as a contract violation', async () => {
    const { agents } = client(() => json(200, { policy: { ...policy, tools: undefined } }));
    const failure = await agents.getPolicy(AGENT).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { agents, calls } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const failure = await agents
      .getPolicy(AGENT, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('AgentsClient.replacePolicy', () => {
  it('puts the policy body and reads what the server stored', async () => {
    const { agents, calls } = client(() => json(200, { policy }));
    expect(await agents.replacePolicy(AGENT, policy)).toEqual(policy);
    const [call] = calls;
    expect(call?.method).toBe('PUT');
    expect(call?.url.pathname).toBe(`/api/agents/${AGENT}/policy`);
    expect(call?.json).toEqual(policy);
  });

  it('surfaces skill_not_assigned (409) and dangerous_permission_mode_refused (400) by code', async () => {
    const unassigned = client(() =>
      json(409, {
        error: {
          code: 'skill_not_assigned',
          message: 'The policy allowlists an unassigned skill.',
        },
      }),
    );
    const conflict = await unassigned.agents.replacePolicy(AGENT, policy).catch((e: unknown) => e);
    expect((conflict as ApiProblemError).status).toBe(409);
    expect((conflict as ApiProblemError).code).toBe('skill_not_assigned');

    const dangerous = client(() =>
      json(400, {
        error: {
          code: 'dangerous_permission_mode_refused',
          message: 'bypassPermissions cannot be set through this route.',
        },
      }),
    );
    const refused = await dangerous.agents.replacePolicy(AGENT, policy).catch((e: unknown) => e);
    expect((refused as ApiProblemError).status).toBe(400);
    expect((refused as ApiProblemError).code).toBe('dangerous_permission_mode_refused');
  });

  it('surfaces engine_capability_unsupported (422) with the capability in details (ADR-0065)', async () => {
    const { agents } = client(() =>
      json(422, {
        error: {
          code: 'engine_capability_unsupported',
          message: "The engine 'pi' does not support mcp, and this agent is assigned connectors.",
          details: ['mcp'],
        },
      }),
    );
    const refused = await agents.replacePolicy(AGENT, policy).catch((e: unknown) => e);
    expect((refused as ApiProblemError).status).toBe(422);
    expect((refused as ApiProblemError).code).toBe('engine_capability_unsupported');
    // The capability travels in `details`, which is what a caller branches on: the message is prose
    // the server chose and may change, `['mcp']` is the contract (`ENGINE_CAPABILITY_KEYS`).
    expect((refused as ApiProblemError).details).toEqual(['mcp']);
  });

  it('surfaces a missing agent by code', async () => {
    const { agents } = client(() =>
      json(404, { error: { code: 'agent_not_found', message: 'No such agent.' } }),
    );
    const failure = await agents.replacePolicy(AGENT, policy).catch((e: unknown) => e);
    expect((failure as ApiProblemError).status).toBe(404);
    expect((failure as ApiProblemError).code).toBe('agent_not_found');
  });

  it('refuses a 200 whose skills union mixes both discriminant arms, as a contract violation', async () => {
    const { agents } = client(() =>
      json(200, { policy: { ...policy, skills: { mode: 'all', names: ['x'] } } }),
    );
    const failure = await agents.replacePolicy(AGENT, policy).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { agents, calls } = client(() =>
      Promise.reject(new DOMException('aborted', 'AbortError')),
    );
    const failure = await agents
      .replacePolicy(AGENT, policy, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
