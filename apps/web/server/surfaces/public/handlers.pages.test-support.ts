import type { SurfaceRuntimeInstaller } from './handlers.fixture.test-support';
import { describe, expect, it } from 'vitest';
import { readSurfacePage } from './handlers';
import { LOCAL_ENV, RESOLVED } from './handlers.fixture.test-support';
export function registerSurfacePagesTests(install: SurfaceRuntimeInstaller) {
  describe('readSurfacePage (GET /p/s/<name>)', () => {
    const pageHeaders = new Headers({ host: '127.0.0.1:4310' });

    it('renders the surface and its agent when conditions 1-3 hold, and opens nothing', async () => {
      const calls = install(RESOLVED);
      await expect(readSurfacePage('main', pageHeaders, LOCAL_ENV)).resolves.toEqual({
        branch: 'loopback',
        surfaceName: 'main',
        agentName: 'Support triage',
        surface: RESOLVED.surface,
        promoted: false,
      });
      expect(calls.opened).toEqual([]);
    });

    it('reads the try page in try mode, on loopback only, with whether the agent is promoted (#612)', async () => {
      const calls = install({ ...RESOLVED, promoted: true });
      const page = await readSurfacePage('main', pageHeaders, LOCAL_ENV, 'try');
      expect(page?.promoted).toBe(true);
      expect(calls.resolved).toEqual(['main (try)']);

      install({
        ...RESOLVED,
        surface: { ...RESOLVED.surface, allowedOrigins: ['https://a.example'] },
      });
      await expect(
        readSurfacePage('main', new Headers({ host: 'aw.example.com' }), {}, 'try'),
      ).resolves.toBeNull();
    });

    it('renders behind the X-Forwarded-Host that Next.js sets, under a container HOSTNAME', async () => {
      install(RESOLVED);
      const nextHeaders = new Headers({
        host: '127.0.0.1:4310',
        'x-forwarded-host': '127.0.0.1:4310',
        'x-forwarded-port': '4310',
        'x-forwarded-proto': 'http',
        'x-forwarded-for': '127.0.0.1',
      });
      const env = { ...LOCAL_ENV, AW_DEPLOYMENT_POSTURE: 'local', HOSTNAME: '3f2a9c1b7d4e' };
      await expect(readSurfacePage('main', nextHeaders, env)).resolves.toEqual({
        branch: 'loopback',
        surfaceName: 'main',
        agentName: 'Support triage',
        surface: RESOLVED.surface,
        promoted: false,
      });
    });

    it('passes the parsed definition through, so the page and the loader read its look (S1-18)', async () => {
      const surface = {
        name: 'main',
        agent: 'Support triage',
        title: 'Help centre',
        theme: { colour: '#0a7f5a', radius: 12, locale: 'ja' },
        layout: 'side',
        parts: { greeting: 'Hello', toolTrace: 'collapsed' },
      } as const;
      install({ ...RESOLVED, surface });
      const page = await readSurfacePage('main', pageHeaders, LOCAL_ENV);
      expect(page?.surface).toEqual(surface);
    });

    it('is not found with no runtime, a failed condition, a bad name or an unknown surface', async () => {
      await expect(readSurfacePage('main', pageHeaders, LOCAL_ENV)).resolves.toBeNull();
      const calls = install(null);
      await expect(readSurfacePage('main', pageHeaders, {})).resolves.toBeNull();
      await expect(
        readSurfacePage('main', new Headers({ host: 'example.com' }), LOCAL_ENV),
      ).resolves.toBeNull();
      await expect(readSurfacePage('Main', pageHeaders, LOCAL_ENV)).resolves.toBeNull();
      await expect(readSurfacePage('main', pageHeaders, LOCAL_ENV)).resolves.toBeNull();
      expect(calls.resolved).toEqual(['main', 'main', 'main']);
    });

    it('renders a surface with allowedOrigins off loopback, on the allowed-origin branch (#622)', async () => {
      install({
        ...RESOLVED,
        surface: { ...RESOLVED.surface, allowedOrigins: ['https://a.example'] },
      });
      const page = await readSurfacePage('main', new Headers({ host: 'aw.example.com' }), {});
      expect(page?.branch).toBe('allowed-origin');
    });
  });
}
