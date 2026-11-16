/**
 * The store's visitor pages read the platform as the signed-in visitor (spec "The store app"): the
 * browser's own demo session, the allowance first, the guest role's own runs. The platform is a fake
 * keyed by the visitor's cookie, so a second visitor can be shown to reach only their own runs.
 */
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import { fixtures } from '@indx-workspace/sdk/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readAsVisitor } from '../../examples/store/app/visitor.ts';

const PLATFORM = 'https://aw.example';
const NOW = new Date('2026-11-16T12:00:00Z');
const FUTURE = '2026-11-17T12:00:00.000Z';
const PAST = '2026-11-16T11:00:00.000Z';

interface Demo {
  readonly expiresAt: string;
  readonly runs: readonly string[];
  /** The status the runs list answers with instead of the runs, when it refuses. */
  readonly runsRefusal?: number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (code: string) => ({ error: { code, message: 'x' } });

/**
 * The platform as a browser meets it: one cookie jar, and a visitor per cookie, each with their own
 * demo workspace. The cookie reaches the platform only on a request made with credentials included.
 */
function stubPlatform(demos: Readonly<Record<string, Demo>>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const jar = { cookie: '' };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: URL | string | Request, init: RequestInit = {}) => {
      const url = input instanceof Request ? input.url : String(input);
      const credentials = input instanceof Request ? input.credentials : init.credentials;
      calls.push({ url, init: credentials === undefined ? init : { ...init, credentials } });
      const demo = credentials === 'include' ? demos[jar.cookie] : undefined;
      if (demo === undefined) return Promise.resolve(json(401, problem('unauthorized')));
      if (url.endsWith('/api/demo/allowance')) {
        return Promise.resolve(
          json(200, { runsPerDay: 20, runsLeft: 18, expiresAt: demo.expiresAt }),
        );
      }
      if (url.includes('/api/runs')) {
        if (demo.runsRefusal !== undefined) {
          return Promise.resolve(json(demo.runsRefusal, problem('refused')));
        }
        return Promise.resolve(json(200, { runs: demo.runs.map(run), nextCursor: null }));
      }
      return Promise.resolve(json(404, problem('not_found')));
    }),
  );
  return { calls, jar };
}

const run = (id: string) => fixtures.run({ id, status: 'completed' });
const runIds = (client: AgentWorkspaceClient) =>
  client.runs.list({ limit: 50 }).then((page) => page.runs.map((each) => each.id));

afterEach(() => vi.unstubAllGlobals());

describe('the visitor pages read as the visitor', () => {
  it("shows a visitor their own demo workspace's runs, and a second visitor only their own", async () => {
    const { jar } = stubPlatform({
      first: { expiresAt: FUTURE, runs: ['run-of-first'] },
      second: { expiresAt: FUTURE, runs: ['run-of-second'] },
    });
    jar.cookie = 'first';
    expect(await readAsVisitor(PLATFORM, runIds, NOW)).toEqual({
      kind: 'ok',
      value: ['run-of-first'],
    });
    jar.cookie = 'second';
    expect(await readAsVisitor(PLATFORM, runIds, NOW)).toEqual({
      kind: 'ok',
      value: ['run-of-second'],
    });
  });

  it('goes with the browser session only: credentials included, no Authorization, no app key', async () => {
    const { calls, jar } = stubPlatform({ me: { expiresAt: FUTURE, runs: [] } });
    jar.cookie = 'me';
    expect(await readAsVisitor(PLATFORM, runIds, NOW)).toEqual({ kind: 'ok', value: [] });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const { init } of calls) {
      expect(init.credentials).toBe('include');
      const headers = new Headers(init.headers);
      expect(headers.has('authorization')).toBe(false);
      expect([...headers.keys()].filter((name) => name.includes('key'))).toEqual([]);
    }
  });

  it('is signed-out for no session, and for a session with no demo workspace', async () => {
    stubPlatform({});
    const read = vi.fn();
    expect(await readAsVisitor(PLATFORM, read, NOW)).toEqual({ kind: 'signed-out' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(404, problem('demo_workspace_not_found')))),
    );
    expect(await readAsVisitor(PLATFORM, read, NOW)).toEqual({ kind: 'signed-out' });
    expect(read).not.toHaveBeenCalled();
  });

  it('is ended once the expiry has passed, and never reads', async () => {
    const { jar } = stubPlatform({ me: { expiresAt: PAST, runs: ['r'] } });
    jar.cookie = 'me';
    const read = vi.fn();
    expect(await readAsVisitor(PLATFORM, read, NOW)).toEqual({ kind: 'ended' });
    expect(read).not.toHaveBeenCalled();
  });

  it('is failed when the platform cannot be reached or answers an unexpected refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network'))),
    );
    expect(await readAsVisitor(PLATFORM, vi.fn(), NOW)).toEqual({ kind: 'failed' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(500, problem('internal_error')))),
    );
    expect(await readAsVisitor(PLATFORM, vi.fn(), NOW)).toEqual({ kind: 'failed' });
  });

  it('is signed-out when the read is refused 401 or 403, failed for any other refusal', async () => {
    const { jar } = stubPlatform({
      expired: { expiresAt: FUTURE, runs: [], runsRefusal: 401 },
      refused: { expiresAt: FUTURE, runs: [], runsRefusal: 403 },
      broken: { expiresAt: FUTURE, runs: [], runsRefusal: 500 },
    });
    jar.cookie = 'expired';
    expect(await readAsVisitor(PLATFORM, runIds, NOW)).toEqual({ kind: 'signed-out' });
    jar.cookie = 'refused';
    expect(await readAsVisitor(PLATFORM, runIds, NOW)).toEqual({ kind: 'signed-out' });
    jar.cookie = 'broken';
    expect(await readAsVisitor(PLATFORM, runIds, NOW)).toEqual({ kind: 'failed' });
  });
});
