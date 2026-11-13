import { expect, it, vi } from 'vitest';
import { createRunnerManagerServer } from './manager.js';
import {
  TOKEN,
  fixtureDriver,
  allocationBody,
  authenticated,
} from './manager.fixture.test-support.js';

it('runner manager Docker lifecycle > verifies create, readiness, echo, and guaranteed teardown', async () => {
  const fixture = fixtureDriver();
  const proxy = vi.fn<typeof fetch>((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/healthz')) return Promise.resolve(Response.json({ status: 'ok' }));
    if (typeof init?.body !== 'string') throw new Error('expected JSON echo body');
    const request = JSON.parse(init.body) as { nonce: string };
    return Promise.resolve(Response.json({ nonce: request.nonce }));
  });
  const server = createRunnerManagerServer({
    token: TOKEN,
    driver: fixture.driver,
    workspacesRoot: '/srv/runtimes',
    runtimeOrigin: (handle) => `http://${handle.externalId}:8080`,
    fetch: proxy,
    verificationTimeoutMs: 1_000,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  try {
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/verify`, {
      method: 'POST',
      headers: authenticated,
      body: JSON.stringify(allocationBody),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { fingerprint?: unknown };
    expect(typeof result.fingerprint).toBe('string');
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(fixture.destroy).toHaveBeenCalledOnce();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
