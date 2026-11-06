import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRunFailure } from '@indx-workspace/contracts/runs';
import { resetTestRunApi } from '../application-context-fixtures';
import { runStartRefusalError } from '../compose/run-preflight';
import { startRun, streamRunEvents } from './api';
import {
  AGENT,
  errorCode,
  get,
  install,
  post,
  PRINCIPAL,
  SESSION,
  WORKSPACE,
} from './api.test-support';
import { type AgentRef, getRunApi, type RunApiEnvironment } from './environment';
import { createRunnerLauncher } from './launcher';
import { InMemoryRunStore } from './memory-store';
import { startRunOnSession } from './service';
import { SessionBusyError } from './store';

afterEach(() => {
  resetTestRunApi();
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
});

describe('runs.start refuses a run its configuration cannot launch (issue #393)', () => {
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
});

describe('runs.start refuses a run its configuration cannot launch (issue #393)', () => {
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
