import { describe, expect, it, vi } from 'vitest';

import { createGatewayApplication, PACKAGE_NAME, startGateway } from './index.js';
import { createRunTokenCodec } from './tokens/run-token.js';

const TOKEN_SECRET = 'wave-4-integration-token-secret-0001';

describe('@agent-workspace/gateway', () => {
  it('is wired into the pnpm workspace', () => {
    expect(PACKAGE_NAME).toBe('@agent-workspace/gateway');
  });

  it('keeps health public but requires a signed run token for model routes', async () => {
    const gateway = createGatewayApplication({
      tokenSecret: TOKEN_SECRET,
      resolver: { resolve: () => Promise.resolve({ state: 'missing' }) },
    });
    expect(await (await gateway.fetch(new Request('http://gateway/health'))).json()).toEqual({
      status: 'ok',
    });
    expect((await gateway.fetch(new Request('http://gateway/v1/models'))).status).toBe(401);
  });

  it('feeds the registry to the router and selects endpoint settings from the signed run', async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { message: 'fixture refusal', type: 'invalid_request_error', code: 'fixture' } },
          { status: 400 },
        ),
      );
    const gateway = createGatewayApplication({
      tokenSecret: TOKEN_SECRET,
      providers: { fetch: upstream },
      resolver: {
        resolve: () =>
          Promise.resolve({
            state: 'active',
            providerId: 'openai',
            connectionProvider: 'openai',
            credential: 'provider-secret',
            settings: { baseUrl: 'http://localhost:9400/v1' },
          }),
      },
    });
    const codec = createRunTokenCodec({ secret: TOKEN_SECRET });
    const token = await codec.issue({
      runId: 'run-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      modelConnectionId: 'connection-1',
    });
    const response = await gateway.fetch(
      new Request('http://gateway/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-fixture', max_tokens: 32, messages: [] }),
      }),
    );

    expect(response.status).toBe(400);
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0]?.[0]).toBe('http://localhost:9400/v1/responses');
    const init = upstream.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer provider-secret');
  });

  it.each(['4000garbage', '12.5', ' 4000', '4000 '])(
    'rejects PORT when the complete value is not an integer: %s',
    async (port) => {
      await expect(
        startGateway({ GATEWAY_TOKEN_SECRET: TOKEN_SECRET, PORT: port }),
      ).rejects.toThrow('PORT must be an integer from 1 through 65535.');
    },
  );

  it('refuses to start with an unknown GATEWAY_TOOL_SANDBOX_AUTH', async () => {
    await expect(
      startGateway({ GATEWAY_TOKEN_SECRET: TOKEN_SECRET, GATEWAY_TOOL_SANDBOX_AUTH: 'iap' }),
    ).rejects.toThrow("GATEWAY_TOOL_SANDBOX_AUTH must be unset or 'google-id-token'.");
  });

  it('refuses a missing price catalogue before the database opens', async () => {
    // No DATABASE_URL either: a gateway that opened the database first would fail on that instead.
    await expect(startGateway({ GATEWAY_TOKEN_SECRET: TOKEN_SECRET })).rejects.toThrow(
      'GATEWAY_PRICING_JSON is required for authoritative usage settlement.',
    );
  });

  it('reads the scripted models at start-up, before the database, and refuses a relative folder', async () => {
    await expect(
      startGateway({ GATEWAY_TOKEN_SECRET: TOKEN_SECRET, AW_SCRIPTED_MODELS_DIR: 'scripts' }),
    ).rejects.toThrow('AW_SCRIPTED_MODELS_DIR must be an absolute path.');
  });
});
