import type { SurfaceRuntimeInstaller } from './handlers.fixture.test-support';
import { describe, expect, it } from 'vitest';
import { ApiProblemSchema } from '@indx-workspace/contracts';
import { preflightSurfaceSession, preflightVisitorRun } from './handlers';
import { installTestDomains } from '../../application-context-fixtures';
import { LOCAL_ENV, RESOLVED, request, answer } from './handlers.fixture.test-support';
export function registerSurfaceLocalTests(
  install: SurfaceRuntimeInstaller,
  readEnvironment: () => Readonly<Record<string, string | undefined>>,
) {
  describe('the local draft’s default origins under `aw dev` (#699, composed with #733)', () => {
    const APP = 'http://localhost:5173';
    const FROM_APP = { host: '127.0.0.1:3200', origin: APP, 'sec-fetch-site': 'same-site' };

    it('opens a session of the unpromoted local draft from a loopback app, with CORS', async () => {
      const calls = install(RESOLVED);
      const { status, response } = await answer('main', request(FROM_APP));
      expect(status).toBe(201);
      expect(response.headers.get('access-control-allow-origin')).toBe(APP);
      expect(calls.opened).toEqual([RESOLVED]);
      expect(
        await preflightSurfaceSession(
          'main',
          new Headers({ ...FROM_APP, 'access-control-request-method': 'POST' }),
          LOCAL_ENV,
        ),
      ).toMatchObject({ 'access-control-allow-origin': APP });
    });

    it('lets the run routes answer CORS only for a surface served from the local draft', async () => {
      const run = new Headers({ ...FROM_APP, 'access-control-request-method': 'POST' });
      installTestDomains({
        surfaces: {
          kind: 'serving',
          runtime: {
            env: () => readEnvironment(),
            resolve: () => Promise.resolve(RESOLVED),
            open: () => Promise.reject(new Error('the run routes never open a session')),
            checkModel: () => Promise.reject(new Error('the run routes never check a model')),
            visitorSurface: () =>
              Promise.reject(new Error('the preflight never looks a session up')),
            servedSurfaces: () => Promise.resolve([{ ...RESOLVED.surface, servedFrom: 'local' }]),
          },
        },
      });
      expect(await preflightVisitorRun('POST', run, LOCAL_ENV)).toMatchObject({
        'access-control-allow-origin': APP,
      });
      installTestDomains({
        surfaces: {
          kind: 'serving',
          runtime: {
            env: () => readEnvironment(),
            resolve: () => Promise.resolve(RESOLVED),
            open: () => Promise.reject(new Error('the run routes never open a session')),
            checkModel: () => Promise.reject(new Error('the run routes never check a model')),
            visitorSurface: () =>
              Promise.reject(new Error('the preflight never looks a session up')),
            servedSurfaces: () =>
              Promise.resolve([{ ...RESOLVED.surface, servedFrom: 'production' }]),
          },
        },
      });
      expect(await preflightVisitorRun('POST', run, LOCAL_ENV)).toEqual({
        'cache-control': 'no-store',
        vary: 'origin',
      });
    });

    it('refuses the same app once a production version without origins serves visitors', async () => {
      const calls = install({ ...RESOLVED, environment: 'production', promoted: true });
      const { status, body, response } = await answer('main', request(FROM_APP));
      expect(status).toBe(404);
      expect(ApiProblemSchema.parse(body).error.details).toEqual(['same-origin']);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(calls.opened).toEqual([]);
    });
  });
}
