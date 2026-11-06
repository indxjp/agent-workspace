import { expect, it } from 'vitest';

import { publicRunFailure } from '../runs/failures';

import { PreparationStepError } from '../runs/failures';
import { buildRunRequestFor } from './run-request';
import type { createPolicyCeilingFixture } from './run-request.policy-ceiling.fixture.test-support';
import {
  ALL_OFF,
  MODEL_CONNECTION,
  rowRunAgent,
  SETTINGS,
} from './run-request.fixture.test-support';
export function registerPreflightCases({
  savedAgent,
  recordingGateway,
  compose,
  refusalOf,
}: ReturnType<typeof createPolicyCeilingFixture>) {
  it('refuses a stored engine outside policy.engines before the loader or the gateway runs', async () => {
    const gateway = recordingGateway();
    let loads = 0;
    const refusal = await refusalOf(
      compose(
        {
          engine: 'openai-agents',
          skills: { mode: 'all' },
          limits: { maxTurns: null, maxBudgetUsd: null },
        },
        { engines: ['claude-agent-sdk'] },
        {
          gateway,
          loader: {
            load: () => {
              loads += 1;
              return Promise.resolve({ files: [], skills: [], mcpServers: {} });
            },
          },
        },
      ),
    );
    expect(refusal.code).toBe('policy_cannot_widen');
    expect(refusal.publicMessage).toMatch(/^policy_cannot_widen: /u);
    expect(refusal.publicMessage).toContain('engine:openai-agents');
    expect(gateway.issues).toEqual([]);
    expect(loads).toBe(0);
  });
  it('tags a resource load that throws, and a token issue that throws, with their steps (issue #827)', async () => {
    const stepOf = async (promise: Promise<unknown>): Promise<unknown> => {
      const error: unknown = await promise.then(
        () => null,
        (reason: unknown) => reason,
      );
      return error instanceof PreparationStepError ? error.step : error;
    };

    await expect(
      stepOf(
        compose(null, null, {
          loader: { load: () => Promise.reject(new Error('object store unavailable')) },
        }),
      ),
    ).resolves.toBe('resources');
    await expect(
      stepOf(
        compose(null, null, {
          gateway: {
            baseUrl: 'http://gateway:4000',
            issue: () => Promise.reject(new Error('token table unavailable')),
          },
        }),
      ),
    ).resolves.toBe('token');
  });
  it("refuses a resolved model outside policy.models, and the run's failure carries its code", async () => {
    const gateway = recordingGateway();
    const refusal = await refusalOf(
      compose(
        null,
        { models: ['claude-y'] },
        { gateway, model: { connectionId: MODEL_CONNECTION, model: 'claude-x' } },
      ),
    );
    expect(refusal.code).toBe('policy_cannot_widen');
    expect(refusal.publicMessage).toContain('model:claude-x');
    expect(gateway.issues).toEqual([]);
    expect(
      publicRunFailure(refusal, {
        operation: 'prepare-request',
        publicMessage: 'The run request could not be prepared.',
        log: () => undefined,
      }),
    ).toBe(refusal.publicMessage);
  });
  it('refuses a subagent model outside policy.models', async () => {
    const { context, agents } = await savedAgent(null);
    const row = await rowRunAgent(agents, context);
    const gateway = recordingGateway();
    const refusal = await refusalOf(
      buildRunRequestFor(
        context,
        {
          ...row,
          subagents: [
            {
              name: 'billing',
              description: 'Answers billing questions.',
              instructions: '',
              model: 'claude-x',
              permissions: ALL_OFF,
              policy: null,
            },
          ],
        },
        SETTINGS,
        gateway,
        {},
        undefined,
        null,
        undefined,
        { connectionId: MODEL_CONNECTION, model: 'claude-y' },
        null,
        undefined,
        undefined,
        { models: ['claude-y'] },
      ),
    );
    expect(refusal.code).toBe('policy_cannot_widen');
    expect(refusal.publicMessage).toContain('model:claude-x');
    expect(gateway.issues).toEqual([]);
  });
}
