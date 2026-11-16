import { describe, expect, it } from 'vitest';
import { isLeftover, LANES, LEFTOVER_AGE_MS, resourceNames } from './lanes.mjs';
import { teardown } from './teardown.mjs';
import { vercelLane, cloudflareLane } from './journey-test-fixtures.js';

describe('the lightweight journey teardown (issue #832)', () => {
  const env = Object.fromEntries(
    LANES.flatMap((lane) => lane.credentials).map((name) => [name, `${name}-value`]),
  );

  describe('the leftover sweep', () => {
    const now = Date.now();
    const old = new Date(now - LEFTOVER_AGE_MS - 60_000).toISOString();
    const young = new Date(now - LEFTOVER_AGE_MS + 60_000).toISOString();
    const other = '0123abcd';
    const mine = (lane: (typeof LANES)[number]) => resourceNames(lane, '42').project;
    const leftoverName = (lane: (typeof LANES)[number]) => `awlj-${other}-${lane.key}`;

    it('keeps young, undated, other-prefixed, other-lane and this run’s names; deletes old ones', () => {
      const leftover = isLeftover(cloudflareLane, '42', now);
      const name = leftoverName(cloudflareLane);
      expect(leftover(name, { created_on: old })).toBe(true);
      expect(leftover(`${name}-control-plane`, { modified_on: old })).toBe(true);
      expect(leftover(name, { createdAt: now - LEFTOVER_AGE_MS - 60_000 })).toBe(true);
      expect(leftover(name, { created_on: young })).toBe(false);
      expect(leftover(name, { created_on: old, modified_on: young })).toBe(false);
      expect(leftover(name, {})).toBe(false);
      expect(leftover(name, { created_on: 'not a date' })).toBe(false);
      expect(leftover(name, undefined)).toBe(false);
      expect(leftover(mine(cloudflareLane), { created_on: old })).toBe(false);
      expect(leftover(`${mine(cloudflareLane)}-manager`, { created_on: old })).toBe(false);
      expect(leftover(leftoverName(vercelLane), { created_on: old })).toBe(false);
      for (const production of [
        'main',
        'awlj',
        'awlj-',
        `awlj-${other}`,
        `awlj-${other}-${cloudflareLane.key}-extra`,
        `my-awlj-${other}-${cloudflareLane.key}`,
        `AWLJ-${other}-${cloudflareLane.key}`,
        'agent-workspace-sandbox-bridge-ci-1-1',
      ]) {
        expect(leftover(production, { created_on: old })).toBe(false);
      }
      expect(leftover(undefined, { created_on: old })).toBe(false);
    });

    const sweepFrom = async (
      lane: (typeof LANES)[number],
      pages: Record<string, unknown>,
      refuse: (url: string) => boolean = () => false,
    ) => {
      const deleted: string[] = [];
      const request = ((url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          deleted.push(url);
          return Promise.resolve(new Response('{}', { status: refuse(url) ? 403 : 200 }));
        }
        const key = Object.keys(pages).find((candidate) => url.includes(candidate));
        return Promise.resolve(
          new Response(JSON.stringify(pages[key ?? ''] ?? {}), { status: 200 }),
        );
      }) as unknown as typeof fetch;
      const result = await teardown(lane, '42', env, request);
      return { ...result, deleted };
    };

    it('deletes old Neon branches over every page and nothing else', async () => {
      const name = leftoverName(vercelLane);
      const { deleted, leftovers, removed } = await sweepFrom(vercelLane, {
        'branches?limit=100&cursor=next-page': {
          branches: [{ id: 'br-old2', name, created_at: old }],
        },
        'branches?limit=100': {
          branches: [
            { id: 'br-old', name, created_at: old },
            { id: 'br-young', name: `awlj-1111aaaa-${vercelLane.key}`, created_at: young },
            { id: 'br-undated', name: `awlj-2222aaaa-${vercelLane.key}` },
            { id: 'br-main', name: 'main', created_at: old },
            { id: 'br-mine', name: mine(vercelLane), created_at: old },
          ],
          pagination: { next: 'next-page' },
        },
      });
      expect(leftovers).toEqual([]);
      const branches = deleted.filter((url) => url.includes('/branches/'));
      expect(branches.map((url) => url.split('/').pop()).sort()).toEqual([
        'br-mine',
        'br-old',
        'br-old2',
      ]);
      expect(removed).toContain(`neon branch ${name}`);
    });

    it('stops listing Neon branches at an empty page that still carries a cursor', async () => {
      const name = leftoverName(vercelLane);
      const { deleted, leftovers } = await sweepFrom(vercelLane, {
        'branches?limit=100&cursor=x': { branches: [], pagination: { next: 'x' } },
        'branches?limit=100': {
          branches: [{ id: 'br-old', name, created_at: old }],
          pagination: { next: 'x' },
        },
      });
      expect(leftovers).toEqual([]);
      expect(deleted.some((url) => url.endsWith('/branches/br-old'))).toBe(true);
    });

    it('never sweeps a default or protected Neon branch', async () => {
      const name = leftoverName(vercelLane);
      const { deleted, leftovers } = await sweepFrom(vercelLane, {
        'branches?limit=100': {
          branches: [
            { id: 'br-protected', name, created_at: old, protected: true },
            { id: 'br-default', name, created_at: old, default: true },
            { id: 'br-old', name, created_at: old },
          ],
        },
      });
      expect(leftovers).toEqual([]);
      const branches = deleted.filter((url) => url.includes('/branches/'));
      expect(branches.map((url) => url.split('/').pop())).toEqual(['br-old']);
    });

    it('deletes old Vercel projects and Cloudflare Workers by exact name', async () => {
      const vercelName = leftoverName(vercelLane);
      const vercel = await sweepFrom(vercelLane, {
        '/v9/projects?': {
          projects: [
            { name: `${vercelName}-web`, createdAt: now - LEFTOVER_AGE_MS - 60_000 },
            { name: 'production-site', createdAt: 1 },
            { name: `awlj-${other}-${cloudflareLane.key}`, createdAt: 1 },
            { name: `${vercelName}-gateway`, createdAt: now },
          ],
        },
      });
      expect(vercel.leftovers).toEqual([]);
      expect(vercel.deleted).toContainEqual(
        expect.stringContaining(`/v9/projects/${vercelName}-web?`),
      );
      expect(vercel.deleted.join(' ')).not.toContain('production-site');
      expect(vercel.deleted.join(' ')).not.toContain(`${vercelName}-gateway`);
      expect(
        vercel.deleted.filter((url) => url.includes('api.vercel.com')).join(' '),
      ).not.toContain(cloudflareLane.key);

      const workerName = leftoverName(cloudflareLane);
      const cloudflare = await sweepFrom(cloudflareLane, {
        'workers/scripts?page=2': { result: [{ id: `${workerName}-web`, created_on: old }] },
        '/workers/scripts': {
          result: [
            { id: workerName, created_on: old },
            { id: 'production-api', created_on: old },
            { id: `${workerName}-manager`, created_on: young },
          ],
          result_info: { page: 1, total_pages: 2 },
        },
      });
      expect(cloudflare.leftovers).toEqual([]);
      const workers = cloudflare.deleted
        .filter((url) => url.includes('/workers/scripts/'))
        .map((url) => url.split('/workers/scripts/')[1]?.split('?')[0]);
      expect(workers).toContain(workerName);
      expect(workers).toContain(`${workerName}-web`);
      expect(workers).not.toContain('production-api');
      expect(workers).not.toContain(`${workerName}-manager`);
    });

    it('reports a refused sweep deletion as a leftover, naming only the resource and status', async () => {
      const name = leftoverName(vercelLane);
      const { leftovers } = await sweepFrom(
        vercelLane,
        { 'branches?limit=100': { branches: [{ id: 'br-old', name, created_at: old }] } },
        (url) => url.endsWith('/branches/br-old'),
      );
      expect(leftovers).toEqual([`neon branch ${name}: HTTP 403`]);
    });
  });
});
