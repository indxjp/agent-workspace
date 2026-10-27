import { describe, expect, it } from 'vitest';

import type { AgentVersionDraftInput } from '@indx-workspace/contracts/agent-versions';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { createClient, type AgentWorkspaceClient } from '../index.js';
import { agentFromVersionBody, defineAgent, toAgentVersionBody } from '../define/index.js';
import { printAgentProject } from '../portable/index.js';
import { fetchDouble, fixtures, jsonResponse, type RecordedRequest } from '../testing.js';

/** S1-09 (issue #447; ADR-0101): `agents.versions.*` and `agents.pointers.set`. */

const version = fixtures.agentVersion();
const pointer = fixtures.agentVersionPointer();
const draft: AgentVersionDraftInput = {
  summary: version.summary,
  via: 'api',
  body: version.body,
};

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly aw: AgentWorkspaceClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const aw = createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { aw, calls: api.calls };
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error,
  );
}

describe('AgentVersionsClient.list', () => {
  it('reads the items, the pointers and the materialised version from GET /api/agents/:id/versions', async () => {
    const { aw, calls } = client(() =>
      jsonResponse(200, { items: [version], pointers: [pointer], materialised: 1 }),
    );
    // A server older than the pointer history (#615) or the scores (#714) sends no `moves` or
    // `evaluations`, which read as none.
    expect(await aw.agents.versions.list(version.agentId)).toEqual({
      items: [version],
      pointers: [pointer],
      materialised: 1,
      moves: [],
      evaluations: [],
    });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe(`/api/agents/${version.agentId}/versions`);
  });

  it('[US-BLD-03][api][sdk] lists a version the Builder saved with source builder', async () => {
    const saved = fixtures.agentVersion({ via: 'builder' });
    const { aw } = client(() =>
      jsonResponse(200, { items: [saved], pointers: [], materialised: 1 }),
    );
    expect((await aw.agents.versions.list(saved.agentId)).items.map((i) => i.via)).toEqual([
      'builder',
    ]);
  });

  it('[US-BLD-06][api][sdk] lists the version the Builder saved and writes it out as code', async () => {
    // A body as the Builder writes one: what defineAgent() makes, saved with via: 'builder'.
    const body = toAgentVersionBody(
      defineAgent({ name: 'refunds', instructions: 'Refund politely.' }),
    );
    const base = fixtures.agentVersion();
    const built = fixtures.agentVersion({ number: 2, via: 'builder', body });
    const { aw } = client(() =>
      jsonResponse(200, { items: [base, built], pointers: [], materialised: 2 }),
    );
    const { items } = await aw.agents.versions.list(built.agentId);
    const saved = items.find((item) => item.via === 'builder');
    if (saved === undefined) throw new Error('the listing has no version the Builder saved');
    const source = { body: saved.body };
    const printed = printAgentProject(source);
    const { name } = saved.body.definition.agent;
    expect(printed.files.map((file) => file.path)).toEqual([
      `agents/${name}.ts`,
      `agents/${name}.md`,
    ]);
    expect(printed.files[0]?.text).toMatchInlineSnapshot(`
      "import { defineAgent } from '@indx-workspace/sdk/define';

      export default defineAgent({
        name: 'refunds',
        instructions: {
          file: './refunds.md',
        },
        model: 'default',
        files: [],
      });
      "
    `);
    expect(printed.files[1]?.text).toBe('Refund politely.');
    // The body has no field the printer would drop, and what it prints from is this body.
    const read = agentFromVersionBody(source);
    expect(read.dropped).toStrictEqual([]);
    expect(toAgentVersionBody(read.value.agent)).toStrictEqual(saved.body);
  });

  it('percent-encodes the agent id as one path segment', async () => {
    const { aw, calls } = client(() =>
      jsonResponse(200, { items: [], pointers: [], materialised: null }),
    );
    await aw.agents.versions.list('a/b');
    expect(calls[0]?.url.pathname).toBe('/api/agents/a%2Fb/versions');
  });
});

