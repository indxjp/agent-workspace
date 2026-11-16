import {
  createAuthenticatedGateway,
  type GatewayRunResolver,
  type GatewayUsageRecord,
  type UsageRecorder,
} from './auth.js';
import { createRunTokenCodec, type RunTokenSubject } from './tokens/run-token.js';
import type { GatewayRouter } from './types.js';

export const SUBJECT: RunTokenSubject = {
  runId: '11111111-1111-4111-8111-111111111111',
  sessionId: '55555555-5555-4555-8555-555555555555',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  agentId: '33333333-3333-4333-8333-333333333333',
  modelConnectionId: '44444444-4444-4444-8444-444444444444',
};
export const SECRET = 'fixture-signing-secret-that-is-longer-than-32-bytes';

export function errorCode(response: Response): Promise<string> {
  return response.json().then((value: unknown) => {
    if (typeof value !== 'object' || value === null || !('error' in value))
      throw new Error('expected gateway error');
    const error = value.error;
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      typeof error.code !== 'string'
    )
      throw new Error('expected gateway error code');
    return error.code;
  });
}

/** A stub router under full test control, bypassing the real provider adapters. */
export function routerReturning(response: Response): GatewayRouter {
  return { routes: [], fetch: () => Promise.resolve(response) };
}

export async function issuedGateway(
  recorder: UsageRecorder,
  response: Response,
  settlementTimeoutMs?: number,
): Promise<{ gateway: Pick<GatewayRouter, 'fetch'>; token: string }> {
  const tokens = createRunTokenCodec({ secret: SECRET, now: () => 1000 });
  const token = await tokens.issue(SUBJECT);
  const gateway = createAuthenticatedGateway(
    routerReturning(response),
    tokens,
    {
      resolve: () =>
        Promise.resolve({
          state: 'active',
          providerId: 'anthropic',
          connectionProvider: 'anthropic',
          credential: 'k',
        }),
    },
    recorder,
    () => undefined,
    settlementTimeoutMs,
  );
  return { gateway, token };
}

export function activeResolver(): GatewayRunResolver {
  return {
    resolve: () =>
      Promise.resolve({
        state: 'active',
        providerId: 'anthropic',
        connectionProvider: 'anthropic',
        credential: 'provider-master-key',
      }),
  };
}

export function usageRecorder(recorded: GatewayUsageRecord[]): UsageRecorder {
  return {
    record(usage) {
      recorded.push(usage);
      return Promise.resolve();
    },
    fail: () => Promise.resolve(),
  };
}
