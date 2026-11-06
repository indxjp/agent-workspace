import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetTestRunApi } from '../application-context-fixtures';
import { recordingCeilingFor } from '../policy-ceiling/fixtures';
import { admitVisitorWrite, resetSurfaceLimits } from '../surfaces/public/limits';
import { startRun } from './api';
import {
  AGENT,
  errorCode,
  install,
  OTHER_WORKSPACE,
  post,
  PRINCIPAL,
  SESSION,
  WORKSPACE,
} from './api.test-support';
import {
  type AgentRef,
  type RunApiEnvironment,
  type RunPrincipal,
  type SessionRef,
} from './environment';

afterEach(() => {
  resetTestRunApi();
});

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
const CONNECTION = '88888888-8888-4888-8888-888888888888';
const overrideBody = (model: string) => ({ prompt: 'hi', modelConnectionId: CONNECTION, model });
function installWithCeiling(policy: Parameters<typeof recordingCeilingFor>[0] | null) {
  const recording = policy === null ? null : recordingCeilingFor(policy);
  const preflight = vi.fn(() => Promise.resolve(null));
  const openSession = vi.fn((_p: RunPrincipal, agent: AgentRef) =>
    Promise.resolve<SessionRef | null>({ id: SESSION, agentId: agent.id, engine: null }),
  );
  const harness = install({
    preflight,
    openSession,
    ...(recording === null ? {} : { ceilingFor: recording.ceilingFor }),
  });
  return { harness, preflight, openSession, audit: recording?.audit ?? [] };
}

describe('runs.start version targeting (issue #697)', () => {
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
});

describe('runs.start version targeting (issue #697)', () => {
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
});

describe('startRun under the deployment policy ceiling (issue #535)', () => {
  it('reads a follow-up’s agent for its conversation, so a push never refuses its next turn (#612)', async () => {
    const recording = recordingCeilingFor({ models: ['claude-sonnet-4-5'] });
    // The row a push moved runs `pi`; the conversation is pinned to a version on the SDK engine.
    const findAgent = vi.fn((principal: RunPrincipal, agentId: string, sessionId?: string | null) =>
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
  const VISITOR: RunPrincipal = { ...PRINCIPAL, scope: { kind: 'session', id: SESSION } };
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
