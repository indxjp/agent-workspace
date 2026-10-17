import {
  InterruptRunResponseSchema,
  StartRunRequestSchema,
  parseRunFailure,
} from '@indx-workspace/contracts/runs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyRunOutcome,
  interruptRun,
  interruptRunFor,
  listRuns,
  MAX_PROMPT_CHARS,
  parseStartRunBody,
  readRun,
  renderRun,
  revokeRunTokens,
  startRun,
  startRunOnSession,
  streamRunEvents,
} from './api';
import {
  getRunApi,
  installRunApi,
  resetRunApi,
  type AgentRef,
  type LaunchContext,
  type Principal,
  type RunApiEnvironment,
  type SessionRef,
} from './environment';
import {
  clearEngineImagesConfiguredForTests,
  configureEngineImagesForTests,
} from '../engines/images';
import { runStartRefusalError } from '../compose/run-preflight';
import { createRunnerLauncher } from './launcher';
import {
  InMemoryRunStore,
  runStatuses,
  SessionBusyError,
  type RunRecord,
  type RunStatus,
} from './store';
import { recordingCeilingFor } from '../policy-ceiling/fixtures';
import { admitVisitorWrite, resetSurfaceLimits } from '../surfaces/public/limits';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const OTHER_WORKSPACE = '55555555-5555-4555-8555-555555555555';
const AGENT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const PRINCIPAL_USER_ID = '66666666-6666-4666-8666-666666666666';
const PRINCIPAL: Principal = {
  principalId: '77777777-7777-4777-8777-777777777777',
  ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
  userId: PRINCIPAL_USER_ID,
  workspaceId: WORKSPACE,
  role: 'owner',
  scope: null,
};

interface Harness {
  readonly store: InMemoryRunStore;
  readonly launched: LaunchContext[];
}

function install(
  overrides: Partial<RunApiEnvironment> = {},
  store: InMemoryRunStore = new InMemoryRunStore(),
): Harness {
  const launched: LaunchContext[] = [];
  const environment: RunApiEnvironment = {
    authenticate: (request: Request): Promise<Principal | null> =>
      Promise.resolve(request.headers.get('x-test-user') === null ? null : PRINCIPAL),
    findAgent: (principal: Principal, agentId: string): Promise<AgentRef | null> =>
      Promise.resolve(
        agentId === AGENT
          ? { id: AGENT, workspaceId: principal.workspaceId, engine: 'claude-agent-sdk' }
          : null,
      ),
    openSession: (
      _p: Principal,
      agent: AgentRef,
      requested: string | null,
    ): Promise<SessionRef | null> =>
      Promise.resolve(
        requested === null || requested === SESSION
          ? { id: SESSION, agentId: agent.id, engine: null }
          : null,
      ),
    ownsRun: () => Promise.resolve(true),
    store,
    launch: (context: LaunchContext): void => {
      launched.push(context);
    },
    ...overrides,
  };
  installRunApi(environment);
  return { store, launched };
}

