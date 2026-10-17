import { describe, expect, it } from 'vitest';

import { createRunnerServer } from './server.js';

async function withBearer<T>(
  bearer: string | undefined,
  use: (base: string) => Promise<T>,
): Promise<T> {
  const server = createRunnerServer({ ...(bearer === undefined ? {} : { bearer }) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  try {
    return await use(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('runner server bearer (ADR-0120 LC3)', () => {
  it('refuses every path without the bearer, and never echoes it', async () => {
    await withBearer('s3cret-bearer-value', async (base) => {
      for (const [method, route] of [
        ['GET', '/healthz'],
        ['POST', '/run'],
        ['DELETE', '/files'],
      ] as const) {
        expect((await fetch(`${base}${route}`, { method })).status).toBe(401);
        const wrong = await fetch(`${base}${route}`, {
          method,
          headers: { authorization: 'Bearer s3cret-bearer-valuX' },
        });
        expect(wrong.status).toBe(401);
        expect(await wrong.text()).not.toContain('s3cret');
      }
    });
  });

  it('serves a request that carries it, and an unset bearer leaves the server open', async () => {
    await withBearer('s3cret-bearer-value', async (base) => {
      const ok = await fetch(`${base}/healthz`, {
        headers: { authorization: 'Bearer s3cret-bearer-value' },
      });
      expect(ok.status).toBe(200);
    });
    await withBearer(undefined, async (base) => {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
    });
  });
});