describe('AgentVersionsClient.create/check', () => {
  it('posts the draft as given and reads the 201 version', async () => {
    const { aw, calls } = client(() => jsonResponse(201, version));
    expect(await aw.agents.versions.create(version.agentId, draft)).toEqual(version);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/agents/${version.agentId}/versions`);
    expect(calls[0]?.json).toEqual(draft);
  });

  it('check posts the draft with dryRun: true and reads the 200 check', async () => {
    const { aw, calls } = client(() => jsonResponse(200, { ok: true, number: 2 }));
    expect(await aw.agents.versions.check(version.agentId, draft)).toEqual({ ok: true, number: 2 });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/agents/${version.agentId}/versions`);
    expect(calls[0]?.json).toEqual({ ...draft, dryRun: true });
  });

  it('surfaces 422 agent_definition_references_missing with its status, code and details', async () => {
    const { aw } = client(() =>
      jsonResponse(422, {
        error: {
          code: 'agent_definition_references_missing',
          message: 'The definition names resources this workspace does not have.',
          details: ['connector:crm'],
        },
      }),
    );
    const failure = await failureOf(aw.agents.versions.create(version.agentId, draft));
    expect(failure).toBeInstanceOf(ApiProblemError);
    const problem = failure as ApiProblemError;
    expect(problem.status).toBe(422);
    expect(problem.code).toBe('agent_definition_references_missing');
    expect(problem.details).toEqual(['connector:crm']);
  });

  it('reports a malformed 201 as a contract violation naming agents.createVersion', async () => {
    const { aw } = client(() => jsonResponse(201, { ...version, number: 0 }));
    const failure = await failureOf(aw.agents.versions.create(version.agentId, draft));
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).message).toContain('agents.createVersion');
  });

  it('reports an aborted signal as an aborted transport failure', async () => {
    const { aw, calls } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const failure = await failureOf(
      aw.agents.versions.check(version.agentId, draft, { signal: AbortSignal.abort() }),
    );
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('AgentPointersClient.set', () => {
  it('puts {environment, version} and reads the agent and the pointer', async () => {
    const answer = { agent: fixtures.agent(), pointer };
    const { aw, calls } = client(() => jsonResponse(200, answer));
    expect(
      await aw.agents.pointers.set(version.agentId, { environment: 'local', version: 1 }),
    ).toEqual(answer);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url.pathname).toBe(`/api/agents/${version.agentId}/pointers`);
    expect(calls[0]?.json).toEqual({ environment: 'local', version: 1 });
  });

  it.each([
    ['surface_name_taken', ['surface:main']],
    ['agent_name_conflict', []],
  ] as const)('surfaces 409 %s by status and code', async (code, details) => {
    const { aw } = client(() =>
      jsonResponse(409, {
        error: { code, message: 'Refused.', ...(details.length === 0 ? {} : { details }) },
      }),
    );
    const failure = await failureOf(
      aw.agents.pointers.set(version.agentId, { environment: 'local', version: 2 }),
    );
    expect(failure).toBeInstanceOf(ApiProblemError);
    const problem = failure as ApiProblemError;
    expect([problem.status, problem.code]).toEqual([409, code]);
    expect(problem.details).toEqual(details);
  });
});

describe('AgentPointersClient.promote/rollback (issue #615)', () => {
  const moved = { environment: 'production', from: 6, to: 7, saved: true, bar: null } as const;

  it.each([
    ['promote', {}, 'promote', {}],
    ['promote', { version: 3 }, 'promote', { version: 3 }],
    ['checkPromote', {}, 'promote', { dryRun: true }],
    ['rollback', {}, 'rollback', {}],
    ['rollback', { environment: 'local' }, 'rollback', { environment: 'local' }],
    ['checkRollback', {}, 'rollback', { dryRun: true }],
  ] as const)('%s(%j) posts to /%s and reads the move', async (method, request, route, sent) => {
    const { aw, calls } = client(() => jsonResponse(200, moved));
    expect(await aw.agents.pointers[method](version.agentId, request)).toEqual(moved);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/agents/${version.agentId}/${route}`);
    expect(calls[0]?.json).toEqual(sent);
  });

  it.each([
    ['nothing_to_roll_back', 409],
    ['no_pointer', 409],
    ['promotion_not_evaluated', 409],
    ['promotion_gate_failed', 409],
  ] as const)('surfaces %s with its status and code', async (code, status) => {
    const { aw } = client(() => jsonResponse(status, { error: { code, message: 'Refused.' } }));
    const failure = await failureOf(aw.agents.pointers.rollback(version.agentId));
    expect(failure).toBeInstanceOf(ApiProblemError);
    const problem = failure as ApiProblemError;
    expect([problem.status, problem.code]).toEqual([status, code]);
  });

  it('reports a malformed 200 as a contract violation naming agents.promote', async () => {
    const { aw } = client(() => jsonResponse(200, { ...moved, to: 0 }));
    const failure = await failureOf(aw.agents.pointers.promote(version.agentId));
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).message).toContain('agents.promote');
  });
});