function post(agentId: string, body: unknown, authenticated = true): Request {
  return new Request(`http://web/api/agents/${agentId}/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { 'x-test-user': '1' } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(url: string, headers: Record<string, string> = {}, authenticated = true): Request {
  return new Request(url, {
    headers: { ...(authenticated ? { 'x-test-user': '1' } : {}), ...headers },
  });
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '(none)';
}

afterEach(() => {
  resetRunApi();
});

describe('parseStartRunBody', () => {
  it('accepts a prompt on its own', () => {
    expect(parseStartRunBody({ prompt: 'hello' })).toEqual({
      kind: 'ok',
      body: { prompt: 'hello', sessionId: null, modelOverride: null },
    });
  });

  it('accepts an explicit null sessionId as "start a new session"', () => {
    expect(parseStartRunBody({ prompt: 'hello', sessionId: null })).toEqual({
      kind: 'ok',
      body: { prompt: 'hello', sessionId: null, modelOverride: null },
    });
  });

  it('accepts a per-run model connection paired with a model, without changing the agent route', () => {
    expect(
      parseStartRunBody({ prompt: 'hello', modelConnectionId: AGENT, model: 'claude-opus-4-5' }),
    ).toEqual({
      kind: 'ok',
      body: {
        prompt: 'hello',
        sessionId: null,
        modelOverride: { connectionId: AGENT, model: 'claude-opus-4-5' },
      },
    });
    expect(
      parseStartRunBody({
        prompt: 'hello',
        modelConnectionId: 'not-a-uuid',
        model: 'claude-opus-4-5',
      }).kind,
    ).toBe('rejected');
  });

  // issue #129: no layer of the resolution ladder may mix a connection from one level with a
  // model from another — the run override, being the top of that ladder, is no exception.
  it('rejects a connection without a model, and a model without a connection', () => {
    expect(parseStartRunBody({ prompt: 'hello', modelConnectionId: AGENT }).kind).toBe('rejected');
    expect(parseStartRunBody({ prompt: 'hello', model: 'claude-opus-4-5' }).kind).toBe('rejected');
  });

  it('rejects an unknown field rather than silently ignoring a caller instruction', () => {
    const verdict = parseStartRunBody({ prompt: 'hi', temperature: 0.5 });
    expect(verdict.kind).toBe('rejected');
    if (verdict.kind !== 'rejected') return;
    expect(verdict.reason).toContain('temperature');
  });

  it('rejects a non-object, a missing prompt, an empty prompt and a non-string prompt', () => {
    for (const bad of [null, [], 'hi', 42, {}, { prompt: '' }, { prompt: '   ' }, { prompt: 7 }]) {
      expect(parseStartRunBody(bad).kind, JSON.stringify(bad)).toBe('rejected');
    }
  });

  it('rejects a prompt over the documented cap and accepts one exactly at it', () => {
    expect(parseStartRunBody({ prompt: 'a'.repeat(MAX_PROMPT_CHARS) }).kind).toBe('ok');
    expect(parseStartRunBody({ prompt: 'a'.repeat(MAX_PROMPT_CHARS + 1) }).kind).toBe('rejected');
  });

  it('rejects a sessionId that is not a UUID', () => {
    expect(parseStartRunBody({ prompt: 'hi', sessionId: 'not-a-uuid' }).kind).toBe('rejected');
  });
});

describe('with no environment installed', () => {
  it('answers 503 and names what is missing, on all three routes', async () => {
    resetRunApi();
    const started = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(started.status).toBe(503);
    expect(await errorCode(started)).toBe('run_api_not_configured');

    const read = await readRun(get('http://web/api/runs/x'), SESSION);
    expect(read.status).toBe(503);

    const streamed = await streamRunEvents(get('http://web/api/runs/x/events'), SESSION);
    expect(streamed.status).toBe(503);
    // Not 200-with-an-empty-stream: an unconfigured server must not look like a run with no
    // output, and not 401 either, which would promise that credentials could fix it.
    expect(streamed.headers.get('content-type')).toContain('application/json');
  });
});

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

  // issue #117 (W9-AUTH-117): `resolveAgentRunOwnership` reads `apps/web/server/agents/runtime.ts`'s
  // own registry — a seam separate from this file's `RunApiEnvironment` — so these two cases
  // configure it directly rather than through `install()`'s `findAgent`/`authenticate` overrides.
  describe('Builder ownership (issue #117)', () => {
    afterEach(async () => {
      const { clearAgentsRuntime } = await import('../agents/runtime');
      clearAgentsRuntime();
    });

    async function configureOwnedAgent(ownerPrincipalId: string): Promise<string> {
      const { configureAgentsRuntime } = await import('../agents/runtime');
      const { createInMemoryAgentStoreProvider } = await import('../agents/memory-store');
      const agents = createInMemoryAgentStoreProvider();
      configureAgentsRuntime({
        agents,
        resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
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

    it('lets a Builder run the agent it created', async () => {
      const agentId = await configureOwnedAgent(PRINCIPAL.principalId);
      install({
        authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'builder' }),
        findAgent: (principal, id) =>
          Promise.resolve(
            id === agentId
              ? { id: agentId, workspaceId: principal.workspaceId, engine: 'claude-agent-sdk' }
              : null,
          ),
      });

      const response = await startRun(post(agentId, { prompt: 'hi' }), agentId);
      expect(response.status, await response.clone().text()).toBe(202);
    });

    it('denies a Builder running an agent another Builder created', async () => {
      const agentId = await configureOwnedAgent('99999999-9999-4999-8999-999999999999');
      install({
        authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'builder' }),
        findAgent: (principal, id) =>
          Promise.resolve(
            id === agentId
              ? { id: agentId, workspaceId: principal.workspaceId, engine: 'claude-agent-sdk' }
              : null,
          ),
      });

      const response = await startRun(post(agentId, { prompt: 'hi' }), agentId);
      expect(response.status).toBe(403);
    });
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

  describe('RF-303 launch handoff characterization', () => {
    let actual: {
      readonly outcome:
        | { readonly kind: 'response'; readonly status: number }
        | {
            readonly kind: 'launch-error';
          };
      readonly runs: ReadonlyArray<{ readonly status: string; readonly workspaceId: string }>;
    };

    beforeEach(async () => {
      const harness = install({
        launch: () => {
          throw new Error('process-local launch handoff failed');
        },
      });

      const outcome = await startRun(post(AGENT, { prompt: 'hi' }), AGENT).then(
        (response) => ({ kind: 'response' as const, status: response.status }),
        (error: unknown) => {
          if (
            !(error instanceof Error) ||
            error.message !== 'process-local launch handoff failed'
          ) {
            throw error;
          }
          return { kind: 'launch-error' as const };
        },
      );
      const persisted = await harness.store.listRuns(WORKSPACE, { limit: 10 });
      actual = {
        outcome,
        runs: persisted.items.map((run) => ({ status: run.status, workspaceId: run.workspaceId })),
      };
    });

    it('RF-303 captures the launch failure and the queued run persisted by the harness', () => {
      expect(actual).toEqual({
        outcome: { kind: 'launch-error' },
        runs: [{ status: 'queued', workspaceId: WORKSPACE }],
      });
    });

    it.fails(
      'RF-303 keeps the accepted request boundary from depending on a process-local launch callback (expected failure until RF-303)',
      () => {
        expect(actual).toEqual({
          outcome: { kind: 'response', status: 202 },
          runs: [{ status: 'queued', workspaceId: WORKSPACE }],
        });
      },
    );
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

  // ── ADR-0065 D8: a session stays on the engine it started with (#318) ───────────────────────
  //
  // The agent's engine is a `string` on `AgentRef` precisely so this refusal can be reached: while
  // `ENGINE_IDS` publishes one member, a test-only registered descriptor is the only second engine
  // a deployment can have, and comparing two `EngineId`s could never differ.
  describe('session engine pinning', () => {
    const TEST_ENGINE = 'test-only-engine';

    function installWithEngines(sessionEngine: string | null, agentEngine: string): Harness {
      return install({
        findAgent: (principal, id) =>
          Promise.resolve(
            id === AGENT
              ? { id: AGENT, workspaceId: principal.workspaceId, engine: agentEngine }
              : null,
          ),
        openSession: (_p, agent) =>
          Promise.resolve({ id: SESSION, agentId: agent.id, engine: sessionEngine }),
      });
    }

    it('refuses a run whose agent names another engine, and creates no run row', async () => {
      const harness = installWithEngines('claude-agent-sdk', TEST_ENGINE);

      // A pinned session is one a run already used, so the request resumes it by id.
      const response = await startRun(post(AGENT, { prompt: 'hi', sessionId: SESSION }), AGENT);

      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe('session_engine_mismatch');
      // The acceptance criterion in full: the refusal is not a rolled-back run, it is no run.
      const persisted = await harness.store.listRuns(WORKSPACE, { limit: 10 });
      expect(persisted.items).toHaveLength(0);
      expect(harness.launched).toHaveLength(0);
    });

    it('runs a version-pinned session on its version’s engine after the agent row switched (issue #612)', async () => {
      const harness = install({
        findAgent: (principal, id) =>
          Promise.resolve(
            id === AGENT
              ? { id: AGENT, workspaceId: principal.workspaceId, engine: TEST_ENGINE }
              : null,
          ),
        openSession: (_p, agent) =>
          Promise.resolve({
            id: SESSION,
            agentId: agent.id,
            engine: 'claude-agent-sdk',
            agentVersionId: '33333333-3333-4333-8333-333333333333',
            versionEngine: 'claude-agent-sdk',
          }),
      });

      const response = await startRun(post(AGENT, { prompt: 'hi', sessionId: SESSION }), AGENT);

      expect(response.status).toBe(202);
      const body = (await response.json()) as { run: Record<string, unknown> };
      expect(body.run['engine']).toBe('claude-agent-sdk');
      expect(harness.launched).toHaveLength(1);
    });

    it('names both engines so the caller can see which side to change', async () => {
      installWithEngines('claude-agent-sdk', TEST_ENGINE);
      const response = await startRun(post(AGENT, { prompt: 'hi', sessionId: SESSION }), AGENT);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain('claude-agent-sdk');
      expect(body.error.message).toContain(TEST_ENGINE);
    });

    it('runs, and records the pinned engine, when the agent agrees with the session', async () => {
      const harness = installWithEngines('claude-agent-sdk', 'claude-agent-sdk');
      const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
      expect(response.status).toBe(202);
      const body = (await response.json()) as { run: Record<string, unknown> };
      expect(body.run['engine']).toBe('claude-agent-sdk');
      expect(harness.launched).toHaveLength(1);
    });

    it('lets an unpinned session run any engine: nothing has pinned it yet', async () => {
      const harness = installWithEngines(null, 'claude-agent-sdk');
      const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
      expect(response.status).toBe(202);
      expect(harness.launched).toHaveLength(1);
    });

    // ── ENG-07 (#306, ADR-0073 D2/D3): an engine with no configured image is not installed ─────
    describe('engine images', () => {
      const CLAUDE_IMAGE = `registry.example/private-project/runtime-claude-agent-sdk@sha256:${'c'.repeat(64)}`;

      afterEach(clearEngineImagesConfiguredForTests);

      // While `ENGINE_IDS` publishes one engine, the only engine a session can pin is the Claude
      // one, so "an engine this deployment has no image for" is reached by leaving it out of the
      // map. A second published engine (#307) reaches the same line with its own id.
      it('answers 422 engine_not_installed before any run row or sandbox exists', async () => {
        configureEngineImagesForTests(new Map());
        const harness = installWithEngines('claude-agent-sdk', 'claude-agent-sdk');

        const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);

        expect(response.status).toBe(422);
        const body = (await response.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('engine_not_installed');
        expect(body.error.message).toContain('claude-agent-sdk');
        const persisted = await harness.store.listRuns(WORKSPACE, { limit: 10 });
        expect(persisted.items).toHaveLength(0);
        expect(harness.launched).toHaveLength(0);
      });

      // PR #403 review: a run that would open its own session meets this refusal before the
      // session is opened, so no empty session is left behind.
      it('refuses a missing engine image before opening a new session', async () => {
        configureEngineImagesForTests(new Map());
        let opened = 0;
        install({
          openSession: (_p, agent) => {
            opened += 1;
            return Promise.resolve({ id: SESSION, agentId: agent.id, engine: null });
          },
        });
        const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
        expect(response.status).toBe(422);
        expect(await errorCode(response)).toBe('engine_not_installed');
        expect(opened).toBe(0);
      });

      it('runs the engine the map holds an image for', async () => {
        configureEngineImagesForTests(new Map([['claude-agent-sdk', CLAUDE_IMAGE]]));
        const harness = installWithEngines('claude-agent-sdk', 'claude-agent-sdk');
        const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
        expect(response.status).toBe(202);
        expect(harness.launched).toHaveLength(1);
      });
    });

    it('refuses to record a run for an engine the contracts do not publish', async () => {
      // An unpinned session plus an agent naming an unpublished engine is a state no stored policy
      // can produce (`AgentStoredPolicy` parses only published engines). It is reported rather than
      // recorded as the default engine, so a misconfigured composition root is not silently
      // attributed to `claude-agent-sdk`.
      const harness = installWithEngines(null, TEST_ENGINE);
      await expect(startRun(post(AGENT, { prompt: 'hi' }), AGENT)).rejects.toThrow(
        'not one this platform',
      );
      const persisted = await harness.store.listRuns(WORKSPACE, { limit: 10 });
      expect(persisted.items).toHaveLength(0);
    });
  });

  it('renders timestamps as ISO strings and no bigint', async () => {
    install();
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    const body = (await response.json()) as { run: Record<string, unknown> };
    expect(typeof body.run['createdAt']).toBe('string');
    expect(body.run['startedAt']).toBeNull();
    expect(body.run['endedAt']).toBeNull();
  });

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

describe('GET /api/runs/:id', () => {
  it('allows an own run and denies another member run under own-only grants', async () => {
    const harness = install({
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'viewer' }),
    });
    await harness.store.create({
      engine: 'claude-agent-sdk',
      id: SESSION,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
    });

    expect((await readRun(get(`http://web/api/runs/${SESSION}`), SESSION)).status).toBe(200);
    install({
      store: harness.store,
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'viewer' }),
      ownsRun: () => Promise.resolve(false),
    });
    expect((await readRun(get(`http://web/api/runs/${SESSION}`), SESSION)).status).toBe(403);
  });

  it('lets an Admin read another member’s run where a Viewer is refused — issue #165 widened Admin’s `runs` grant to `read: any`', async () => {
    const harness = install({
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'admin' }),
      ownsRun: () => Promise.resolve(false),
    });
    await harness.store.create({
      engine: 'claude-agent-sdk',
      id: SESSION,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
    });
    expect((await readRun(get(`http://web/api/runs/${SESSION}`), SESSION)).status).toBe(200);

    // The same run and the same `other` ownership answer, one role narrower: what changed is the
    // §21 grant, not anything this route does. See
    // docs/adr/W9-AUTH-165-admin-reads-workspace-run-history.md.
    install({
      store: harness.store,
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'viewer' }),
      ownsRun: () => Promise.resolve(false),
    });
    expect((await readRun(get(`http://web/api/runs/${SESSION}`), SESSION)).status).toBe(403);
  });

  it('returns the run', async () => {
    install();
    const created = (await (await startRun(post(AGENT, { prompt: 'hi' }), AGENT)).json()) as {
      run: { id: string };
    };
    const response = await readRun(get(`http://web/api/runs/${created.run.id}`), created.run.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { run: { id: string } };
    expect(body.run.id).toBe(created.run.id);
  });

  it('returns 401 unauthenticated, 400 for a non-UUID and 404 for an unknown run', async () => {
    install();
    expect((await readRun(get('http://web/api/runs/x', {}, false), 'x')).status).toBe(401);
    expect((await readRun(get('http://web/api/runs/x'), 'x')).status).toBe(400);
    expect((await readRun(get('http://web/api/runs/x'), SESSION)).status).toBe(404);
  });

  it('returns 404 for a run belonging to another workspace', async () => {
    const harness = install();
    await harness.store.create({
      engine: 'claude-agent-sdk',
      id: SESSION,
      workspaceId: OTHER_WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
    });
    const response = await readRun(get(`http://web/api/runs/${SESSION}`), SESSION);
    expect(response.status).toBe(404);
  });
});

const OTHER_USER = '77777777-7777-4777-8777-777777777777';
const OTHER_PRINCIPAL = '88888888-8888-4888-8888-888888888888';

/** A fresh, valid run id — every test below needs several of its own. */
function newRunId(): string {
  return crypto.randomUUID();
}

/** Create a run with attribution, defaulting to `PRINCIPAL`'s own workspace/agent/user. */
async function seedRun(
  store: InMemoryRunStore,
  overrides: Partial<{
    readonly id: string;
    readonly workspaceId: string;
    readonly agentId: string;
    readonly projectId: string | null;
    readonly initiatingUserId: string | null;
    readonly ownerPrincipalId: string;
  }> = {},
): Promise<RunRecord> {
  const id = overrides.id ?? newRunId();
  return store.create({
    engine: 'claude-agent-sdk',
    id,
    workspaceId: overrides.workspaceId ?? WORKSPACE,
    agentId: overrides.agentId ?? AGENT,
    sessionId: id,
    ...(overrides.projectId !== undefined ? { projectId: overrides.projectId } : {}),
    initiatingUserId:
      overrides.initiatingUserId === undefined ? PRINCIPAL_USER_ID : overrides.initiatingUserId,
    ownerPrincipalId:
      overrides.ownerPrincipalId ??
      (overrides.initiatingUserId === OTHER_USER ? OTHER_PRINCIPAL : PRINCIPAL.principalId),
  });
}

