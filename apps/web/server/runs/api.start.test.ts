import { afterEach, describe, expect, it } from 'vitest';
import { StartRunRequestSchema } from '@indx-workspace/contracts/runs';
import { clearApplicationContext } from '../application-context';
import { installTestDomains, resetTestRunApi } from '../application-context-fixtures';
import { startRun } from './api';
import { AGENT, errorCode, install, post, PRINCIPAL, SESSION, WORKSPACE } from './api.test-support';

afterEach(() => {
  resetTestRunApi();
});

async function configureOwnedAgent(ownerPrincipalId: string): Promise<string> {
  const { createInMemoryAgentStoreProvider } = await import('../agents/memory-store');
  const agents = createInMemoryAgentStoreProvider();
  installTestDomains({
    agents: {
      agents,
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
    },
  });
  const outcome = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'Support',
      instructions: '',
      modelConnectionId: null,
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    },
    { principalId: ownerPrincipalId, userId: PRINCIPAL.userId },
  );
  if (outcome.kind !== 'created') throw new Error(`fixture setup failed: ${outcome.kind}`);
  return outcome.agent.id;
}
function installBuilderFor(agentId: string): void {
  install({
    authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'builder' }),
    findAgent: (principal, id) =>
      Promise.resolve(
        id === agentId
          ? { id: agentId, workspaceId: principal.workspaceId, engine: 'claude-agent-sdk' }
          : null,
      ),
  });
}

describe('POST /api/agents/:id/runs', () => {
  it('returns the documented invalid_agent_id for every authenticated role before permission lookup', async () => {
    for (const role of ['owner', 'admin', 'builder', 'viewer'] as const) {
      let lookups = 0;
      install({
        authenticate: () => Promise.resolve({ ...PRINCIPAL, role }),
        findAgent: () => {
          lookups += 1;
          return Promise.resolve(null);
        },
      });
      const response = await startRun(post('not-a-uuid', { prompt: 'hi' }), 'not-a-uuid');
      expect(response.status, role).toBe(400);
      expect(await errorCode(response), role).toBe('invalid_agent_id');
      expect(lookups, role).toBe(0);
    }
  });

  it('answers 429 daily_cost_cap_reached with the cap and the reset, and creates no run', async () => {
    const resetsAt = '2026-10-27T00:00:00.000Z';
    const harness = install({
      dailyCostCap: { refusal: () => Promise.resolve({ capUsd: 5, spentUsd: 5, resetsAt }) },
    });
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { code: string; details?: string[] } };
    expect(body.error.code).toBe('daily_cost_cap_reached');
    expect(body.error.details).toEqual(['capUsd: 5', `resetsAt: ${resetsAt}`]);
    expect((await harness.store.listRuns(WORKSPACE, { limit: 10 })).items).toHaveLength(0);
    expect(harness.launched).toHaveLength(0);
  });

  it('answers 409 agent_archived for an archived agent, and creates no run', async () => {
    const harness = install({
      findAgent: () =>
        Promise.resolve({
          id: AGENT,
          workspaceId: WORKSPACE,
          engine: 'claude-agent-sdk',
          archived: true,
        }),
    });
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('agent_archived');
    expect((await harness.store.listRuns(WORKSPACE, { limit: 10 })).items).toHaveLength(0);
    expect(harness.launched).toHaveLength(0);
  });
});

describe('POST /api/agents/:id/runs', () => {
  it('denies roles without an established grant before looking up the agent', async () => {
    let lookups = 0;
    install({
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'viewer' }),
      findAgent: () => {
        lookups += 1;
        return Promise.resolve(null);
      },
    });

    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(response.status).toBe(403);
    expect(lookups).toBe(0);
  });
  it('creates a queued run, launches it and points at the stream', async () => {
    const harness = install();
    const response = await startRun(post(AGENT, { prompt: 'summarise these contracts' }), AGENT);
    expect(response.status).toBe(202);
    const body = (await response.json()) as { run: Record<string, unknown>; events: string };
    expect(body.run['status']).toBe('queued');
    expect(body.run['agentId']).toBe(AGENT);
    expect(body.run['sessionId']).toBe(SESSION);
    expect(body.run['workspaceId']).toBe(WORKSPACE);
    expect(body.events).toBe(`/api/runs/${String(body.run['id'])}/events`);
    expect(response.headers.get('location')).toBe(body.events);
    expect(harness.launched).toHaveLength(1);
    expect(harness.launched[0]?.prompt).toBe('summarise these contracts');
  });
});

describe('POST /api/agents/:id/runs', () => {
  // RF-303 (ADR-0151): the committed run row is the acceptance. A launch handoff that throws does
  // not turn an accepted request into a 500; the run stays queued for the stale-run sweep.
  it('RF-303 answers 202 for a persisted run whose process-local launch handoff threw', async () => {
    const logged: unknown[] = [];
    const logger = {
      info: () => undefined,
      warn: () => undefined,
      error: (message: string, fields?: Readonly<Record<string, unknown>>) => {
        logged.push({ message, runId: fields?.['runId'] });
      },
      child: () => logger,
    };
    const harness = install({
      logger,
      launch: () => {
        throw new Error('process-local launch handoff failed');
      },
    });
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    const persisted = await harness.store.listRuns(WORKSPACE, { limit: 10 });
    expect({
      status: response.status,
      runs: persisted.items.map((run) => ({ status: run.status, workspaceId: run.workspaceId })),
    }).toEqual({ status: 202, runs: [{ status: 'queued', workspaceId: WORKSPACE }] });
    expect(logged).toEqual([
      {
        message: 'the launch handoff failed; the run stays queued',
        runId: persisted.items[0]?.id,
      },
    ]);
  });
  it('records the engine a new run executes on, with no engine version yet (ADR-0065)', async () => {
    install();
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(response.status).toBe(202);
    const body = (await response.json()) as { run: Record<string, unknown> };
    expect(body.run['engine']).toBe('claude-agent-sdk');
    // Nothing has reported a version before the engine starts: `null`, not a guessed one.
    expect(body.run['engineVersion']).toBeNull();
  });
  it('renders timestamps as ISO strings and no bigint', async () => {
    install();
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    const body = (await response.json()) as { run: Record<string, unknown> };
    expect(typeof body.run['createdAt']).toBe('string');
    expect(body.run['startedAt']).toBeNull();
    expect(body.run['endedAt']).toBeNull();
  });
});

