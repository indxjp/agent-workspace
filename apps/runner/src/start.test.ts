import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import { startRunner } from './start.js';

describe('startRunner', () => {
  it('accepts mirror configuration before a per-run token exists', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    if (address === null || typeof address === 'string') throw new Error('no probe address');
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const runner = await startRunner({
      HOST: '127.0.0.1',
      PORT: String(port),
      AW_SESSION_MIRROR_URL: 'http://127.0.0.1:3000',
    });

    try {
      expect(runner.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await runner.close();
    }
  });
});
