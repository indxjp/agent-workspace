import { expect, it } from 'vitest';
import { probes, protectedGetProbes, protectedPostProbes } from './auth-server-fixtures.js';

export function registerSurfaceProbes(server: {
  readonly base: string;
  readonly token: string;
}): void {
  it('probes every /api route that exists, plus the §34 inventory and unrouted paths', () => {
    // The inventory is derived, and the count is derived from the inventory.
    expect(probes.length).toBe(new Set(probes).size);
    expect(probes.length).toBeGreaterThan(0);
  });

  it.each(protectedGetProbes)('GET %s → 401', async (pathname) => {
    const response = await fetch(`${server.base}${pathname}`, { redirect: 'manual' });
    expect(response.status, pathname).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('forwards the A2A agent card to its handler instead of answering the session 401', async () => {
    const response = await fetch(
      `${server.base}/api/a2a/agents/probe-agentName/.well-known/agent-card.json`,
      { redirect: 'manual' },
    );
    expect(response.status).not.toBe(401);
    expect(await response.json()).not.toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('allows only the read-only runtime detector needed before an administrator exists', async () => {
    const response = await fetch(`${server.base}/api/setup/runtime-detect`, { redirect: 'manual' });
    expect(response.status, await response.clone().text()).toBe(200);
    const body: unknown = await response.json();
    expect(body).toBeTypeOf('object');
    expect(body).not.toBeNull();
    expect(
      Array.isArray(
        (
          body as {
            drivers?: unknown;
          }
        ).drivers,
      ),
    ).toBe(true);
  }, 15000);

  it.each(protectedPostProbes)('POST %s → 401', async (pathname) => {
    const response = await fetch(`${server.base}${pathname}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', origin: server.base },
      body: '{}',
    });
    expect(response.status, pathname).toBe(401);
  });

  it('allows setup submission before an administrator exists', async () => {
    const response = await fetch(`${server.base}/api/setup`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', origin: server.base },
      body: '{}',
    });
    expect(response.status).not.toBe(401);
  });
}
