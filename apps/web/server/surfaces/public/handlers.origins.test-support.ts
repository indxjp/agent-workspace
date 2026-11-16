import type { SurfaceRuntimeInstaller } from './handlers.fixture.test-support';
import { describe, expect, it } from 'vitest';
import { MIN_SESSION_SECRET_LENGTH } from '../../auth/session';
import { SURFACE_RATE_LIMITS } from './limits';
import { type ResolvedSurface } from './runtime';
import { RESOLVED, request, answer, codeOf } from './handlers.fixture.test-support';
export function registerSurfaceOriginsTests(install: SurfaceRuntimeInstaller) {
  describe('POST /p/s/<name>/sessions from an allowed origin (#622)', () => {
    const SHOP = 'https://shop.example.com';
    const LISTED: ResolvedSurface = {
      ...RESOLVED,
      surface: { ...RESOLVED.surface, allowedOrigins: [SHOP] },
    };
    const DEPLOYED = { host: 'aw.example.com', 'sec-fetch-site': 'cross-site' } as const;
    const deployed = (origin: string): Request =>
      request({ ...DEPLOYED, origin }, undefined, 'https://aw.example.com/p/s/main/sessions');

    it('opens a session for a listed origin and lets its page read the answer', async () => {
      const calls = install(LISTED);
      const { status, response } = await answer('main', deployed(SHOP), {});
      expect(status).toBe(201);
      expect(response.headers.get('access-control-allow-origin')).toBe(SHOP);
      expect(response.headers.get('vary')).toBe('origin');
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
      expect(calls.opened).toEqual([LISTED]);
    });

    it('refuses another origin with 403 surface_origin_not_allowed, unreadable, opening nothing', async () => {
      const calls = install(LISTED);
      const { status, body, response } = await answer('main', deployed('https://evil.example'), {});
      expect(status).toBe(403);
      expect(codeOf(body)).toBe('surface_origin_not_allowed');
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(calls.opened).toEqual([]);
    });

    it('does not serve the try page’s local draft to an allowed origin: 404 surface_not_found (#612)', async () => {
      const calls = install(LISTED);
      const { status, body, response } = await answer(
        'main',
        request(
          { ...DEPLOYED, origin: SHOP },
          JSON.stringify({ environment: 'local' }),
          'https://aw.example.com/p/s/main/sessions',
        ),
        {},
      );
      expect(status).toBe(404);
      expect(codeOf(body)).toBe('surface_not_found');
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(calls).toMatchObject({ resolved: ['main (try)'], opened: [] });
    });

    it('refuses a surface with no list off loopback as before, 404 surface_sessions_unavailable', async () => {
      const calls = install(RESOLVED);
      const { status, body } = await answer('main', deployed(SHOP), {});
      expect(status).toBe(404);
      expect(codeOf(body)).toBe('surface_sessions_unavailable');
      expect(calls.opened).toEqual([]);
    });

    it('answers 429 surface_rate_limited with Retry-After to the 11th session of a client in a minute', async () => {
      const calls = install(LISTED);
      const proxied = {
        AW_TRUSTED_PROXY_HOPS: '1',
        SESSION_SECRET: 'k'.repeat(MIN_SESSION_SECRET_LENGTH),
      };
      const from = (address: string): Request =>
        request(
          { ...DEPLOYED, origin: SHOP, 'x-forwarded-for': address },
          undefined,
          'https://aw.example.com/p/s/main/sessions',
        );
      for (let opened = 0; opened < SURFACE_RATE_LIMITS.sessionsPerClient; opened += 1) {
        expect((await answer('main', from('203.0.113.7'), proxied)).status).toBe(201);
      }
      const { status, body, response } = await answer('main', from('203.0.113.7'), proxied);
      expect(status).toBe(429);
      expect(codeOf(body)).toBe('surface_rate_limited');
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(response.headers.get('access-control-allow-origin')).toBe(SHOP);
      expect(calls.opened).toHaveLength(SURFACE_RATE_LIMITS.sessionsPerClient);
      expect((await answer('main', from('203.0.113.8'), proxied)).status).toBe(201);
    });
  });
}
