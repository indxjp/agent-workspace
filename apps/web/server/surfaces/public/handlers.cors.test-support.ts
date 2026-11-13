import type { SurfaceRuntimeInstaller } from './handlers.fixture.test-support';
import { log as webLogger } from '../../telemetry/logger';
import { describe, expect, it, vi } from 'vitest';
import {
  preflightSurfaceSession,
  preflightVisitorRun,
  visitorRunResponseHeaders,
} from './handlers';
import { type ResolvedSurface } from './runtime';
import { installTestDomains } from '../../application-context-fixtures';
import { clearApplicationContext } from '../../application-context';
import { RESOLVED } from './handlers.fixture.test-support';
export function registerSurfaceCorsTests(
  install: SurfaceRuntimeInstaller,
  readEnvironment: () => Readonly<Record<string, string | undefined>>,
) {
  describe('CORS of the run routes a visitor token may call (#680)', () => {
    const SHOP = 'https://shop.example.com';
    const LISTED: ResolvedSurface = {
      ...RESOLVED,
      surface: { ...RESOLVED.surface, allowedOrigins: [SHOP] },
    };
    const from = (origin: string | null, method = 'GET'): Headers =>
      new Headers({
        host: 'aw.example.com',
        'sec-fetch-site': 'cross-site',
        'access-control-request-method': method,
        ...(origin === null ? {} : { origin }),
      });

    it('grants a listed origin the route’s own method, with no credentials', async () => {
      install(LISTED);
      const preflight = await preflightVisitorRun('POST', from(SHOP, 'POST'), {});
      expect(preflight).toMatchObject({
        'access-control-allow-origin': SHOP,
        'access-control-allow-methods': 'POST',
        vary: 'origin',
      });
      expect(preflight['access-control-allow-headers']).toContain('authorization');
      expect(preflight['access-control-allow-headers']).toContain('last-event-id');
      expect(preflight).not.toHaveProperty('access-control-allow-credentials');
      const response = await visitorRunResponseHeaders(from(SHOP), {});
      expect(response['access-control-allow-origin']).toBe(SHOP);
      expect(response['access-control-expose-headers']).toContain('retry-after');
      expect(response).not.toHaveProperty('access-control-allow-credentials');
    });

    it('grants nothing to another method, origin, a null or missing one, or a same-origin page', async () => {
      install(LISTED);
      for (const headers of [
        from(SHOP, 'DELETE'),
        from('https://evil.example'),
        from('null'),
        from(null),
        new Headers({ host: 'aw.example.com', origin: 'https://aw.example.com' }),
      ]) {
        const preflight = await preflightVisitorRun('GET', headers, {});
        expect(preflight).toEqual({ 'cache-control': 'no-store', vary: 'origin' });
        if (headers.get('access-control-request-method') !== 'DELETE') {
          expect(await visitorRunResponseHeaders(headers, {})).toEqual({ vary: 'origin' });
        }
      }
    });

    it('grants nothing when no served surface lists origins, or none is installed', async () => {
      install(RESOLVED);
      expect(await visitorRunResponseHeaders(from(SHOP), {})).toEqual({ vary: 'origin' });
      clearApplicationContext();
      expect(await visitorRunResponseHeaders(from(SHOP), {})).toEqual({ vary: 'origin' });
    });

    it('fails closed when the served surfaces cannot be read', async () => {
      installTestDomains({
        surfaces: {
          kind: 'serving',
          runtime: {
            env: () => readEnvironment(),
            resolve: () => Promise.resolve(null),
            open: () => Promise.reject(new Error('never opened')),
            visitorSurface: () => Promise.resolve(null),
            servedSurfaces: () => Promise.reject(new Error('the database is down')),
            checkModel: () => Promise.reject(new Error('never checked')),
          },
        },
      });
      const logged = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
      try {
        expect(await visitorRunResponseHeaders(from(SHOP), {})).toEqual({ vary: 'origin' });
        expect(logged).toHaveBeenCalledOnce();
      } finally {
        logged.mockRestore();
      }
    });

    it('grants the session bootstrap preflight through the same check', async () => {
      install(LISTED);
      expect(await preflightSurfaceSession('main', from(SHOP, 'POST'), {})).toMatchObject({
        'access-control-allow-origin': SHOP,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type',
      });
      expect(await preflightSurfaceSession('main', from('https://evil.example'), {})).toEqual({
        'cache-control': 'no-store',
        vary: 'origin',
      });
    });
  });
}
