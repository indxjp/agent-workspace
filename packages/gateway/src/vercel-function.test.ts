import { describe, expect, it, vi } from 'vitest';

import { createGatewayApplication, createGatewayFromEnvironment } from './index.js';
import { createGatewayFunction } from './vercel-function.js';

const TOKEN_SECRET = 'wave-4-integration-token-secret-0001';

function application() {
  return createGatewayApplication({
    tokenSecret: TOKEN_SECRET,
    resolver: { resolve: () => Promise.resolve({ state: 'missing' }) },
  });
}

describe('the gateway as a Vercel Function', () => {
  it('answers health and keeps model routes behind the run token', async () => {
    const create = vi.fn(() => Promise.resolve({ application: application(), close: vi.fn() }));
    const gateway = createGatewayFunction({}, create);

    const health = await gateway.fetch(new Request('https://gateway.example/health'));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    expect((await gateway.fetch(new Request('https://gateway.example/v1/models'))).status).toBe(
      401,
    );
  });

  it('opens the stores once for the invocations an instance serves', async () => {
    const create = vi.fn(() => Promise.resolve({ application: application(), close: vi.fn() }));
    const gateway = createGatewayFunction({}, create);

    await gateway.fetch(new Request('https://gateway.example/health'));
    await gateway.fetch(new Request('https://gateway.example/health'));

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('answers 500 without the cause and tries again on the next request after a failed start', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const create = vi
        .fn()
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED postgres://u:secret@db/aw'))
        .mockResolvedValue({ application: application(), close: vi.fn() });
      const gateway = createGatewayFunction({}, create);

      const failed = await gateway.fetch(new Request('https://gateway.example/health'));
      const recovered = await gateway.fetch(new Request('https://gateway.example/health'));

      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toContain('secret');
      expect(recovered.status).toBe(200);
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('createGatewayFromEnvironment', () => {
  it.each([{}, { GATEWAY_TOKEN_SECRET: 'too-short' }])(
    'refuses a missing or short GATEWAY_TOKEN_SECRET by name: %j',
    async (env) => {
      await expect(createGatewayFromEnvironment(env)).rejects.toThrow(
        'GATEWAY_TOKEN_SECRET must contain at least 32 characters.',
      );
    },
  );
});