async function listBody(response: Response): Promise<{
  runs: Array<Record<string, unknown>>;
  nextCursor: string | null;
}> {
  return (await response.json()) as {
    runs: Array<Record<string, unknown>>;
    nextCursor: string | null;
  };
}

describe('GET /api/runs', () => {
  it('returns 401 unauthenticated and 503 when the store has no listRuns implementation', async () => {
    install();
    expect((await listRuns(get('http://web/api/runs', {}, false))).status).toBe(401);

    // A store with no `listRuns` — the port's declared optional case.
    installRunApi({
      authenticate: () => Promise.resolve(PRINCIPAL),
      findAgent: () => Promise.resolve(null),
      openSession: () => Promise.resolve(null),
      ownsRun: () => Promise.resolve(true),
      store: {
        create: () => Promise.reject(new Error('unused')),
        get: () => Promise.resolve(null),
        markRunning: () => Promise.resolve(false),
        finish: () => Promise.resolve(),
        snapshotModel: () => Promise.resolve(),
        append: () => Promise.reject(new Error('unused')),
        appendPlatformEvent: () => Promise.reject(new Error('unused')),
        openStream: () => Promise.resolve(null),
      },
      launch: () => undefined,
    });
    expect((await listRuns(get('http://web/api/runs'))).status).toBe(503);
  });

  it('an Owner (any grant) sees every workspace run and may filter by user', async () => {
    const harness = install({ authenticate: () => Promise.resolve(PRINCIPAL) });
    const mine = await seedRun(harness.store);
    const theirs = await seedRun(harness.store, { initiatingUserId: OTHER_USER });
    await seedRun(harness.store, { workspaceId: OTHER_WORKSPACE });

    const all = await listBody(await listRuns(get('http://web/api/runs')));
    const ids = all.runs.map((run) => run['id']);
    expect(ids).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    expect(ids).toHaveLength(2);

    const filtered = await listBody(await listRuns(get(`http://web/api/runs?user=${OTHER_USER}`)));
    expect(filtered.runs.map((run) => run['id'])).toEqual([theirs.id]);
  });

  it('a Builder (own grant) sees only their own runs and may not use the user filter', async () => {
    const harness = install({
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'builder' }),
    });
    const mine = await seedRun(harness.store);
    await seedRun(harness.store, { initiatingUserId: OTHER_USER });

    const response = await listRuns(get('http://web/api/runs'));
    const body = await listBody(response);
    expect(body.runs.map((run) => run['id'])).toEqual([mine.id]);

    const forbidden = await listRuns(get(`http://web/api/runs?user=${OTHER_USER}`));
    expect(forbidden.status).toBe(403);
    expect(await errorCode(forbidden)).toBe('user_filter_forbidden');

    // Even a Builder naming *themselves* is refused: the filter is not offered at all (issue
    // #135's "deliberately not built"), not merely narrowed to a no-op.
    const named = await listRuns(get(`http://web/api/runs?user=${PRINCIPAL.userId}`));
    expect(named.status).toBe(403);
  });

  it('a Viewer sees only their own runs, exactly as a Builder does', async () => {
    const harness = install({
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'viewer' }),
    });
    const mine = await seedRun(harness.store);
    await seedRun(harness.store, { initiatingUserId: OTHER_USER });
    const body = await listBody(await listRuns(get('http://web/api/runs')));
    expect(body.runs.map((run) => run['id'])).toEqual([mine.id]);
  });

  it('a machine Builder sees runs owned by its exact principal and not another machine principal', async () => {
    const machinePrincipalId = '99999999-9999-4999-8999-999999999999';
    const harness = install({
      authenticate: () =>
        Promise.resolve({
          principalId: machinePrincipalId,
          ownerPrincipalId: machinePrincipalId,
          userId: null,
          workspaceId: WORKSPACE,
          role: 'builder',
          scope: null,
        }),
    });
    const mine = await seedRun(harness.store, {
      initiatingUserId: null,
      ownerPrincipalId: machinePrincipalId,
    });
    await seedRun(harness.store, {
      initiatingUserId: null,
      ownerPrincipalId: OTHER_PRINCIPAL,
    });

    const response = await listRuns(get('http://web/api/runs'));
    expect(response.status).toBe(200);
    const body = await listBody(response);
    expect(body.runs.map((run) => run['id'])).toEqual([mine.id]);
  });

  it(
    'an Admin sees every run in the workspace and may filter by user — issue #165 widened ' +
      "`POLICY.admin.byResource.runs` to `read: 'any'`, so issue #135's \"Owner/Admin see " +
      'allowed workspace history" is now met for both roles; this is the collection route\'s ' +
      'width, which the authorisation matrix cannot state (see the comment on the matching test ' +
      'in apps/web/server/rbac/authorisation-matrix.test.ts) and ' +
      'docs/adr/W9-AUTH-165-admin-reads-workspace-run-history.md records',
    async () => {
      const harness = install({
        authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'admin' }),
      });
      const mine = await seedRun(harness.store);
      const theirs = await seedRun(harness.store, { initiatingUserId: OTHER_USER });
      // Still workspace-scoped: the widening is over §21's roles, never over §25's tenancy.
      await seedRun(harness.store, { workspaceId: OTHER_WORKSPACE });

      const all = await listBody(await listRuns(get('http://web/api/runs')));
      // Set-wise, exactly as the Owner case above: two runs seeded in the same millisecond tie on
      // `created_at` and are ordered by `id`, which is a fresh UUID per run.
      const ids = all.runs.map((run) => run['id']);
      expect(ids).toEqual(expect.arrayContaining([mine.id, theirs.id]));
      expect(ids).toHaveLength(2);

      const filtered = await listBody(
        await listRuns(get(`http://web/api/runs?user=${OTHER_USER}`)),
      );
      expect(filtered.runs.map((run) => run['id'])).toEqual([theirs.id]);

      // The filter is offered, not merely tolerated: an Admin naming themselves is a 200 that
      // narrows, where the same request from a Builder is a 403.
      const named = await listRuns(get(`http://web/api/runs?user=${PRINCIPAL.userId}`));
      expect(named.status).toBe(200);
      expect((await listBody(named)).runs.map((run) => run['id'])).toEqual([mine.id]);
    },
  );

  it('never returns another workspace’s run, and a random id 404s from the detail route the same way', async () => {
    const harness = install();
    await seedRun(harness.store, { workspaceId: OTHER_WORKSPACE });
    const body = await listBody(await listRuns(get('http://web/api/runs')));
    expect(body.runs).toHaveLength(0);

    const randomId = crypto.randomUUID();
    const detail = await readRun(get(`http://web/api/runs/${randomId}`), randomId);
    expect(detail.status).toBe(404);
  });

  it(
    'refuses a principal whose role is not one of the four recognised roles by name, rather ' +
      'than silently authorising it as some default (round 2 finding 4: a corrupt membership ' +
      "row is the only input that reaches `decideRunListAccess`'s `role === null` guard)",
    async () => {
      const harness = install({
        authenticate: () =>
          Promise.resolve({ ...PRINCIPAL, role: 'bogus' } as unknown as Principal),
      });
      await seedRun(harness.store);
      const response = await listRuns(get('http://web/api/runs'));
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('forbidden');
    },
  );

  it('composes status, agent and provider filters as an intersection, not a union', async () => {
    const harness = install();
    const otherAgent = '88888888-8888-4888-8888-888888888888';
    const matches = await seedRun(harness.store);
    const wrongStatus = await seedRun(harness.store);
    const wrongAgent = await seedRun(harness.store, { agentId: otherAgent });
    await harness.store.snapshotModel(matches.id, {
      connectionId: crypto.randomUUID(),
      model: 'gpt-5.1',
      provider: 'openai',
    });
    await harness.store.finish(matches.id, 'failed', 'boom');
    await harness.store.snapshotModel(wrongAgent.id, {
      connectionId: crypto.randomUUID(),
      model: 'gpt-5.1',
      provider: 'openai',
    });
    await harness.store.finish(wrongAgent.id, 'failed', 'boom');
    // wrongStatus keeps provider/agent matching but is never finished (`queued`).
    void wrongStatus;

    const body = await listBody(
      await listRuns(get(`http://web/api/runs?status=failed&agent=${AGENT}&provider=openai`)),
    );
    expect(body.runs.map((run) => run['id'])).toEqual([matches.id]);
  });

  it('composes the project filter and the from/to date range as an intersection, not a union (round 2 finding 3)', async () => {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    let clockMs = base;
    // A controlled clock, one tick (1s) per `create()`, so `from`/`to` can be set to include or
    // exclude a specific run by name rather than racing the real clock.
    const store = new InMemoryRunStore({ now: (): Date => new Date((clockMs += 1000)) });
    const harness = install({}, store);
    const projectId = crypto.randomUUID();
    const otherProjectId = crypto.randomUUID();

    // Ticks, in creation order: tooEarly=+1s, match=+2s, wrongProject=+3s, tooLate=+4s.
    const tooEarly = await seedRun(harness.store, { projectId });
    const match = await seedRun(harness.store, { projectId });
    const wrongProject = await seedRun(harness.store, { projectId: otherProjectId });
    const tooLate = await seedRun(harness.store, { projectId });

    const from = new Date(base + 1_500).toISOString(); // after tooEarly, before match
    const to = new Date(base + 3_500).toISOString(); // after wrongProject, before tooLate

    const body = await listBody(
      await listRuns(get(`http://web/api/runs?project=${projectId}&from=${from}&to=${to}`)),
    );
    const ids = body.runs.map((run) => run['id']);
    // A regression that drops `project` from the query would leak `wrongProject` in; one that
    // drops `from` would leak `tooEarly`; one that drops `to` would leak `tooLate`. Each is a
    // widening this one intersection catches by name.
    expect(ids).toEqual([match.id]);
    expect(ids).not.toContain(tooEarly.id);
    expect(ids).not.toContain(wrongProject.id);
    expect(ids).not.toContain(tooLate.id);

    // Sanity: without the date range, all three same-project runs are visible — the range, not
    // the project filter, is what excluded `tooEarly` and `tooLate` above.
    const withoutRange = await listBody(
      await listRuns(get(`http://web/api/runs?project=${projectId}`)),
    );
    expect(withoutRange.runs.map((run) => run['id'])).toEqual(
      expect.arrayContaining([tooEarly.id, match.id, tooLate.id]),
    );
  });

  it(
    'rejects a malformed cursor, an out-of-range limit, an unknown status, and every other ' +
      'malformed filter by name (round 2 finding 2: project, model, to, date-range order, user)',
    async () => {
      install();
      const badCursor = await listRuns(get('http://web/api/runs?cursor=not-base64url-json'));
      expect(badCursor.status).toBe(400);
      expect(await errorCode(badCursor)).toBe('invalid_cursor');
      // A well-formed envelope around a `createdAt` that `new Date()` accepts but no store ever
      // minted (round 3 finding 4): refused by shape here, before any store sees it. The
      // real-PostgreSQL probes live in `store.test.ts`, where the thrown query used to happen.
      for (const createdAt of ['1', '2026-09-12', '0000-01-01T00:00:00.000000Z']) {
        const crafted = Buffer.from(
          JSON.stringify({ createdAt, id: crypto.randomUUID() }),
          'utf8',
        ).toString('base64url');
        const response = await listRuns(get(`http://web/api/runs?cursor=${crafted}`));
        expect(response.status).toBe(400);
        expect(await errorCode(response)).toBe('invalid_cursor');
      }

      expect((await listRuns(get('http://web/api/runs?limit=0'))).status).toBe(400);
      expect((await listRuns(get('http://web/api/runs?limit=201'))).status).toBe(400);
      expect((await listRuns(get('http://web/api/runs?limit=abc'))).status).toBe(400);
      expect((await listRuns(get('http://web/api/runs?status=not-a-status'))).status).toBe(400);
      expect((await listRuns(get('http://web/api/runs?provider=not-a-provider'))).status).toBe(400);
      expect((await listRuns(get('http://web/api/runs?agent=not-a-uuid'))).status).toBe(400);
      expect((await listRuns(get('http://web/api/runs?from=not-a-date'))).status).toBe(400);

      // `project` must be a UUID (api.ts's `invalid_project`, otherwise silently ignored or
      // forwarded to a query that would error some other way).
      const badProject = await listRuns(get('http://web/api/runs?project=not-a-uuid'));
      expect(badProject.status).toBe(400);
      expect(await errorCode(badProject)).toBe('invalid_project');

      // `model` must be non-empty once trimmed (api.ts's `invalid_model`) — an empty string is a
      // caller mistake, not "no filter".
      const emptyModel = await listRuns(get('http://web/api/runs?model=%20%20'));
      expect(emptyModel.status).toBe(400);
      expect(await errorCode(emptyModel)).toBe('invalid_model');

      // `to` must itself parse as a timestamp (api.ts's `invalid_to`), independent of `from`.
      const badTo = await listRuns(get('http://web/api/runs?to=not-a-date'));
      expect(badTo.status).toBe(400);
      expect(await errorCode(badTo)).toBe('invalid_to');

      // `to` before `from` is a malformed range (api.ts's `invalid_date_range`), not silently
      // swapped or silently satisfied by nothing.
      const backwardsRange = await listRuns(
        get('http://web/api/runs?from=2026-01-02T00:00:00.000Z&to=2026-01-01T00:00:00.000Z'),
      );
      expect(backwardsRange.status).toBe(400);
      expect(await errorCode(backwardsRange)).toBe('invalid_date_range');

      // `user` must be a UUID for a caller whose grant is `any` (api.ts's `invalid_user`) — an
      // Owner's malformed `user=` must be refused by name, not reach the store as a literal
      // string an eventual SQL `eq` would choke on differently.
      const badUser = await listRuns(get('http://web/api/runs?user=not-a-uuid'));
      expect(badUser.status).toBe(400);
      expect(await errorCode(badUser)).toBe('invalid_user');
    },
  );

  it('paginates by (created_at, id): no duplicate and nothing pre-existing skipped', async () => {
    const harness = install();
    const seeded: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      seeded.push((await seedRun(harness.store)).id);
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    // Bounded (round 3 finding 8): a cursor that stops advancing re-serves page one forever, and
    // `InMemoryRunStore` answers from a resolved promise, so vitest's timeout never fires — the
    // walk has to fail by name itself. Five runs at two a page is three pages.
    for (let page = 1; ; page += 1) {
      if (page > 3) throw new Error('the cursor is not advancing: a fourth page was requested');
      const url =
        cursor === null
          ? 'http://web/api/runs?limit=2'
          : `http://web/api/runs?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const body = await listBody(await listRuns(get(url)));
      // Every page but the last is exactly `limit` long (round 3 finding 6).
      if (body.nextCursor !== null) expect(body.runs).toHaveLength(2);
      collected.push(...body.runs.map((run) => run['id'] as string));
      if (body.nextCursor === null) break;
      cursor = body.nextCursor;
    }
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected.sort()).toEqual([...seeded].sort());
  });

  it('renders list items with the exact serialiser GET /api/runs/:id uses, with the exact derived duration', async () => {
    // A controlled clock: `create` at +0 s, `markRunning` at +1 s, `finish` at +24.456 s, so the
    // derived `durationMs` is a number this test names — 23 456 — on the list and on the detail
    // route alike, not merely "some number" (round 4 finding 1).
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const ticks = [0, 1_000, 24_456];
    let tick = 0;
    const store = new InMemoryRunStore({
      now: (): Date => {
        const offset = ticks[tick];
        if (offset === undefined) throw new Error('the controlled clock was read too many times');
        tick += 1;
        return new Date(base + offset);
      },
    });
    const harness = install({}, store);
    const run = await seedRun(harness.store, { projectId: '99999999-9999-4999-8999-999999999999' });
    await harness.store.snapshotModel(run.id, {
      connectionId: crypto.randomUUID(),
      model: 'claude-opus-4-5',
      provider: 'anthropic',
    });
    await harness.store.markRunning(run.id);
    await harness.store.finish(run.id, 'completed', null);

    const listed = await listBody(await listRuns(get('http://web/api/runs')));
    const fromList = listed.runs.find((item) => item['id'] === run.id);
    const detail = (await (await readRun(get(`http://web/api/runs/${run.id}`), run.id)).json()) as {
      run: Record<string, unknown>;
    };
    expect(fromList).toEqual(detail.run);
    expect(fromList).toMatchObject({
      projectId: '99999999-9999-4999-8999-999999999999',
      initiatingUserId: PRINCIPAL.userId,
      provider: 'anthropic',
      model: 'claude-opus-4-5',
      accountingState: 'pending',
      startedAt: '2026-01-01T00:00:01.000Z',
      endedAt: '2026-01-01T00:00:24.456Z',
      durationMs: 23_456,
    });
    expect((fromList?.['usage'] as { totalTokens: number }).totalTokens).toBe(0);
  });

  /**
   * Issue #135: "duration and total tokens are deterministic derived values", and #134's
   * `accounting_state` is carried through. `InMemoryRunStore` has no way to set usage counters,
   * so the serialiser is pinned here on a hand-built record whose every counter is non-zero and
   * distinct — `totalTokens` is wrong by a different amount for each counter a regression drops —
   * and again over the repository store, on real PostgreSQL, in `store.test.ts` (round 4
   * finding 1).
   */
  it('renderRun derives durationMs and totalTokens from the persisted fields and maps accountingState through', () => {
    const record: RunRecord = {
      id: newRunId(),
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
      status: 'completed',
      createdAt: new Date('2026-09-12T05:00:00.000Z'),
      startedAt: new Date('2026-09-12T05:00:01.000Z'),
      endedAt: new Date('2026-09-12T05:00:24.456Z'),
      model: 'gpt-5.1',
      provider: 'openai',
      modelConnectionId: null,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
      toolCalls: 5,
      costUsd: '0.123456',
      costCurrency: 'USD',
      priceTableVersion: 'v1',
      error: null,
      accountingState: 'complete',
      accountingError: null,
      projectId: null,
      initiatingUserId: PRINCIPAL.userId,
    };
    const rendered = renderRun(record);
    expect(rendered['durationMs']).toBe(23_456);
    expect(rendered['usage']).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
      totalTokens: 37,
      toolCalls: 5,
    });
    expect(rendered['accountingState']).toBe('complete');
    expect(rendered['cost']).toEqual({
      amount: '0.123456',
      currency: 'USD',
      priceTableVersion: 'v1',
    });
    expect(
      renderRun({
        ...record,
        accountingState: 'failed',
        accountingError:
          'new row for relation "runs" violates check constraint "runs_unpriced_cost_zero"',
        costUsd: '0.000000',
        priceTableVersion: null,
      })['accountingError'],
    ).toBe('Usage accounting could not be completed.');

    // A run that has not ended has no duration — a fact about the run, not a zero.
    expect(renderRun({ ...record, status: 'running', endedAt: null })['durationMs']).toBeNull();
    expect(renderRun({ ...record, accountingState: 'failed' })['accountingState']).toBe('failed');
  });

  /**
   * Round 4 findings 2 and 5: `from`/`to` used to be gated by `new Date(text)`, which admits
   * values PostgreSQL refuses (a signed six-digit year, year 0), values it reads as a different
   * instant than the caller meant (a zone-less timestamp, read in the web process's own time
   * zone), and values that are not ISO-8601 at all (`1`, `2026`, `Sep 12 2026`). Every probe
   * below is the verifier's; the assertion is the documented `400`, by name, on each parameter.
   * The same probes run against real PostgreSQL in `store.test.ts`, where the thrown query used
   * to happen.
   *
   * Two of the rows look redundant and are not. `.1234Z` and `.123456Z` are refused at HEAD for a
   * *second* reason — `Number("1234")` is 1234 ms, which rolls the second, and `instantOfUtcFields`
   * reads that back as a different instant — so they stay `400` even if the fraction group is
   * widened past three digits. `.0999Z` and `.0001Z` are the probes that isolate the digit rule
   * itself: a fourth digit that does not roll the second, refused only because
   * `RUN_LIST_BOUND` admits at most three of them (ADR point 12). `9999-12-31T23:59:00-00:01` does
   * the same for the upper bound: it lands, after its offset, on exactly
   * `10000-01-01T00:00:00.000Z`, one instant past `LATEST_RUN_LIST_BOUND`, where
   * `9999-12-31T23:00:00-02:00` is a whole hour past it and survives a bound moved by one
   * millisecond.
   */
  it.each([
    '+275760-09-13T00:00:00.000Z',
    '-271821-04-20T00:00:00.000Z',
    '-000001-01-01T00:00:00.000Z',
    '0000-01-01T00:00:00Z',
    '0000-01-01T00:00:00.000Z',
    '2026-09-13T00:00:00',
    '2026-09-13T00:00:00.000',
    '2026-09-12',
    '1',
    '2026',
    'Sep 12 2026',
    '2026-09-12T00:00:00.1234Z',
    '2026-09-12T00:00:00.123456Z',
    '2026-09-12T00:00:00.0999Z',
    '2026-09-12T00:00:00.0001Z',
    '2026-02-30T00:00:00Z',
    '2026-09-12T24:00:00Z',
    '2026-09-12T23:59:60Z',
    '2026-09-12T00:00:00+24:00',
    '2026-09-12T00:00:00+09:60',
    '2026-09-12t00:00:00z',
    ' 2026-09-12T00:00:00Z',
    '9999-12-31T23:00:00-02:00',
    '9999-12-31T23:59:00-00:01',
    '0001-01-01T00:00:00+00:01',
  ])('from=%j, and to= the same, is 400 by name, never parsed by `new Date`', async (value) => {
    install();
    const from = await listRuns(get(`http://web/api/runs?from=${encodeURIComponent(value)}`));
    expect(from.status).toBe(400);
    expect(await errorCode(from)).toBe('invalid_from');
    const to = await listRuns(get(`http://web/api/runs?to=${encodeURIComponent(value)}`));
    expect(to.status).toBe(400);
    expect(await errorCode(to)).toBe('invalid_to');
  });

  /**
   * The accepted side of the edges the list above refuses. `9999-12-31T23:58:59.999-00:01` is the
   * same instant as `9999-12-31T23:59:59.999Z` written with an offset — exactly
   * `LATEST_RUN_LIST_BOUND`. The pre-existing `Z` spelling below already kills an
   * `instant >= LATEST` off-by-one; what this row adds is the offset subtraction at `api.ts:486`
   * landing exactly on the bound, which no `Z` spelling in this list exercises.
   */
  it.each([
    '2026-09-12T00:00:00Z',
    '2026-09-12T00:00:00.1Z',
    '2026-09-12T00:00:00.50Z',
    '2026-09-12T00:00:00.123Z',
    '2026-09-12T00:00:00+09:00',
    '2026-09-12T00:00:00.500-05:30',
    '0001-01-01T00:00:00Z',
    '0001-01-01T00:00:00-00:00',
    '9999-12-31T23:59:59.999Z',
    '9999-12-31T23:59:59.999+00:00',
    '9999-12-31T23:58:59.999-00:01',
    '2024-02-29T00:00:00Z',
  ])('from=%j, and to= the same, is accepted', async (value) => {
    install();
    const from = await listRuns(get(`http://web/api/runs?from=${encodeURIComponent(value)}`));
    expect(from.status).toBe(200);
    const to = await listRuns(get(`http://web/api/runs?to=${encodeURIComponent(value)}`));
    expect(to.status).toBe(200);
  });

  it('reads a from/to bound with an offset as the UTC instant it names, whatever the process time zone', async () => {
    // One run at exactly 2026-09-12T15:00:00.000Z, one a millisecond earlier. A bound written as
    // `2026-09-13T00:00:00+09:00` names the former instant exactly: as `from=` it keeps the run at
    // it and drops the one before; as `to=` (inclusive) it keeps both, and the millisecond before
    // it, written with the same offset, keeps only the earlier run. Nothing here depends on
    // `process.env.TZ` because nothing here is parsed in local time (round 4 finding 5).
    const at = Date.parse('2026-09-12T15:00:00.000Z');
    const clock = [at - 1, at];
    let tick = 0;
    const store = new InMemoryRunStore({
      now: (): Date => {
        const instant = clock[tick];
        if (instant === undefined) throw new Error('the controlled clock was read too many times');
        tick += 1;
        return new Date(instant);
      },
    });
    const harness = install({}, store);
    const before = await seedRun(harness.store);
    const exact = await seedRun(harness.store);

    const ids = async (query: string): Promise<string[]> =>
      (await listBody(await listRuns(get(`http://web/api/runs?${query}`)))).runs.map(
        (run) => run['id'] as string,
      );
    const tokyoMidnight = encodeURIComponent('2026-09-13T00:00:00+09:00');
    const tokyoMidnightLessOneMs = encodeURIComponent('2026-09-12T23:59:59.999+09:00');
    expect(await ids(`from=${tokyoMidnight}`)).toEqual([exact.id]);
    expect(await ids(`to=${tokyoMidnight}`)).toEqual([exact.id, before.id]);
    expect(await ids(`to=${tokyoMidnightLessOneMs}`)).toEqual([before.id]);
    expect(await ids(`from=${tokyoMidnightLessOneMs}`)).toEqual([exact.id, before.id]);
    // The same instant written three more ways answers the same rows.
    for (const spelling of [
      '2026-09-12T15:00:00Z',
      '2026-09-12T15:00:00.000Z',
      '2026-09-12T09:30:00-05:30',
    ]) {
      expect(await ids(`from=${encodeURIComponent(spelling)}`)).toEqual([exact.id]);
      expect(await ids(`to=${encodeURIComponent(spelling)}`)).toEqual([exact.id, before.id]);
    }
    // A fractional part is honoured at the millisecond: one ms later excludes the exact run
    // from `from=` and changes nothing for `to=`.
    const nextMs = encodeURIComponent('2026-09-12T15:00:00.001Z');
    expect(await ids(`from=${nextMs}`)).toEqual([]);
    expect(await ids(`to=${nextMs}`)).toEqual([exact.id, before.id]);
  });

  it('reads a one- and a two-digit fraction as tenths and hundredths of a second, not as milliseconds', async () => {
    // `parseRunListBound` right-pads the fractional part before reading it as milliseconds, so
    // `.5` and `.50` both mean 500 ms. Dropping the padding would read them as 5 ms and 50 ms —
    // a silent 495 ms shift of the bound, in the direction that serves rows the caller excluded.
    // Three runs, not two: with only `.499` and `.500` the `to=` direction cannot tell 500 ms
    // from 5 ms, because both bounds keep the same pair. The `.005` run is what separates them.
    const base = Date.parse('2026-09-12T15:00:00.000Z');
    const clock = [base + 5, base + 499, base + 500];
    let tick = 0;
    const store = new InMemoryRunStore({
      now: (): Date => {
        const instant = clock[tick];
        if (instant === undefined) throw new Error('the controlled clock was read too many times');
        tick += 1;
        return new Date(instant);
      },
    });
    const harness = install({}, store);
    const fiveMs = await seedRun(harness.store);
    const justBefore = await seedRun(harness.store);
    const atHalf = await seedRun(harness.store);

    const ids = async (query: string): Promise<string[]> =>
      (await listBody(await listRuns(get(`http://web/api/runs?${query}`)))).runs.map(
        (run) => run['id'] as string,
      );
    for (const spelling of ['2026-09-12T15:00:00.5Z', '2026-09-12T15:00:00.50Z']) {
      const bound = encodeURIComponent(spelling);
      // `from` is inclusive at 500 ms, so the run one millisecond before it is out.
      expect(await ids(`from=${bound}`)).toEqual([atHalf.id]);
      // `to` is inclusive at 500 ms too, so all three are in — including the 5 ms run a
      // padding-free reading would have made the only match.
      expect(await ids(`to=${bound}`)).toEqual([atHalf.id, justBefore.id, fiveMs.id]);
    }
  });
});

