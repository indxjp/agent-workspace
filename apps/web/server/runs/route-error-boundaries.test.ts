import { log as webLogger } from '../telemetry/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as startRunRoute } from '../../app/api/agents/[id]/runs/route';
import { GET as readRunRoute, POST as revokeRunRoute } from '../../app/api/runs/[id]/route';
import { GET as streamRunRoute } from '../../app/api/runs/[id]/events/route';
import type { RunApiEnvironment } from './environment';
import { InMemoryRunStore } from './memory-store';
import { installTestRunApi, resetTestRunApi } from '../application-context-fixtures';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const SENTINEL = 'postgresql://admin:SECRET_SENTINEL@internal.example/workspace';

function failingEnvironment(): RunApiEnvironment {
  return {
    authenticate: () => Promise.reject(new Error(SENTINEL)),
    findAgent: () => Promise.reject(new Error('not used')),
    openSession: () => Promise.reject(new Error('not used')),
    ownsRun: () => Promise.reject(new Error('not used')),
    revokeRunTokens: () => Promise.reject(new Error(SENTINEL)),
    store: new InMemoryRunStore(),
    launch: () => undefined,
  };
}

async function expectSafeFailure(response: Response): Promise<void> {
  expect(response.status).toBe(500);
  const text = await response.text();
  expect(text).not.toContain(SENTINEL);
  expect(JSON.parse(text)).toEqual({
    error: { code: 'internal_error', message: 'The request could not be completed.' },
  });
}

describe('run route error boundaries', () => {
  beforeEach(() => {
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    installTestRunApi(failingEnvironment());
  });

  afterEach(() => {
    resetTestRunApi();
    vi.restoreAllMocks();
  });

  it('returns a fixed 500 for an unexpected start failure', async () => {
    const request = new Request(`http://web/api/agents/${RUN_ID}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    await expectSafeFailure(
      await startRunRoute(request as never, { params: Promise.resolve({ id: RUN_ID }) }),
    );
  });

  it('returns fixed 500 responses for unexpected read and stream failures', async () => {
    const request = new Request(`http://web/api/runs/${RUN_ID}`);
    const context = { params: Promise.resolve({ id: RUN_ID }) };
    await expectSafeFailure(await readRunRoute(request as never, context));
    await expectSafeFailure(await revokeRunRoute(request as never, context));
    await expectSafeFailure(await streamRunRoute(request as never, context));
  });

  it('preserves expected validation failures as stable 4xx responses', async () => {
    installTestRunApi({
      ...failingEnvironment(),
      authenticate: () =>
        Promise.resolve({
          principalId: 'principal-1',
          ownerPrincipalId: 'principal-1',
          userId: 'user-1',
          workspaceId: 'workspace-1',
          role: 'owner',
          scope: null,
        }),
    });
    const request = new Request('http://web/api/agents/not-a-uuid/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });

    const response = await startRunRoute(request as never, {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'invalid_agent_id',
        message: 'the agent id in the path is not a UUID.',
      },
    });
  });
});
