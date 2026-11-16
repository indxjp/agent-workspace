import { describe, expect, it } from 'vitest';
import { killLaneSandboxes } from './e2b-sandboxes.mjs';
import './journey-test-fixtures.js';

describe('the lightweight journey lanes (issue #832)', () => {
  describe('killLaneSandboxes (issue #832)', () => {
    const SECRET = 'e2b_SENTINEL_lane_key_0123456789';
    function e2b(alive: string[], toolIds: readonly string[] = []) {
      const calls: { method: string; url: string; key: string | null }[] = [];
      const request = ((input: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        const headers = new Headers(init.headers);
        calls.push({ method, url: input, key: headers.get('x-api-key') });
        if (method === 'DELETE') {
          const id = decodeURIComponent(input.split('/sandboxes/')[1] ?? '');
          const at = alive.indexOf(id);
          if (at < 0) return Promise.resolve(new Response('{}', { status: 404 }));
          alive.splice(at, 1);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(
          Response.json(
            alive.map((sandboxID) => ({
              sandboxID,
              metadata: toolIds.includes(sandboxID) ? { awTools: 'tools-1' } : { awSession: 's' },
            })),
          ),
        );
      }) as typeof fetch;
      return { calls, request };
    }

    it("lists by the lane's workspace tag, kills each, and prints the count before and after", async () => {
      const f = e2b(['sbx-1', 'sbx-2', 'sbx-3'], ['sbx-3']);
      const log: string[] = [];
      const result = await killLaneSandboxes({
        apiKey: SECRET,
        workspaceId: 'ws-lane',
        request: f.request,
        log: (line) => log.push(line),
        pollMs: 0,
      });
      expect(result).toEqual({ before: 3, after: 0 });
      const listing = new URL(f.calls[0]?.url ?? '');
      expect(listing.searchParams.get('metadata')).toBe('awWorkspace=ws-lane');
      expect(listing.searchParams.get('state')).toBe('running');
      expect(f.calls.filter((call) => call.method === 'DELETE').map((call) => call.url)).toEqual([
        'https://api.e2b.dev/sandboxes/sbx-1',
        'https://api.e2b.dev/sandboxes/sbx-2',
        'https://api.e2b.dev/sandboxes/sbx-3',
      ]);
      expect(f.calls.every((call) => call.key === SECRET)).toBe(true);
      expect(log).toEqual([
        expect.stringContaining('before the sweep: 3 (runtime=2 tool=1)'),
        expect.stringContaining('after the sweep: 0'),
      ]);
      expect(log.join('\n')).not.toContain(SECRET);
    });

    it('kills nothing and reports 0 when the lane has no sandbox alive', async () => {
      const f = e2b([]);
      expect(
        await killLaneSandboxes({ apiKey: SECRET, workspaceId: 'ws-lane', request: f.request }),
      ).toEqual({ before: 0, after: 0 });
      expect(f.calls.map((call) => call.method)).toEqual(['GET']);
    });

    it('reports what is still alive, not 0, when the provider keeps listing a sandbox', async () => {
      const request = ((_input: string, init: RequestInit = {}) =>
        Promise.resolve(
          init.method === 'DELETE'
            ? new Response(null, { status: 204 })
            : Response.json([{ sandboxID: 'stuck' }]),
        )) as typeof fetch;
      expect(
        await killLaneSandboxes({
          apiKey: SECRET,
          workspaceId: 'ws-lane',
          request,
          polls: 2,
          pollMs: 0,
        }),
      ).toEqual({ before: 1, after: 1 });
    });

    it('fails when a kill is refused, without printing the key', async () => {
      const request = ((_input: string, init: RequestInit = {}) =>
        Promise.resolve(
          init.method === 'DELETE'
            ? new Response(SECRET, { status: 403 })
            : Response.json([{ sandboxID: 'sbx-1' }]),
        )) as typeof fetch;
      const error: unknown = await killLaneSandboxes({
        apiKey: SECRET,
        workspaceId: 'ws-lane',
        request,
      }).catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('E2B refused to kill sbx-1 (403)');
    });
  });
});
