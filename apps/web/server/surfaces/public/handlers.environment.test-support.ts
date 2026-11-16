import type { SurfaceRuntimeInstaller } from './handlers.fixture.test-support';
import { describe, expect, it } from 'vitest';
import { toResponse } from '../../rbac/http';
import { createSurfaceSession, readSurfacePage } from './handlers';
import { LOCAL_ENV, RESOLVED, request, codeOf } from './handlers.fixture.test-support';
export function registerSurfaceEnvironmentTests(install: SurfaceRuntimeInstaller) {
  describe('the environment the composition root injects (refactoring plan part 05)', () => {
    it('is the installed runtime’s, read on every call, when a caller passes none', async () => {
      let env: Readonly<Record<string, string>> = LOCAL_ENV;
      install(RESOLVED, undefined, () => env);
      const pageHeaders = new Headers({ host: '127.0.0.1:4310' });
      expect((await readSurfacePage('main', pageHeaders))?.branch).toBe('loopback');
      expect(toResponse(await createSurfaceSession(request(), 'main')).status).toBe(201);

      env = {};
      await expect(readSurfacePage('main', pageHeaders)).resolves.toBeNull();
      const refused = toResponse(await createSurfaceSession(request(), 'main'));
      expect(refused.status).toBe(404);
      expect(codeOf(await refused.json())).toBe('surface_sessions_unavailable');
    });
  });
}
