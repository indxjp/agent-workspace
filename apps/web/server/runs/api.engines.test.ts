import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTestRunApi } from '../application-context-fixtures';
import {
  clearEngineImagesConfiguredForTests,
  configureEngineImagesForTests,
} from '../engines/images';
import { startRun } from './api';
import {
  AGENT,
  errorCode,
  install,
  installWithEngines,
  post,
  SESSION,
  TEST_ENGINE,
  WORKSPACE,
} from './api.test-support';

afterEach(() => {
  resetTestRunApi();
});

const outputSchema = { type: 'object', properties: { verdict: { type: 'string' } } };
const image = (engine: string): string =>
  `registry.example/private-project/runtime-${engine}@sha256:${'c'.repeat(64)}`;
function configureStructuredOutputImages(): void {
  beforeEach(() => {
    configureEngineImagesForTests(
      new Map([
        ['claude-agent-sdk', image('claude-agent-sdk')],
        ['openai-agents', image('openai-agents')],
        ['pi', image('pi')],
      ]),
    );
  });
  afterEach(clearEngineImagesConfiguredForTests);
}

// ── ADR-0065 D8: a session stays on the engine it started with (#318) ───────────────────────
//
// The agent's engine is a `string` on `AgentRef` precisely so this refusal can be reached: while
// `ENGINE_IDS` publishes one member, a test-only registered descriptor is the only second engine
// a deployment can have, and comparing two `EngineId`s could never differ.
describe('POST /api/agents/:id/runs > session engine pinning', () => {
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
});

describe('POST /api/agents/:id/runs > session engine pinning', () => {
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

describe('POST /api/agents/:id/runs > session engine pinning > outputSchema (ADR-0143)', () => {
  configureStructuredOutputImages();
  it('forwards the schema to the run row and the launch on an engine that supports it', async () => {
    const harness = installWithEngines(null, 'claude-agent-sdk');
    const response = await startRun(post(AGENT, { prompt: 'hi', outputSchema }), AGENT);
    expect(response.status).toBe(202);
    expect(harness.launched).toHaveLength(1);
    expect(harness.launched[0]?.outputSchema).toEqual(outputSchema);
    const body = (await response.json()) as { run: Record<string, unknown> };
    expect(body.run['output']).toBeNull();
  });

  it('forwards the schema on the OpenAI Agents engine too', async () => {
    const harness = installWithEngines(null, 'openai-agents');
    const response = await startRun(post(AGENT, { prompt: 'hi', outputSchema }), AGENT);
    expect(response.status).toBe(202);
    expect(harness.launched[0]?.outputSchema).toEqual(outputSchema);
  });

  it('launches without an outputSchema when the request carried none', async () => {
    const harness = installWithEngines(null, 'claude-agent-sdk');
    await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(harness.launched[0]).not.toHaveProperty('outputSchema');
  });
});

describe('POST /api/agents/:id/runs > session engine pinning > outputSchema (ADR-0143)', () => {
  configureStructuredOutputImages();
  it('answers 400 invalid_body naming the limit, and creates no run', async () => {
    const harness = installWithEngines(null, 'claude-agent-sdk');
    const response = await startRun(
      post(AGENT, { prompt: 'hi', outputSchema: { type: 'array' } }),
      AGENT,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_body');
    expect(body.error.message).toContain('root_type');
    expect((await harness.store.listRuns(WORKSPACE, { limit: 10 })).items).toHaveLength(0);
  });

  it('answers 422 engine_capability_unsupported with the capability, and creates no run', async () => {
    const harness = installWithEngines(null, 'pi');
    const response = await startRun(post(AGENT, { prompt: 'hi', outputSchema }), AGENT);
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string; details?: string[] };
    };
    expect(body.error.code).toBe('engine_capability_unsupported');
    expect(body.error.details).toEqual(['structuredOutput']);
    expect(body.error.message).toContain('pi');
    expect((await harness.store.listRuns(WORKSPACE, { limit: 10 })).items).toHaveLength(0);
    expect(harness.launched).toHaveLength(0);
  });
});

describe('POST /api/agents/:id/runs > session engine pinning > outputSchema (ADR-0143)', () => {
  configureStructuredOutputImages();
  it('refuses an unsupported schema before opening a new session', async () => {
    let opened = 0;
    install({
      findAgent: (principal, id) =>
        Promise.resolve(
          id === AGENT ? { id: AGENT, workspaceId: principal.workspaceId, engine: 'pi' } : null,
        ),
      openSession: (_p, agent) => {
        opened += 1;
        return Promise.resolve({ id: SESSION, agentId: agent.id, engine: null });
      },
    });
    const response = await startRun(post(AGENT, { prompt: 'hi', outputSchema }), AGENT);
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('engine_capability_unsupported');
    expect(opened).toBe(0);
  });

  it('still starts a run with no schema on an engine without structured output', async () => {
    const harness = installWithEngines(null, 'pi');
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(response.status).toBe(202);
    expect(harness.launched).toHaveLength(1);
  });
});

describe('POST /api/agents/:id/runs > session engine pinning > engine images', () => {
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
