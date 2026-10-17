import { describe, expect, it } from 'vitest';

import { createRunTokenCodec } from '@agent-workspace/gateway/tokens';

import {
  createRunTokenIssuer,
  createUnavailableRunTokenIssuer,
  readGatewayIssuerSettings,
} from './issuer';

const SECRET = 'shared-fixture-secret-that-is-at-least-thirty-two-bytes';

describe('gateway token issuer', () => {
  it('fails closed when shared gateway configuration is absent or weak', () => {
    expect(readGatewayIssuerSettings({}).ok).toBe(false);
    expect(
      readGatewayIssuerSettings({
        MODEL_GATEWAY_URL: 'http://gateway:4000',
        GATEWAY_TOKEN_SECRET: 'short',
      }).ok,
    ).toBe(false);
  });

  it('mints a token the gateway verifies and never embeds a credential', async () => {
    const settings = readGatewayIssuerSettings({
      MODEL_GATEWAY_URL: 'http://gateway:4000/',
      GATEWAY_TOKEN_SECRET: SECRET,
      GATEWAY_TOKEN_TTL_SECONDS: '120',
    });
    expect(settings.ok).toBe(true);
    if (!settings.ok) throw new Error(settings.reason);
    const issuer = createRunTokenIssuer(settings.settings);
    const subject = {
      runId: '11111111-1111-4111-8111-111111111111',
      sessionId: '55555555-5555-4555-8555-555555555555',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      agentId: '33333333-3333-4333-8333-333333333333',
      modelConnectionId: '44444444-4444-4444-8444-444444444444',
    };
    const token = await issuer.issue(subject);

    expect(issuer.baseUrl).toBe('http://gateway:4000');
    await expect(createRunTokenCodec({ secret: SECRET }).verify(token)).resolves.toMatchObject({
      ok: true,
      claims: subject,
    });
    expect(token).not.toContain('apiKey');
  });

  it('registers the token id and a digest before returning the bearer', async () => {
    const settings = readGatewayIssuerSettings({
      MODEL_GATEWAY_URL: 'http://gateway:4000',
      GATEWAY_TOKEN_SECRET: SECRET,
    });
    if (!settings.ok) throw new Error(settings.reason);
    const registrations: Parameters<NonNullable<Parameters<typeof createRunTokenIssuer>[1]>>[0][] =
      [];
    const issuer = createRunTokenIssuer(settings.settings, (registration) => {
      registrations.push(registration);
      return Promise.resolve();
    });
    const token = await issuer.issue({
      runId: '11111111-1111-4111-8111-111111111111',
      sessionId: '55555555-5555-4555-8555-555555555555',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      agentId: '33333333-3333-4333-8333-333333333333',
      modelConnectionId: '44444444-4444-4444-8444-444444444444',
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.claims.tokenId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(registrations[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(registrations)).not.toContain(token);
  });

  it('keeps an unconfigured deployment fail-closed before the runner is called', async () => {
    const issuer = createUnavailableRunTokenIssuer('GATEWAY_TOKEN_SECRET is not set.');
    await expect(
      issuer.issue({
        runId: '11111111-1111-4111-8111-111111111111',
        sessionId: '55555555-5555-4555-8555-555555555555',
        workspaceId: '22222222-2222-4222-8222-222222222222',
        agentId: '33333333-3333-4333-8333-333333333333',
        modelConnectionId: '44444444-4444-4444-8444-444444444444',
      }),
    ).rejects.toThrow('The model gateway is not configured: GATEWAY_TOKEN_SECRET is not set.');
  });
});