function interruptRequest(runId: string, authenticated = true): Request {
  return new Request(`http://web/api/runs/${runId}/interrupt`, {
    method: 'POST',
    headers: authenticated ? { 'x-test-user': '1' } : {},
  });
}

describe('POST /api/runs/:id/interrupt (issue #235, S-14)', () => {
  it('answers 503 when the environment has no interruptRun implementation', async () => {
    install(); // the default harness in this file installs no interruptRun
    const run = await seedRun(new InMemoryRunStore());
    expect((await interruptRun(interruptRequest(run.id), run.id)).status).toBe(503);
  });

  it('returns 401 unauthenticated, 400 for a non-UUID, and 404 for an unknown run', async () => {
    install({ interruptRun: () => Promise.resolve() });
    expect((await interruptRun(interruptRequest('x', false), 'x')).status).toBe(401);
    expect((await interruptRun(interruptRequest('x'), 'x')).status).toBe(400);
    expect((await interruptRun(interruptRequest(newRunId()), newRunId())).status).toBe(404);
  });

  it('conceals a foreign-workspace run behind the same 404 as a nonexistent one (§25)', async () => {
    const harness = install({ interruptRun: () => Promise.resolve() });
    const run = await seedRun(harness.store, { workspaceId: OTHER_WORKSPACE });
    expect((await interruptRun(interruptRequest(run.id), run.id)).status).toBe(404);
  });

  it('the state matrix: queued and running are interruptible; every terminal status is 409', async () => {
    for (const status of runStatuses) {
      const store = new InMemoryRunStore();
      let calls = 0;
      install(
        {
          interruptRun: () => {
            calls += 1;
            return Promise.resolve();
          },
        },
        store,
      );
      const run = await seedRun(store);
      if (status !== 'queued') {
        if (status === 'running') await store.markRunning(run.id);
        else await store.finish(run.id, status, null);
      }
      const response = await interruptRun(interruptRequest(run.id), run.id);
      if (status === 'queued' || status === 'running') {
        expect(response.status, status).toBe(200);
        expect(calls, status).toBe(1);
      } else {
        expect(response.status, status).toBe(409);
        expect(await errorCode(response), status).toBe('run_not_interruptible');
        expect(calls, status).toBe(0);
      }
    }
  });

  it('interruptRunFor hands a live run to the runtime and reports a finished one as terminal', async () => {
    const store = new InMemoryRunStore();
    const stopped: string[] = [];
    install(
      {
        interruptRun: (_principal, run) => {
          stopped.push(run.id);
          return Promise.resolve();
        },
      },
      store,
    );
    const env = getRunApi();
    if (env === null) throw new Error('harness installs the run API');
    const live = await seedRun(store);
    const done = await seedRun(store);
    await store.finish(done.id, 'completed', null);
    expect(await interruptRunFor(env, PRINCIPAL, live)).toBe('stopped');
    expect(await interruptRunFor(env, PRINCIPAL, (await store.get(done.id)) ?? done)).toBe(
      'terminal',
    );
    expect(stopped).toEqual([live.id]);
  });

  it('a second interrupt of the same run answers 409', async () => {
    const store = new InMemoryRunStore();
    install(
      {
        interruptRun: async (_principal, run) => {
          await store.finish(run.id, 'cancelled', 'interrupted');
        },
      },
      store,
    );
    const run = await seedRun(store);
    expect((await interruptRun(interruptRequest(run.id), run.id)).status).toBe(200);
    const second = await interruptRun(interruptRequest(run.id), run.id);
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe('run_not_interruptible');
  });

  it('responds with the run and its new status, parseable as InterruptRunResponseSchema', async () => {
    const store = new InMemoryRunStore();
    install(
      {
        interruptRun: async (_principal, run) => {
          await store.finish(run.id, 'cancelled', 'interrupted by request');
        },
      },
      store,
    );
    const run = await seedRun(store);
    const response = await interruptRun(interruptRequest(run.id), run.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { run: { id: string; status: string } };
    expect(body.run.id).toBe(run.id);
    expect(body.run.status).toBe('cancelled');
    // The title's claim, asserted: `.strict()`, so a stray key on the envelope fails here rather
    // than in the SDK, which parses this response for real.
    expect(InterruptRunResponseSchema.safeParse(body).success).toBe(true);
  });

  it('the role matrix: Owner and Admin may interrupt any run; Builder and Viewer only their own', async () => {
    for (const role of ['owner', 'admin', 'builder', 'viewer'] as const) {
      for (const ownership of ['own', 'other'] as const) {
        const store = new InMemoryRunStore();
        install(
          {
            authenticate: () => Promise.resolve({ ...PRINCIPAL, role }),
            ownsRun: () => Promise.resolve(ownership === 'own'),
            interruptRun: () => Promise.resolve(),
          },
          store,
        );
        const run = await seedRun(store);
        const response = await interruptRun(interruptRequest(run.id), run.id);
        const allowed = role === 'owner' || role === 'admin' || ownership === 'own';
        expect(response.status, `${role} × ${ownership}`).toBe(allowed ? 200 : 403);
      }
    }
  });
});

describe('GET /api/runs/:id/events', () => {
  async function startedRun(): Promise<string> {
    const created = (await (await startRun(post(AGENT, { prompt: 'hi' }), AGENT)).json()) as {
      run: { id: string };
    };
    return created.run.id;
  }

  async function readAll(response: Response): Promise<string> {
    const body = response.body;
    if (body === null) throw new Error('no body');
    let text = '';
    const decoder = new TextDecoder();
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  }

  it('streams the run and closes with done when the run finishes', async () => {
    const harness = install();
    const runId = await startedRun();
    await harness.store.append(runId, { type: 'assistant', data: { text: 'hello' } });

    const response = await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const text = readAll(response);
    await harness.store.finish(runId, 'completed', null);
    const body = await text;
    expect(body).toContain('retry: 3000');
    expect(body).toMatch(
      /event: assistant\nid: 1\nat: \d{4}-\d\d-\d\dT[\d:.]+Z\ndata: \{"text":"hello"\}\n/u,
    );
    expect(body.endsWith('event: done\ndata: {}\n\n')).toBe(true);
  });

  it('lets an Admin stream another member’s transcript where a Viewer is refused — `events` inherits its parent’s grants, issue #165', async () => {
    const harness = install();
    const runId = await startedRun();
    await harness.store.append(runId, { type: 'assistant', data: { text: 'hello' } });
    await harness.store.finish(runId, 'completed', null);

    install({
      store: harness.store,
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'admin' }),
      ownsRun: () => Promise.resolve(false),
    });
    const admin = await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId);
    expect(admin.status).toBe(200);
    // The transcript itself, not merely the status code: run events carry prompt and response
    // text, so this is the real privacy surface the widening opens, and
    // docs/adr/W9-AUTH-165-admin-reads-workspace-run-history.md says so rather than leaving it to
    // be discovered.
    expect(await readAll(admin)).toContain('"hello"');

    install({
      store: harness.store,
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'viewer' }),
      ownsRun: () => Promise.resolve(false),
    });
    const viewer = await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId);
    expect(viewer.status).toBe(403);
  });

  it('replays from Last-Event-ID and delivers no duplicate', async () => {
    const harness = install();
    const runId = await startedRun();
    for (const text of ['a', 'b', 'c']) {
      await harness.store.append(runId, { type: 'assistant', data: text });
    }
    await harness.store.finish(runId, 'completed', null);

    const response = await streamRunEvents(
      get(`http://web/api/runs/${runId}/events`, { 'Last-Event-ID': '2' }),
      runId,
    );
    const body = await readAll(response);
    expect(body).not.toContain('"a"');
    expect(body).not.toContain('"b"');
    expect(body).toMatch(/event: assistant\nid: 3\nat: [\d\-T:.]+Z\ndata: "c"\n/u);
    expect(body).not.toContain('stream-reset');
  });

  it('accepts ?after= for a manually reconstructed EventSource', async () => {
    const harness = install();
    const runId = await startedRun();
    await harness.store.append(runId, { type: 'assistant', data: 'a' });
    await harness.store.append(runId, { type: 'assistant', data: 'b' });
    await harness.store.finish(runId, 'completed', null);
    const response = await streamRunEvents(
      get(`http://web/api/runs/${runId}/events?after=1`),
      runId,
    );
    const body = await readAll(response);
    expect(body).not.toContain('"a"');
    expect(body).toContain('id: 2');
  });

  it('rejects a malformed resume cursor with 400 instead of restarting from zero', async () => {
    install();
    const runId = await startedRun();
    const response = await streamRunEvents(
      get(`http://web/api/runs/${runId}/events`, { 'Last-Event-ID': 'nonsense' }),
      runId,
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_resume_cursor');
  });

  it('rejects the cursor before it looks the run up, so a bad id cannot probe for runs', async () => {
    install();
    const response = await streamRunEvents(
      get(`http://web/api/runs/${SESSION}/events`, { 'Last-Event-ID': '-1' }),
      SESSION,
    );
    expect(response.status).toBe(400);
  });

  it('announces a stream-reset in band when the cursor is unservable', async () => {
    const store = new InMemoryRunStore({ maxEventsPerRun: 2 });
    install({ store });
    const runId = await startedRun();
    for (const text of ['a', 'b', 'c', 'd']) {
      await store.append(runId, { type: 'assistant', data: text });
    }
    await store.finish(runId, 'completed', null);
    const response = await streamRunEvents(
      get(`http://web/api/runs/${runId}/events`, { 'Last-EVENT-id': '1' }),
      runId,
    );
    expect(response.status).toBe(200);
    const body = await readAll(response);
    expect(body).toContain('event: stream-reset');
    expect(body).toContain('"resumedAfter":"2"');
    expect(body).toContain('id: 3');
  });

  it('returns 401, 400 and 404 before it opens any stream', async () => {
    install();
    const runId = await startedRun();
    expect(
      (await streamRunEvents(get(`http://web/api/runs/${runId}/events`, {}, false), runId)).status,
    ).toBe(401);
    expect((await streamRunEvents(get('http://web/api/runs/x/events'), 'x')).status).toBe(400);
    expect(
      (await streamRunEvents(get(`http://web/api/runs/${SESSION}/events`), SESSION)).status,
    ).toBe(404);
  });

  it('tears the subscription down when the client disconnects', async () => {
    const harness = install();
    const runId = await startedRun();
    const controller = new AbortController();
    const request = new Request(`http://web/api/runs/${runId}/events`, {
      headers: { 'x-test-user': '1' },
      signal: controller.signal,
    });
    const response = await streamRunEvents(request, runId);
    const body = response.body;
    if (body === null) throw new Error('no body');
    const reader = body.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel();
    // The store must accept a new subscriber afterwards and deliver to it, which it cannot do if
    // the aborted one left its listener behind holding the run open.
    await harness.store.append(runId, { type: 'assistant', data: 'later' });
    await harness.store.finish(runId, 'completed', null);
    const second = await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId);
    expect(await readAll(second)).toContain('"later"');
  });
});