describe('POST /api/agents/:id/runs', () => {
  it('returns 401 before it looks at the path or the body', async () => {
    const harness = install();
    const response = await startRun(post('not-a-uuid', { nonsense: true }, false), 'not-a-uuid');
    expect(response.status).toBe(401);
    expect(harness.launched).toHaveLength(0);
  });

  it('returns 400 for a non-UUID agent id, an unparseable body and a wrong content type', async () => {
    install();
    expect((await startRun(post('nope', { prompt: 'hi' }), 'nope')).status).toBe(400);

    const badJson = new Request(`http://web/api/agents/${AGENT}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': '1' },
      body: '{',
    });
    expect((await startRun(badJson, AGENT)).status).toBe(400);

    const formEncoded = new Request(`http://web/api/agents/${AGENT}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'x-test-user': '1' },
      body: 'prompt=hi',
    });
    expect((await startRun(formEncoded, AGENT)).status).toBe(400);
  });

  it('rejects an empty per-run model that the public request contract rejects', async () => {
    const input = { prompt: 'hi', modelConnectionId: AGENT, model: '' };
    expect(StartRunRequestSchema.safeParse(input).success).toBe(false);
    const harness = install();
    const response = await startRun(post(AGENT, input), AGENT);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_body');
    expect(harness.launched).toHaveLength(0);
  });

  it('answers 403 run_subject_forbidden for a "subject" from anything but an API key', async () => {
    const input = { prompt: 'hi', subject: 'user-1' };
    expect(StartRunRequestSchema.safeParse(input).success).toBe(true);
    for (const via of ['session', 'user-token', 'browser-token', undefined] as const) {
      const harness = install({
        authenticate: () =>
          Promise.resolve({ ...PRINCIPAL, ...(via === undefined ? {} : { via }) }),
      });
      const response = await startRun(post(AGENT, input), AGENT);
      expect(response.status, String(via)).toBe(403);
      expect(await errorCode(response)).toBe('run_subject_forbidden');
      expect(harness.launched).toHaveLength(0);
    }
  });
});

describe('POST /api/agents/:id/runs', () => {
  it('launches an API-key run with its "subject"', async () => {
    const harness = install({
      authenticate: () =>
        Promise.resolve({ ...PRINCIPAL, via: 'api-key' as const, kind: 'api_key' as const }),
    });
    const response = await startRun(post(AGENT, { prompt: 'hi', subject: 'user-1' }), AGENT);
    expect(response.status).toBe(202);
    expect(harness.launched[0]?.subject).toBe('user-1');
  });

  it('hands a valid "fileScope" to the launch, and answers 400 invalid_body for a bad one', async () => {
    const harness = install();
    const ok = await startRun(post(AGENT, { prompt: 'hi', fileScope: ['docs/alice'] }), AGENT);
    expect(ok.status).toBe(202);
    expect(harness.launched[0]?.fileScope).toEqual(['docs/alice']);
    const bad = await startRun(post(AGENT, { prompt: 'hi', fileScope: ['../x'] }), AGENT);
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe('invalid_body');
    expect(harness.launched).toHaveLength(1);
  });

  it('returns 404, not 403, for an agent in another workspace', async () => {
    // §25: a status code that distinguishes "does not exist" from "not yours" confirms the row
    // exists to a caller who is not allowed to know that.
    install({ findAgent: () => Promise.resolve(null) });
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('agent_not_found');
  });

  it('returns 409 when the requested session cannot run this agent', async () => {
    install();
    const response = await startRun(
      post(AGENT, { prompt: 'hi', sessionId: '77777777-7777-4777-8777-777777777777' }),
      AGENT,
    );
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('session_not_usable');
  });
});

// issue #117 (W9-AUTH-117): `resolveAgentRunOwnership` reads `apps/web/server/agents/runtime.ts`'s
// own registry — a seam separate from this file's `RunApiEnvironment` — so these two cases
// configure it directly rather than through `install()`'s `findAgent`/`authenticate` overrides.
describe('POST /api/agents/:id/runs > Builder ownership (issue #117)', () => {
  afterEach(clearApplicationContext);

  it('lets a Builder run the agent it created', async () => {
    const agentId = await configureOwnedAgent(PRINCIPAL.principalId);
    installBuilderFor(agentId);

    const response = await startRun(post(agentId, { prompt: 'hi' }), agentId);
    expect(response.status, await response.clone().text()).toBe(202);
  });

  it('denies a Builder running an agent another Builder created', async () => {
    const agentId = await configureOwnedAgent('99999999-9999-4999-8999-999999999999');
    installBuilderFor(agentId);

    const response = await startRun(post(agentId, { prompt: 'hi' }), agentId);
    expect(response.status).toBe(403);
  });
});
