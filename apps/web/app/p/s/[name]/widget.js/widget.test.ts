/**
 * `GET /p/s/<name>/widget.js` through its route (ADR-0105 slice 1; S1-18, issue #456): the
 * acceptance path, over the runtime of `server/surfaces/loader/test-runtime.ts`.
 */
import { ApiProblemSchema } from '@indx-workspace/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installWidgetSurfaceRuntime,
  WIDGET_WORKSPACE_SLUG,
} from '../../../../../server/surfaces/loader/test-runtime';
import { GET } from './route';
import { clearApplicationContext } from '../../../../../server/application-context';

const ORIGIN = 'http://127.0.0.1:4310';

function get(name: string): Promise<Response> {
  return GET(
    new Request(`${ORIGIN}/p/s/${name}/widget.js`, { headers: { host: '127.0.0.1:4310' } }),
    { params: Promise.resolve({ name }) },
  );
}

beforeEach(async () => {
  vi.stubEnv('AW_LOCAL_SURFACE_SESSIONS', '1');
  vi.stubEnv('HOST', '127.0.0.1');
  vi.stubEnv('BOOTSTRAP_ADMIN', 'admin@example.com');
  vi.stubEnv('BOOTSTRAP_ADMIN_PASSWORD', 'correct-horse-battery');
  vi.stubEnv('WORKSPACE_SLUG', WIDGET_WORKSPACE_SLUG);
  await installWidgetSurfaceRuntime();
});

afterEach(() => {
  clearApplicationContext();
  vi.unstubAllEnvs();
});

describe('GET /p/s/<name>/widget.js (S1-18, #456)', () => {
  it('serves the loader of the surface the local pointer names, drawn with its look', async () => {
    const response = await get('main');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await response.text();
    expect(body).toContain('"origin":"http://127.0.0.1:4310"');
    expect(body).toContain('"name":"main"');
    expect(body).toContain('"colour":"#0a7f5a"');
    expect(body).toContain('"layout":"side"');
    expect(body).toContain('"frameTitle":"Help centre"');
    expect(body).toContain('"launcherLabel":"Help centreを開く"');
  });

  it('is 404 surface_not_found for a surface no pointer serves', async () => {
    const response = await get('billing');
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(ApiProblemSchema.parse(await response.json()).error.code).toBe('surface_not_found');
  });

  it('is 404 surface_not_found off the local runtime', async () => {
    vi.stubEnv('AW_LOCAL_SURFACE_SESSIONS', '');
    const response = await get('main');
    expect(response.status).toBe(404);
    expect(ApiProblemSchema.parse(await response.json()).error.code).toBe('surface_not_found');
  });
});
