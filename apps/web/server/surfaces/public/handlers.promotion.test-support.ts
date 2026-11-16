import { describe, expect, it } from 'vitest';
import { ApiProblemSchema } from '@indx-workspace/contracts';
import { preflightSurfaceSession } from './handlers';
import { type ResolvedSurface } from './runtime';
import { installTestDomains } from '../../application-context-fixtures';
import { LOCAL_ENV, RESOLVED, request, answer } from './handlers.fixture.test-support';
export function registerSurfacePromotionTests(
  readEnvironment: () => Readonly<Record<string, string | undefined>>,
) {
  describe('an origin only the local draft lists, while production serves visitors (#733)', () => {
    const SITE = 'http://127.0.0.1:5173';
    const PRODUCTION: ResolvedSurface = { ...RESOLVED, environment: 'production', promoted: true };
    const DRAFT: ResolvedSurface = {
      ...RESOLVED,
      versionNumber: 3,
      promoted: true,
      surface: { ...RESOLVED.surface, allowedOrigins: [SITE] },
    };
    const FROM_SITE = { host: '127.0.0.1:3200', origin: SITE, 'sec-fetch-site': 'same-site' };
    const PREFLIGHT = { ...FROM_SITE, 'access-control-request-method': 'POST' };

    /** A runtime whose public lookup answers `production` and whose try lookup answers `draft`. */
    function installVersions(production: ResolvedSurface | null, draft: ResolvedSurface): void {
      installTestDomains({
        surfaces: {
          kind: 'serving',
          runtime: {
            env: () => readEnvironment(),
            resolve: (_name, mode) => Promise.resolve(mode === 'public' ? production : draft),
            open: () => Promise.reject(new Error('a refused origin never opens a session')),
            checkModel: () => Promise.reject(new Error('the bootstrap never checks a model alone')),
            visitorSurface: () =>
              Promise.reject(new Error('the bootstrap never looks a session up')),
            servedSurfaces: () => Promise.resolve(production === null ? [] : [production.surface]),
          },
        },
      });
    }

    it('refuses with a readable 403 that names production and `aw promote`', async () => {
      installVersions(PRODUCTION, DRAFT);
      const { status, body, response } = await answer('main', request(FROM_SITE));
      expect(status).toBe(403);
      const { error } = ApiProblemSchema.parse(body);
      expect(error.code).toBe('surface_origin_not_allowed');
      expect(error.details).toEqual(['promotion-pending']);
      expect(error.message).toContain('production version');
      expect(error.message).toContain('aw promote');
      expect(response.headers.get('access-control-allow-origin')).toBe(SITE);
      expect(
        await preflightSurfaceSession('main', new Headers(PREFLIGHT), LOCAL_ENV),
      ).toMatchObject({
        'access-control-allow-origin': SITE,
      });
    });

    it('does not look the draft up for a request without an Origin', async () => {
      const modes: string[] = [];
      installTestDomains({
        surfaces: {
          kind: 'serving',
          runtime: {
            env: () => readEnvironment(),
            resolve: (_name, mode) => {
              modes.push(mode);
              return Promise.resolve(mode === 'public' ? PRODUCTION : DRAFT);
            },
            open: () => Promise.reject(new Error('a refused origin never opens a session')),
            checkModel: () => Promise.reject(new Error('the bootstrap never checks a model alone')),
            visitorSurface: () =>
              Promise.reject(new Error('the bootstrap never looks a session up')),
            servedSurfaces: () => Promise.resolve([PRODUCTION.surface]),
          },
        },
      });
      const { host } = FROM_SITE;
      expect((await answer('main', request({ host }))).status).toBe(404);
      expect(await preflightSurfaceSession('main', new Headers({ host }), LOCAL_ENV)).toEqual({
        'cache-control': 'no-store',
        vary: 'origin',
      });
      expect(modes).toEqual(['public', 'public']);
    });

    it('gives the same hint when the production version carries no such surface', async () => {
      installVersions(null, DRAFT);
      const { status, body } = await answer('main', request(FROM_SITE));
      expect(status).toBe(403);
      expect(ApiProblemSchema.parse(body).error.details).toEqual(['promotion-pending']);
    });

    it('grants nothing to an origin no version lists, nor before the agent is promoted', async () => {
      installVersions(PRODUCTION, DRAFT);
      const other = { ...FROM_SITE, origin: 'http://127.0.0.1:9999' };
      const refused = await answer('main', request(other));
      expect(refused.status).toBe(404);
      expect(refused.response.headers.get('access-control-allow-origin')).toBeNull();
      expect(
        await preflightSurfaceSession('main', new Headers({ ...PREFLIGHT, ...other }), LOCAL_ENV),
      ).toEqual({ 'cache-control': 'no-store', vary: 'origin' });

      installVersions({ ...PRODUCTION, promoted: false }, { ...DRAFT, promoted: false });
      const { body } = await answer('main', request(FROM_SITE));
      expect(ApiProblemSchema.parse(body).error.details).toEqual(['same-origin']);
    });
  });
}
