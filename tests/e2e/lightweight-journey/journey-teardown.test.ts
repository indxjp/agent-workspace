import { describe, expect, it } from 'vitest';

import { isLeftover, LANES, LEFTOVER_AGE_MS, resourceNames } from './lanes.mjs';
import { teardown } from './teardown.mjs';
import { vercelLane, cloudflareLane } from './journey-test-fixtures.js';

describe('the lightweight journey teardown (issue #832)', () => {
  const env = Object.fromEntries(
    LANES.flatMap((lane) => lane.credentials).map((name) => [name, `${name}-value`]),
  );

  it('counts a 404 as already gone and an refused deletion as a leftover', async () => {
    const seen: string[] = [];
    const request = ((url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      const status = url.includes('-gateway') ? 403 : 404;
      return Promise.resolve(new Response('{}', { status }));
    }) as unknown as typeof fetch;
    const { removed, leftovers } = await teardown(vercelLane, '42', env, request);
    expect(removed.some((label) => label.includes('vercel project'))).toBe(true);
    expect(leftovers.some((label) => label.includes('-gateway') && label.includes('403'))).toBe(
      true,
    );
    expect(seen.every((line) => !line.includes(env['VERCEL_TOKEN'] ?? 'x'))).toBe(true);
  });

  it('deletes only this run’s Neon branch and Cloudflare container applications', async () => {
    const names = resourceNames(cloudflareLane, '42');
    const deleted: string[] = [];
    const request = ((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleted.push(url);
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      const body = url.includes('/containers/applications')
        ? {
            result: [
              { id: 'mine', name: `${names.project}-manager` },
              { id: 'other', name: 'unrelated' },
            ],
          }
        : {
            branches: [
              { id: 'br-mine', name: names.neonBranch },
              { id: 'br-main', name: 'main' },
            ],
          };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as unknown as typeof fetch;
    const { leftovers } = await teardown(cloudflareLane, '42', env, request);
    expect(leftovers).toEqual([]);
    expect(deleted.some((url) => url.endsWith('/containers/applications/mine'))).toBe(true);
    expect(deleted.some((url) => url.endsWith('/containers/applications/other'))).toBe(false);
    expect(deleted.some((url) => url.endsWith('/branches/br-mine'))).toBe(true);
    expect(deleted.some((url) => url.endsWith('/branches/br-main'))).toBe(false);
  });

  it('deletes the run’s bridge container applications from its lane only, scoped to the run', async () => {
    const cloudflareE2bLane = LANES.find((lane) => lane.id === 'cloudflare-e2b');
    if (cloudflareE2bLane === undefined) throw new Error('the cloudflare-e2b lane is missing');
    const bridge = resourceNames(cloudflareLane, '42').bridgeWorker;
    const deletesFrom = async (lane: (typeof LANES)[number]) => {
      const deleted: string[] = [];
      const request = ((url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') deleted.push(url);
        const body = url.endsWith('/containers/applications')
          ? {
              result: [
                { id: 'none', name: `${bridge}-sandboxnone` },
                { id: 'open', name: `${bridge}-sandboxopen` },
                { id: 'later-run', name: `${bridge}1-sandboxnone` },
                { id: 'other', name: 'agent-workspace-sandbox-bridge-ci-7-sandboxnone' },
              ],
            }
          : {};
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }) as unknown as typeof fetch;
      const { leftovers } = await teardown(lane, '42', env, request);
      expect(leftovers).toEqual([]);
      return deleted.filter((url) => url.includes('/containers/applications/'));
    };
    expect(await deletesFrom(cloudflareE2bLane)).toEqual([]);
    const deleted = await deletesFrom(cloudflareLane);
    expect(deleted.map((url) => url.split('/').pop()).sort()).toEqual(['none', 'open']);
  });

  it('deletes the run’s bridge Worker only from the lane that deploys it', async () => {
    const cloudflareE2bLane = LANES.find((lane) => lane.id === 'cloudflare-e2b');
    if (cloudflareE2bLane === undefined) throw new Error('the cloudflare-e2b lane is missing');
    const bridge = resourceNames(cloudflareLane, '42').bridgeWorker;
    const deletesFrom = async (lane: (typeof LANES)[number]) => {
      const deleted: string[] = [];
      const request = ((url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') deleted.push(url);
        return Promise.resolve(new Response('{}', { status: 200 }));
      }) as unknown as typeof fetch;
      await teardown(lane, '42', env, request);
      return deleted;
    };
    expect((await deletesFrom(cloudflareE2bLane)).some((url) => url.includes(bridge))).toBe(false);
    expect((await deletesFrom(cloudflareLane)).some((url) => url.includes(bridge))).toBe(true);
  });

  it('deletes the run’s fake provider Worker and sweeps a leftover one', async () => {
    const { fakeProvider } = resourceNames(cloudflareLane, '42');
    expect(fakeProvider).toBe(`${resourceNames(cloudflareLane, '42').project}-provider`);
    const deleted: string[] = [];
    const request = ((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') deleted.push(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    await teardown(cloudflareLane, '42', env, request);
    expect(deleted.some((url) => url.includes(`/scripts/${fakeProvider}`))).toBe(true);
    const old = new Date(Date.now() - LEFTOVER_AGE_MS - 60_000).toISOString();
    expect(
      isLeftover(cloudflareLane, '42')(`awlj-0123abcd-${cloudflareLane.key}-provider`, {
        created_on: old,
      }),
    ).toBe(true);
    expect(isLeftover(cloudflareLane, '42')(fakeProvider, { created_on: old })).toBe(false);
  });

  it('deletes a Vercel lane’s fake provider Worker, and no other Cloudflare resource', async () => {
    const { fakeProvider } = resourceNames(vercelLane, '42');
    const requested: string[] = [];
    const deleted: string[] = [];
    const request = ((url: string, init?: RequestInit) => {
      requested.push(url);
      if (init?.method === 'DELETE') deleted.push(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    const { leftovers } = await teardown(vercelLane, '42', env, request);
    expect(leftovers).toEqual([]);
    expect(requested.some((url) => url.includes('/containers/applications'))).toBe(false);
    const cloudflare = deleted.filter((url) => url.includes('api.cloudflare.com'));
    expect(cloudflare).toHaveLength(1);
    expect(cloudflare[0]).toContain(`/workers/scripts/${fakeProvider}?`);
  });

  it('sweeps a Vercel lane’s leftover provider Worker', async () => {
    const old = new Date(Date.now() - LEFTOVER_AGE_MS - 60_000).toISOString();
    const stale = `awlj-0123abcd-${vercelLane.key}-provider`;
    const deleted: string[] = [];
    const request = ((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') deleted.push(url);
      const body = url.endsWith('/workers/scripts')
        ? { result: [{ id: stale, created_on: old }] }
        : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as unknown as typeof fetch;
    await teardown(vercelLane, '42', env, request);
    expect(deleted.some((url) => url.includes(`/workers/scripts/${stale}?`))).toBe(true);
  });

  it('removes nothing when its credentials are absent', async () => {
    const request = (() =>
      Promise.reject(new Error('no request expected'))) as unknown as typeof fetch;
    expect(await teardown(vercelLane, '42', {}, request)).toEqual({ removed: [], leftovers: [] });
  });
});
