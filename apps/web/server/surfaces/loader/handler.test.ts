import { ApiProblemSchema } from '@indx-workspace/contracts';
import type { SurfaceDefinition } from '@indx-workspace/contracts/surfaces';
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSurfaceSessionsRuntime,
  configureSurfaceSessionsRuntime,
  type ResolvedSurface,
} from '../public/runtime';
import { serveWidgetLoader, type WidgetLookOf } from './handler';
import type { WidgetLook } from './render';

const LOCAL_ENV = { AW_LOCAL_SURFACE_SESSIONS: '1', HOST: '127.0.0.1' } as const;
const ORIGIN = 'http://127.0.0.1:4310';

const SURFACE: SurfaceDefinition = {
  name: 'main',
  agent: 'Support triage',
  title: 'Help centre',
  theme: { colour: '#0a7f5a' },
};

const RESOLVED: ResolvedSurface = {
  workspaceId: '33333333-3333-4333-8333-333333333333',
  agentId: '22222222-2222-4222-8222-222222222222',
  agentName: 'Support triage',
  environment: 'local',
  versionId: '55555555-5555-4555-8555-555555555555',
  versionNumber: 1,
  promoted: false,
  surface: SURFACE,
};

const LOOK: WidgetLook = {
  colour: '#0a7f5a',
  foreground: '#ffffff',
  radius: 8,
  layout: 'dock',
  launcherLabel: 'Open Help centre',
  frameTitle: 'Help centre',
};

function install(resolved: ResolvedSurface | null): string[] {
  const asked: string[] = [];
  configureSurfaceSessionsRuntime({
    resolve: (name, mode) => {
      asked.push(mode === 'public' ? name : `${name} (${mode})`);
      return Promise.resolve(resolved);
    },
    open: () => Promise.reject(new Error('the loader never opens a session')),
    checkModel: () => Promise.reject(new Error('the loader never checks a model')),
    visitorSurface: () => Promise.reject(new Error('the loader never looks a session up')),
    servedSurfaces: () => Promise.reject(new Error('the loader never lists surfaces')),
  });
  return asked;
}

function loaderRequest(name: string, host = '127.0.0.1:4310'): Request {
  return new Request(`${ORIGIN}/p/s/${name}/widget.js`, { headers: { host } });
}

async function expectNotFound(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(ApiProblemSchema.parse(await response.json()).error.code).toBe('surface_not_found');
}

afterEach(() => {
  clearSurfaceSessionsRuntime();
});

describe('serveWidgetLoader (GET /p/s/<name>/widget.js; S1-18, #456)', () => {
  it('serves the loader of the resolved surface, drawn with its look', async () => {
    install(RESOLVED);
    const seen: [SurfaceDefinition, string][] = [];
    const lookOf: WidgetLookOf = (surface, agentName) => {
      seen.push([surface, agentName]);
      return LOOK;
    };
    const response = await serveWidgetLoader(loaderRequest('main'), 'main', lookOf, LOCAL_ENV);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await response.text();
    expect(body).toContain('"origin":"http://127.0.0.1:4310"');
    expect(body).toContain('"name":"main"');
    expect(body).toContain('"colour":"#0a7f5a"');
    expect(seen).toEqual([[SURFACE, 'Support triage']]);
  });

  it('names the origin the request was addressed to, not the one Next.js rebuilt request.url with', async () => {
    // `next start` rebuilds `request.url` from the host it listens on (`localhost`); a loader that
    // framed that origin from a page on `127.0.0.1` was refused by `frame-ancestors 'self'` (S1-19).
    install(RESOLVED);
    const request = new Request('http://localhost:4310/p/s/main/widget.js', {
      headers: { host: '127.0.0.1:4310' },
    });
    const body = await (await serveWidgetLoader(request, 'main', () => LOOK, LOCAL_ENV)).text();
    expect(body).toContain('"origin":"http://127.0.0.1:4310"');
    expect(body).not.toContain('localhost');
  });

  it('serves the try page’s loader from local, framing the page with the same query (#612)', async () => {
    const asked = install(RESOLVED);
    const request = new Request(`${ORIGIN}/p/s/main/widget.js?environment=local`, {
      headers: { host: '127.0.0.1:4310' },
    });
    const body = await (await serveWidgetLoader(request, 'main', () => LOOK, LOCAL_ENV)).text();
    expect(asked).toEqual(['main (try)']);
    expect(body).toContain('"query":"?environment=local"');

    const plain = await (
      await serveWidgetLoader(loaderRequest('main'), 'main', () => LOOK, LOCAL_ENV)
    ).text();
    expect(plain).toContain('"query":""');
  });

  it('is 404 surface_not_found when a condition fails and the surface lists no origins', async () => {
    install(RESOLVED);
    await expectNotFound(await serveWidgetLoader(loaderRequest('main'), 'main', () => LOOK, {}));
    await expectNotFound(
      await serveWidgetLoader(loaderRequest('main', 'example.com'), 'main', () => LOOK, LOCAL_ENV),
    );
  });

  it('serves a surface with allowedOrigins off loopback, its origin read from the script URL (#622)', async () => {
    install({ ...RESOLVED, surface: { ...SURFACE, allowedOrigins: ['https://shop.example.com'] } });
    const request = new Request('http://0.0.0.0:3000/p/s/main/widget.js', {
      headers: { host: 'aw.example.com' },
    });
    const response = await serveWidgetLoader(request, 'main', () => LOOK, {});
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"origin":null');
    expect(body).toContain('new URL(document.currentScript.src).origin');
    expect(body).not.toContain('aw.example.com');
  });

  it('is 404 surface_not_found for a bad name, an unknown surface or no runtime', async () => {
    await expectNotFound(
      await serveWidgetLoader(loaderRequest('main'), 'main', () => LOOK, LOCAL_ENV),
    );
    const asked = install(null);
    await expectNotFound(
      await serveWidgetLoader(loaderRequest('Main'), 'Main', () => LOOK, LOCAL_ENV),
    );
    await expectNotFound(
      await serveWidgetLoader(loaderRequest('other'), 'other', () => LOOK, LOCAL_ENV),
    );
    expect(asked).toEqual(['other']);
  });
});
