import type { EngineRunRequest } from '@agent-workspace/engine';
import { createScriptedGateway } from '@agent-workspace/engine/testing';
import type { ClassifiedSdkEvent } from '@agent-workspace/run-protocol';
import { expect, it } from 'vitest';

import { CLAUDE_AGENT_SDK_ENGINE_ID, createClaudeAgentSdkEngine } from './engine.js';
import {
  AGENT,
  CLAUDE_AGENT_SDK_ENGINE_ADAPTER,
  POLICY,
  PROJECT_KEY,
  RECORDED_RUN,
  replayingStarter,
} from './engine.test-support.js';

// Issue #661: the bundled CLI retried a rejected key for minutes before failing with a generic
// "API Error: 500"; the run now fails at the first auth retry with the code the preflight uses.

const gateway = createScriptedGateway();
const request: EngineRunRequest = {
  runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
  sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
  projectKey: PROJECT_KEY,
  cwd: '/workspace/conformance',
  prompt: 'go',
  engine: CLAUDE_AGENT_SDK_ENGINE_ID,
  portable: AGENT,
  policy: POLICY,
  session: { mode: 'fresh' },
  gateway: gateway.connection,
  resources: { files: [], skills: [] },
  env: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: gateway.connection.token },
};
const [init, ...rest] = RECORDED_RUN;

function retry(status: number | null): ClassifiedSdkEvent {
  return {
    kind: 'system',
    subtype: 'api_retry',
    event: {
      type: 'system',
      subtype: 'api_retry',
      session_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 500,
      error_status: status,
      error: status === 401 ? 'authentication_failed' : 'unknown',
    },
  };
}

/** The gateway's answer to the probe when the run token is good: the provider's `500`. */
const tokenAccepted = (): Promise<Response> =>
  Promise.resolve(Response.json({ error: 'upstream' }, { status: 500 }));

function started(
  status: number | null,
  probe: typeof fetch = tokenAccepted,
  startRequest: EngineRunRequest = request,
) {
  if (init === undefined) throw new Error('RECORDED_RUN is empty');
  const starter = replayingStarter([init, retry(status), ...rest]);
  const aborts: unknown[] = [];
  const probes: { url: string; authorization: string | null }[] = [];
  const engine = createClaudeAgentSdkEngine(
    (runRequest, deps) => {
      const run = starter(runRequest, deps);
      return {
        ...run,
        abort: (reason?: unknown) => {
          aborts.push(reason);
          run.abort(reason);
        },
      };
    },
    (input, init) => {
      probes.push({
        url: input instanceof Request ? input.url : input.toString(),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return probe(input, init);
    },
  );
  return { connection: engine.start(startRequest), aborts, probes };
}

async function failureOf(frames: AsyncIterable<unknown>): Promise<string> {
  const failure = await drain(frames).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  return failure instanceof Error ? failure.message : '';
}

async function drain(frames: AsyncIterable<unknown>): Promise<number> {
  const iterator = frames[Symbol.asyncIterator]();
  let count = 0;
  while (!(await iterator.next()).done) count += 1;
  return count;
}

it.each([401, 403])(
  'fails the run at the first retry after HTTP %i, and aborts it once',
  async (status) => {
    const { connection, aborts, probes } = started(status);
    const message = await failureOf(connection.frames);
    expect(probes).toEqual([
      {
        url: `${gateway.connection.baseUrl}/v1/models`,
        authorization: `Bearer ${gateway.connection.token}`,
      },
    ]);
    expect(message).toBe(
      `model_credential_rejected: the model provider rejected the API key (HTTP ${String(status)}).`,
    );
    expect(message).not.toContain(gateway.connection.token);
    expect(aborts).toHaveLength(1);
  },
);

it.each([429, 500, 529, null])(
  'keeps retrying after status %s and runs to its result',
  async (status) => {
    const { connection, aborts, probes } = started(status);
    await expect(drain(connection.frames)).resolves.toBeGreaterThan(0);
    expect(aborts).toHaveLength(0);
    expect(probes).toHaveLength(0);
  },
);

it.each([
  [401, 'token_invalid'],
  [401, 'token_revoked'],
  [403, 'token_run_mismatch'],
] as const)(
  "does not blame the key when the gateway refuses the run's own token (HTTP %i %s)",
  async (status, code) => {
    const { connection, aborts } = started(status, () =>
      Promise.resolve(
        Response.json(
          { type: 'error', error: { type: 'authentication_error', code, message: 'refused' } },
          { status },
        ),
      ),
    );
    const message = await failureOf(connection.frames);
    expect(message).toBe(
      `the model gateway refused this run's token (HTTP ${String(status)} ${code}).`,
    );
    expect(message).not.toMatch(/^model_credential_rejected:/u);
    expect(message).not.toContain(gateway.connection.token);
    expect(aborts).toHaveLength(1);
  },
);

it('blames the key when the gateway answers 401 without a token code (the provider refused it)', async () => {
  const { connection } = started(401, () =>
    Promise.resolve(Response.json({ error: { code: 'invalid_api_key' } }, { status: 401 })),
  );
  expect(await failureOf(connection.frames)).toMatch(/^model_credential_rejected:/u);
});

it('claims nothing about the key when the probe itself fails, and still stops', async () => {
  const { connection, aborts } = started(401, () => Promise.reject(new TypeError('fetch failed')));
  const message = await failureOf(connection.frames);
  expect(message).not.toMatch(/^model_credential_rejected:/u);
  expect(message).not.toContain(gateway.connection.token);
  expect(aborts).toHaveLength(1);
});

it('refuses a request with no gateway, whose own token would vouch for any key in env', () => {
  const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
    ...request,
    gateway: null,
    env: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'sk-ant-test-SENTINEL' },
  });
  expect(refused.ok ? '' : refused.code).toBe('engine_credential_refused');
});

it('emits the frames of the rejecting retry, and only then fails the stream', async () => {
  const { connection } = started(401);
  const seen: string[] = [];
  let failure: unknown = null;
  try {
    for await (const frame of connection.frames) {
      seen.push(frame.frame === 'agent.native' ? frame.type : frame.frame);
    }
  } catch (error) {
    failure = error;
  }
  expect(seen).toEqual(['agent.session', 'system/api_retry']);
  expect(failure).toBeInstanceOf(Error);
  expect(failure instanceof Error ? failure.message : '').toMatch(/^model_credential_rejected:/u);
});

it('rejects engineSessionId when the stream ends without a system/init', async () => {
  const connection = createClaudeAgentSdkEngine(replayingStarter(rest)).start(request);
  await drain(connection.frames);
  await expect(connection.engineSessionId).rejects.toThrow(
    /ended without any frame carrying an engine session id/u,
  );
});

it('aborts the controller handed to the run starter on interrupt()', async () => {
  const handed: (AbortController | undefined)[] = [];
  const starter = replayingStarter();
  const connection = createClaudeAgentSdkEngine((runRequest, deps) => {
    handed.push(deps?.abortController);
    return starter(runRequest, deps);
  }).start(request);
  expect(handed[0]?.signal.aborted).toBe(false);
  await connection.interrupt();
  expect(handed[0]?.signal.aborted).toBe(true);
});

import { vi } from 'vitest';

// The real `compileRunRequest` behind a spy, so a test can count the compiles one start performs.
vi.mock('./compile.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./compile.js')>();
  return { ...original, compileRunRequest: vi.fn(original.compileRunRequest) };
});