/**
 * The end of a stream must state the run's outcome, not merely that the stream is over.
 *
 * The reproduction is a run whose runtime is unreachable: `createRunnerLauncher` writes `failed`
 * onto the record, and a client watching the stream has to be able to tell that apart from a run
 * that succeeded — without a second request, because the whole point of §19's stream is that the
 * transcript is self-describing.
 */
describe('a run that ends failed', () => {
  async function readAll(response: Response): Promise<string> {
    const body = response.body;
    if (body === null) throw new Error('no body');
    let text = '';
    const decoder = new TextDecoder();
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  }

  it('ends the stream with run-failed before done, carrying the run error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    const harness = install(
      {
        launch: createRunnerLauncher({
          baseUrl: 'http://runner.invalid',
          store,
          // The §14.3 body is the composition root's to build (`server/compose/run-request.ts`);
          // this test is about what a client sees when the runtime cannot be reached, so the
          // body only has to exist.
          buildRunRequest: () => ({ runId: 'unused' }),
          fetch: (): Promise<Response> => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
        }),
      },
      store,
    );
    const created = (await (await startRun(post(AGENT, { prompt: 'hi' }), AGENT)).json()) as {
      run: { id: string };
    };
    const runId = created.run.id;

    const response = await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId);
    const body = await readAll(response);

    expect(body).toContain('event: run-failed');
    expect(body).toContain('The runtime could not be reached.');
    expect(body).not.toContain('getaddrinfo ENOTFOUND');
    expect(body.endsWith('event: done\ndata: {}\n\n')).toBe(true);
    // `run-failed` precedes `done`, so a client that closes on `done` has already seen it.
    expect(body.indexOf('event: run-failed')).toBeLessThan(body.indexOf('event: done'));
    expect((await harness.store.get(runId))?.status).toBe('failed');
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('sends no run-failed frame for a run that completed', async () => {
    const harness = install();
    const created = (await (await startRun(post(AGENT, { prompt: 'hi' }), AGENT)).json()) as {
      run: { id: string };
    };
    const runId = created.run.id;
    await harness.store.finish(runId, 'completed', null);
    const response = await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId);
    const body = await readAll(response);
    expect(body).not.toContain('run-failed');
    expect(body.endsWith('event: done\ndata: {}\n\n')).toBe(true);
  });
});

