import { describe, expect, it, vi } from 'vitest';

import type { DatabaseRoot, WorkspaceScope } from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';

import { authenticateGatewayRequest } from './auth.js';
import { createDatabaseGatewayRunResolver } from './database.js';
import { createRunTokenCodec, type RunTokenSubject } from './tokens/run-token.js';
import { ModelCredentialUnavailableError, type TokenSource } from './types.js';

const SUBJECT: RunTokenSubject = {
  runId: '11111111-1111-4111-8111-111111111111',
  sessionId: '55555555-5555-4555-8555-555555555555',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  agentId: '33333333-3333-4333-8333-333333333333',
  modelConnectionId: '44444444-4444-4444-8444-444444444444',
};
const SECRET = 'fixture-signing-secret-that-is-longer-than-32-bytes';

function fixture(
  provider: 'vertex' | 'anthropic',
  tokens?: TokenSource,
  allowedProjectId = 'my-project-123',
) {
  const resolveByName = vi.fn(() => Promise.resolve({ value: Buffer.from('stored-api-key') }));
  const database = {
    scopes: { forWorkspaceId: () => Promise.resolve('scope' as unknown as WorkspaceScope) },
    runTokens: { forScope: () => ({ isActive: () => Promise.resolve(true) }) },
    runs: {
      forScope: () => ({
        get: () =>
          Promise.resolve({
            agentId: SUBJECT.agentId,
            status: 'running',
            costUsd: '0.000000',
            spendCeilingUsd: null,
          }),
      }),
    },
    agents: { forScope: () => ({ get: () => Promise.resolve({ id: SUBJECT.agentId }) }) },
    modelConnections: {
      forScope: () => ({
        get: () =>
          Promise.resolve({
            workspaceId: SUBJECT.workspaceId,
            provider,
            config: { projectId: 'my-project-123' },
          }),
      }),
    },
  } as unknown as DatabaseRoot;
  const secrets = { resolveByName } as unknown as SecretsService;
  return {
    resolveByName,
    resolver: createDatabaseGatewayRunResolver(
      database,
      secrets,
      tokens === undefined ? undefined : { tokens, projectId: allowedProjectId },
    ),
  };
}

async function authenticate(resolver: ReturnType<typeof fixture>['resolver']) {
  const codec = createRunTokenCodec({ secret: SECRET, now: () => 1000 });
  const token = await codec.issue(SUBJECT);
  return authenticateGatewayRequest(
    new Request('http://gateway.local/v1/messages', {
      headers: { authorization: `Bearer ${token}` },
    }),
    codec,
    resolver,
  );
}

function tokenSource(): TokenSource & { readonly invalidate: () => void; invalidations: number } {
  let minted = 0;
  return {
    invalidations: 0,
    accessToken: () => {
      minted += 1;
      return Promise.resolve(`ya29.token-${String(minted)}`);
    },
    invalidate() {
      this.invalidations += 1;
    },
  };
}

describe('the keyless branch of the database resolver', () => {
  it('uses the token source and never reads the secret store', async () => {
    const { resolver, resolveByName } = fixture('vertex', tokenSource());
    const result = await authenticate(resolver);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.credential).toBe('ya29.token-1');
    expect(result.context.providerId).toBe('vertex');
    expect(result.context.settings).toEqual({ projectId: 'my-project-123' });
    expect(resolveByName).not.toHaveBeenCalled();
  });

  it('hands the adapter a refresh that invalidates and fetches again', async () => {
    const tokens = tokenSource();
    const { resolver } = fixture('vertex', tokens);
    const result = await authenticate(resolver);
    if (!result.ok) throw new Error('expected an authenticated context');
    expect(await result.context.refreshCredential?.()).toBe('ya29.token-2');
    expect(tokens.invalidations).toBe(1);
  });

  it('answers a typed 503 when the deployment has no token source', async () => {
    const { resolver, resolveByName } = fixture('vertex');
    const result = await authenticate(resolver);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.response.status).toBe(503);
    const body = (await result.response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('model_credential_unavailable');
    expect(body.error.code.startsWith('token_')).toBe(false);
    expect(resolveByName).not.toHaveBeenCalled();
  });

  it('answers the same 503 when the cloud identity yields no token', async () => {
    const { resolver } = fixture('vertex', {
      accessToken: () => Promise.reject(new ModelCredentialUnavailableError()),
      invalidate: () => undefined,
    });
    const result = await authenticate(resolver);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.response.status).toBe(503);
  });

  it('refuses a connection naming a project other than the deployment own', async () => {
    const tokens = tokenSource();
    const accessToken = vi.spyOn(tokens, 'accessToken');
    const { resolver } = fixture('vertex', tokens, 'install-project-1');
    const result = await authenticate(resolver);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.response.status).toBe(503);
    const body = (await result.response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('model_credential_unavailable');
    expect(accessToken).not.toHaveBeenCalled();
  });

  it('leaves an api-key connection on the secret store with no refresh', async () => {
    const tokens = tokenSource();
    const { resolver, resolveByName } = fixture('anthropic', tokens);
    const result = await authenticate(resolver);
    if (!result.ok) throw new Error('expected an authenticated context');
    expect(result.context.credential).toBe('stored-api-key');
    expect(result.context.refreshCredential).toBeUndefined();
    expect(resolveByName).toHaveBeenCalledTimes(1);
  });
});