/**
 * The row-identity half of a session-scoped browser token's grammar (issue #236, SDK-04, S-1).
 * `decide()`'s scope grammar (`rbac/decide.ts`) enforces which route *shapes* a scope may reach;
 * these are the checks that live in this file because the path alone cannot carry a session id to
 * compare against (`readRun`/`streamRunEvents`'s `:id` is a run, `startRun`'s is an agent).
 */
describe('a session-scoped browser token’s row identity (issue #236)', () => {
  const OTHER_SESSION = '99999999-9999-4999-8999-999999999999';

  function sessionScopedPrincipal(sessionId: string): Principal {
    return { ...PRINCIPAL, scope: { kind: 'session', id: sessionId } };
  }

  function runScopedPrincipal(runId: string): Principal {
    return { ...PRINCIPAL, scope: { kind: 'run', id: runId } };
  }

  it('readRun allows a run in the scoped session and refuses one in another', async () => {
    const harness = install({
      authenticate: () => Promise.resolve(sessionScopedPrincipal(SESSION)),
    });
    await harness.store.create({
      engine: 'claude-agent-sdk',
      id: SESSION,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
    });
    expect((await readRun(get(`http://web/api/runs/${SESSION}`), SESSION)).status).toBe(200);

    const otherRunId = '88888888-8888-4888-8888-888888888888';
    await harness.store.create({
      engine: 'claude-agent-sdk',
      id: otherRunId,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: OTHER_SESSION,
    });
    const response = await readRun(get(`http://web/api/runs/${otherRunId}`), otherRunId);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('token_out_of_scope');
  });

  it('readRun allows a run-scoped token matching the run id, exactly as decide() would', async () => {
    // The row-identity check in this file is scope-kind specific: a run scope's `:id` match is
    // `decide()`'s own job (proved in `rbac/authorisation-matrix.test.ts`), so this file's guard
    // must not itself reject a run scope whose session happens to differ from anything.
    const harness = install({ authenticate: () => Promise.resolve(runScopedPrincipal(SESSION)) });
    await harness.store.create({
      engine: 'claude-agent-sdk',
      id: SESSION,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: OTHER_SESSION,
    });
    expect((await readRun(get(`http://web/api/runs/${SESSION}`), SESSION)).status).toBe(200);
  });

  it('startRun refuses a session-scoped token whose body omits sessionId or names another', async () => {
    install({ authenticate: () => Promise.resolve(sessionScopedPrincipal(SESSION)) });
    const omitted = await startRun(post(AGENT, { prompt: 'hello' }), AGENT);
    expect(omitted.status).toBe(403);
    expect(await errorCode(omitted)).toBe('token_out_of_scope');

    const mismatched = await startRun(
      post(AGENT, { prompt: 'hello', sessionId: OTHER_SESSION }),
      AGENT,
    );
    expect(mismatched.status).toBe(403);
    expect(await errorCode(mismatched)).toBe('token_out_of_scope');

    const matched = await startRun(post(AGENT, { prompt: 'hello', sessionId: SESSION }), AGENT);
    expect(matched.status).toBe(202);
  });

  it('revokeRunTokens refuses any browser-token principal outright, whatever its role', async () => {
    install({
      authenticate: () =>
        Promise.resolve({ ...sessionScopedPrincipal(SESSION), role: 'owner' as const }),
      revokeRunTokens: () => Promise.resolve({ revoked: 0, outcome: 'not-found' }),
    });
    const response = await revokeRunTokens(
      new Request(`http://web/api/runs/${SESSION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-user': '1' },
        body: JSON.stringify({}),
      }),
      SESSION,
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('token_out_of_scope');
  });
});

/**
 * The classifier that decides what the last frames of a stream say.
 *
 * Its `succeeded` arm is the only one that lets a stream end with a bare `done`, and it is
 * reachable only from a record that positively reads `completed` (ADR-0015). The table below is
 * driven from `runStatuses` so a status added to the lifecycle and not to the classifier fails
 * here rather than falling through to `succeeded` in production.
 */
describe('classifyRunOutcome', () => {
  const record = (status: RunStatus, error: string | null = null): RunRecord => ({
    id: SESSION,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    sessionId: SESSION,
    status,
    createdAt: new Date(0),
    startedAt: null,
    endedAt: null,
    error,
  });

  it('treats a run as successful only when its record says completed', () => {
    const succeeding = runStatuses.filter(
      (status) => classifyRunOutcome(record(status), SESSION).kind === 'succeeded',
    );
    expect(succeeding).toEqual(['completed']);
  });

  it('reports every other terminal status as a failure, with the run error', () => {
    expect(classifyRunOutcome(record('failed', 'the runtime vanished'), SESSION)).toEqual({
      kind: 'failed',
      status: 'failed',
      message: 'the runtime vanished',
    });
    expect(classifyRunOutcome(record('cancelled'), SESSION).kind).toBe('failed');
  });

  it('never claims an outcome it does not have', () => {
    for (const status of ['queued', 'running'] as const) {
      expect(classifyRunOutcome(record(status), SESSION).kind).toBe('indeterminate');
    }
    expect(classifyRunOutcome(null, SESSION).kind).toBe('indeterminate');
  });
});

describe('runs.start refuses a run its configuration cannot launch (issue #393)', () => {
  it('answers 422 with the preflight code, and creates no run and launches nothing', async () => {
    const harness = install({
      preflight: () =>
        Promise.resolve({
          code: 'agent_runtime_profile_missing',
          message: 'agent "General" has no runtime profile.',
        }),
    });
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({
      code: 'agent_runtime_profile_missing',
      message: 'agent "General" has no runtime profile.',
    });
    expect((await harness.store.listRuns(WORKSPACE, { limit: 10 })).items).toHaveLength(0);
    expect(harness.launched).toHaveLength(0);
  });

  // PR #403 review: a refused first message must not leave an empty session behind.
  it('refuses a first message before opening its session, so no session is created', async () => {
    let opened = 0;
    install({
      preflight: () =>
        Promise.resolve({
          code: 'agent_runtime_profile_missing',
          message: 'agent "General" has no runtime profile.',
        }),
      openSession: (_p, agent) => {
        opened += 1;
        return Promise.resolve({ id: SESSION, agentId: agent.id, engine: null });
      },
    });
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(response.status).toBe(422);
    expect(opened).toBe(0);
  });

  // PR #403 review: a client-opened session is never deleted by a refused start.
  it('keeps a client-opened session when its first start is refused', async () => {
    const opened: (string | null)[] = [];
    install({
      preflight: () =>
        Promise.resolve({ code: 'model_connection_unresolved', message: 'no workspace default.' }),
      openSession: (_p, agent, requested) => {
        opened.push(requested);
        return Promise.resolve({ id: requested ?? SESSION, agentId: agent.id, engine: null });
      },
    });
    const refused = await startRun(post(AGENT, { prompt: 'hi', sessionId: SESSION }), AGENT);
    expect(refused.status).toBe(422);
    // The route looked the client's session up, and created nothing and removed nothing.
    expect(opened).toEqual([SESSION]);
  });

  it('answers model_connection_unresolved the same way', async () => {
    install({
      preflight: () =>
        Promise.resolve({
          code: 'model_connection_unresolved',
          message: 'no workspace default is configured.',
        }),
    });
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('model_connection_unresolved');
  });

  // E: the composer's follow-up resumes the session. It is the same route, so it must pass the
  // same check with the session it resumes, and be launched as a resume of that session.
  it('checks and launches a follow-up message in the same session through the same path', async () => {
    const checked: { sessionId: string | null; override: unknown }[] = [];
    const harness = install({
      preflight: (_principal, _agent, sessionId, modelOverride) => {
        checked.push({ sessionId, override: modelOverride });
        return Promise.resolve(null);
      },
      openSession: (_p, agent, requested) =>
        Promise.resolve(
          requested === null
            ? { id: SESSION, agentId: agent.id, engine: null }
            : requested === SESSION
              ? { id: SESSION, agentId: agent.id, engine: 'claude-agent-sdk', resume: true }
              : null,
        ),
    });

    const first = await startRun(post(AGENT, { prompt: 'first' }), AGENT);
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { run: { sessionId: string } };
    const followUp = await startRun(
      post(AGENT, { prompt: 'second', sessionId: firstBody.run.sessionId }),
      AGENT,
    );
    expect(followUp.status).toBe(202);

    // The first message is checked before its session is opened; the follow-up with its session.
    expect(checked).toEqual([
      { sessionId: null, override: null },
      { sessionId: SESSION, override: null },
    ]);
    expect(harness.launched).toHaveLength(2);
    expect(harness.launched[1]?.session).toMatchObject({ id: SESSION, resume: true });
    expect(harness.launched[1]?.prompt).toBe('second');
  });

  it('answers 409 session_busy, launching nothing, when the store refuses a second open run', async () => {
    // The refusal itself is the repository's (core `create`, under the session lock).
    const store = new InMemoryRunStore();
    store.create = () => Promise.reject(new SessionBusyError(SESSION));
    const harness = install({}, store);
    const response = await startRun(post(AGENT, { prompt: 'again', sessionId: SESSION }), AGENT);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('session_busy');
    expect(harness.launched).toHaveLength(0);
  });

  it('records the code on a run refused after it was queued, and streams it in run-failed', async () => {
    const store = new InMemoryRunStore();
    install(
      {
        launch: createRunnerLauncher({
          baseUrl: 'http://runner.invalid',
          store,
          buildRunRequest: () => {
            throw runStartRefusalError({
              code: 'model_connection_unresolved',
              message: 'no workspace default is configured.',
            });
          },
        }),
      },
      store,
    );
    const created = (await (await startRun(post(AGENT, { prompt: 'hi' }), AGENT)).json()) as {
      run: { id: string };
    };
    const runId = created.run.id;
    await vi.waitFor(async () => {
      expect((await store.get(runId))?.status).toBe('failed');
    });
    const stored = await store.get(runId);
    expect(parseRunFailure(stored?.error ?? null)).toEqual({
      code: 'model_connection_unresolved',
      message: 'no workspace default is configured.',
    });
    const response = await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId);
    expect(await response.text()).toContain(
      'model_connection_unresolved: no workspace default is configured.',
    );
  });
});

describe('startRunOnSession (issue #618)', () => {
  const input = { prompt: 'hi', sessionId: null, modelOverride: null };
  const agent: AgentRef = { id: AGENT, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' };
  const installed = (overrides: Partial<RunApiEnvironment> = {}) => {
    const harness = install(overrides);
    const env = getRunApi();
    if (env === null) throw new Error('the run API was not installed');
    return { harness, env };
  };

  it('starts and launches a run on a fresh session', async () => {
    const { harness, env } = installed();
    const started = await startRunOnSession(env, PRINCIPAL, agent, input);
    if (started.kind !== 'started') throw new Error(`refused: ${started.code}`);
    expect(started.session.id).toBe(SESSION);
    expect(harness.launched.map((context) => [context.run.id, context.prompt])).toEqual([
      [started.run.id, 'hi'],
    ]);
  });

  it('answers the preflight refusal with its contract status, and starts nothing', async () => {
    const { harness, env } = installed({
      preflight: () => Promise.resolve({ code: 'model_unavailable', message: 'gone.' }),
    });
    expect(await startRunOnSession(env, PRINCIPAL, agent, input)).toEqual({
      kind: 'refused',
      status: 422,
      code: 'model_unavailable',
      message: 'gone.',
    });
    expect(harness.launched).toHaveLength(0);
  });
});

describe('runs.start version targeting (issue #697)', () => {
  const VERSION_ID = '99999999-9999-4999-8999-999999999999';
  /** Version 3 of the agent exists in WORKSPACE only: the lookup is scoped by the principal. */
  const findAgentVersion: NonNullable<RunApiEnvironment['findAgentVersion']> = (
    principal,
    agentId,
    number,
  ) =>
    Promise.resolve(
      principal.workspaceId === WORKSPACE && agentId === AGENT && number === 3
        ? { id: VERSION_ID }
        : null,
    );
  const pinned: (string | undefined)[] = [];
  const installTargeting = (overrides: Partial<RunApiEnvironment> = {}) => {
    pinned.length = 0;
    return install({
      findAgentVersion,
      openSession: (_p, agent, _requested, agentVersionId) => {
        pinned.push(agentVersionId);
        return Promise.resolve({ id: SESSION, agentId: agent.id, engine: null });
      },
      ...overrides,
    });
  };

  it('pins the new session to the named version', async () => {
    const harness = installTargeting();
    const response = await startRun(post(AGENT, { prompt: 'hi', version: 3 }), AGENT);
    expect(response.status).toBe(202);
    expect(pinned).toEqual([VERSION_ID]);
    expect(harness.launched).toHaveLength(1);
  });

  it('keeps the local pointer when no version is named', async () => {
    installTargeting();
    expect((await startRun(post(AGENT, { prompt: 'hi' }), AGENT)).status).toBe(202);
    expect(pinned).toEqual([undefined]);
  });

  it('refuses an unknown version with agent_version_not_found and starts nothing', async () => {
    const harness = installTargeting();
    const response = await startRun(post(AGENT, { prompt: 'hi', version: 9 }), AGENT);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('agent_version_not_found');
    expect(pinned).toEqual([]);
    expect(harness.launched).toHaveLength(0);
  });

  it("refuses another workspace's version the same way", async () => {
    installTargeting({
      authenticate: () => Promise.resolve({ ...PRINCIPAL, workspaceId: OTHER_WORKSPACE }),
      findAgent: (principal) =>
        Promise.resolve({
          id: AGENT,
          workspaceId: principal.workspaceId,
          engine: 'claude-agent-sdk',
        }),
    });
    const response = await startRun(post(AGENT, { prompt: 'hi', version: 3 }), AGENT);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('agent_version_not_found');
  });

  it('refuses a version when the deployment cannot look versions up', async () => {
    install();
    const response = await startRun(post(AGENT, { prompt: 'hi', version: 3 }), AGENT);
    expect(await errorCode(response)).toBe('agent_version_not_found');
  });

  it('refuses a version on a follow-up, and a malformed one', async () => {
    installTargeting();
    for (const body of [
      { prompt: 'hi', version: 3, sessionId: SESSION },
      { prompt: 'hi', version: 0 },
      { prompt: 'hi', version: '3' },
    ]) {
      const response = await startRun(post(AGENT, body), AGENT);
      expect([response.status, await errorCode(response)]).toEqual([400, 'invalid_body']);
    }
  });
});

describe('startRun under the deployment policy ceiling (issue #535)', () => {
  const CONNECTION = '88888888-8888-4888-8888-888888888888';
  const overrideBody = (model: string) => ({ prompt: 'hi', modelConnectionId: CONNECTION, model });

  function installWithCeiling(policy: Parameters<typeof recordingCeilingFor>[0] | null) {
    const recording = policy === null ? null : recordingCeilingFor(policy);
    const preflight = vi.fn(() => Promise.resolve(null));
    const openSession = vi.fn((_p: Principal, agent: AgentRef) =>
      Promise.resolve<SessionRef | null>({ id: SESSION, agentId: agent.id, engine: null }),
    );
    const harness = install({
      preflight,
      openSession,
      ...(recording === null ? {} : { ceilingFor: recording.ceilingFor }),
    });
    return { harness, preflight, openSession, audit: recording?.audit ?? [] };
  }

  it('refuses a modelOverride outside policy.models before any session, preflight or run', async () => {
    const { harness, preflight, openSession, audit } = installWithCeiling({
      models: ['claude-sonnet-4-5'],
    });
    const response = await startRun(post(AGENT, overrideBody('gpt-5.1')), AGENT);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: 'policy_cannot_widen',
        message: "The agent would be wider than this deployment's policy ceiling allows.",
        details: ['model:gpt-5.1'],
      },
    });
    expect(preflight).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
    expect(harness.launched).toHaveLength(0);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'agent-changed', subjectId: AGENT });
  });

  it('starts a run whose modelOverride is inside policy.models', async () => {
    const { harness } = installWithCeiling({ models: ['claude-sonnet-4-5'] });
    const response = await startRun(post(AGENT, overrideBody('claude-sonnet-4-5')), AGENT);
    expect(response.status).toBe(202);
    expect(harness.launched).toHaveLength(1);
  });

  it('leaves the stored engine to preflight (S2-04c): no override is not refused at start', async () => {
    const { harness } = installWithCeiling({ engines: ['pi'], models: ['claude-sonnet-4-5'] });
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(response.status).toBe(202);
    expect(harness.launched).toHaveLength(1);
  });

  it('judges only the model: a ceiling without models never refuses at start', async () => {
    const { harness } = installWithCeiling({ engines: ['pi'] });
    const response = await startRun(post(AGENT, overrideBody('anything')), AGENT);
    expect(response.status).toBe(202);
    expect(harness.launched).toHaveLength(1);
  });

  it('reads a follow-up’s agent for its conversation, so a push never refuses its next turn (#612)', async () => {
    const recording = recordingCeilingFor({ models: ['claude-sonnet-4-5'] });
    // The row a push moved runs `pi`; the conversation is pinned to a version on the SDK engine.
    const findAgent = vi.fn((principal: Principal, agentId: string, sessionId?: string | null) =>
      Promise.resolve<AgentRef | null>({
        id: agentId,
        workspaceId: principal.workspaceId,
        engine: sessionId === SESSION ? 'claude-agent-sdk' : 'pi',
      }),
    );
    const harness = install({
      findAgent,
      ceilingFor: recording.ceilingFor,
      openSession: (_p, agent) =>
        Promise.resolve({ id: SESSION, agentId: agent.id, engine: 'claude-agent-sdk' }),
    });
    const response = await startRun(
      post(AGENT, { ...overrideBody('claude-sonnet-4-5'), sessionId: SESSION }),
      AGENT,
    );
    expect(response.status).toBe(202);
    expect(findAgent).toHaveBeenCalledWith(PRINCIPAL, AGENT, SESSION);
    expect(harness.launched[0]?.agent.engine).toBe('claude-agent-sdk');
    expect(recording.audit).toEqual([]);
  });

  it('is unchanged without a ceiling', async () => {
    const { harness } = installWithCeiling(null);
    const response = await startRun(post(AGENT, overrideBody('gpt-5.1')), AGENT);
    expect(response.status).toBe(202);
    expect(harness.launched).toHaveLength(1);
  });
});

/** Issue #622: a surface visitor's turns are capped by its surface's `turnsPerConversation`. */
describe('a surface visitor’s turn limit (issue #622)', () => {
  const VISITOR: Principal = { ...PRINCIPAL, scope: { kind: 'session', id: SESSION } };
  const SURFACE = { name: 'main', agent: 'support', limits: { turnsPerConversation: 2 } };

  afterEach(() => {
    resetSurfaceLimits();
  });

  it('refuses turn N+1 with 429 surface_turn_limit_reached, starting no run', async () => {
    const harness = install({
      authenticate: () => Promise.resolve(VISITOR),
      admitVisitorWrite: (_workspaceId, sessionId, kind, headers) =>
        Promise.resolve(admitVisitorWrite(SURFACE, sessionId, kind, headers)),
    });
    for (let turn = 0; turn < 2; turn += 1) {
      const started = await startRun(post(AGENT, { prompt: 'hi', sessionId: SESSION }), AGENT);
      expect(started.status).toBe(202);
    }
    const refused = await startRun(post(AGENT, { prompt: 'hi', sessionId: SESSION }), AGENT);
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe('surface_turn_limit_reached');
    expect(refused.headers.get('retry-after')).toBeNull();
    expect(harness.launched).toHaveLength(2);
  });

  it('never asks the hook about a principal with no session scope', async () => {
    const asked: string[] = [];
    install({
      admitVisitorWrite: (_workspaceId, sessionId) => {
        asked.push(sessionId);
        return Promise.resolve(null);
      },
    });
    const started = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(started.status).toBe(202);
    expect(asked).toEqual([]);
  });
});
