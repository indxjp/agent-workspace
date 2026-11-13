import { describe, expect, it, vi } from 'vitest';

import { defaultProfile } from '../profile-defaults.js';
import {
  CLOUDFLARE_CONFIG_FILE,
  CLOUDFLARE_RETENTION_CRON_PATH,
  CLOUDFLARE_WORKER_FILE,
  cloudflareFrontendConfiguration,
  renderCloudflareProject,
} from './cloudflare.js';

import { artefact, fileOf, images } from './cloudflare-workers.test-support.ts';

describe('the Cloudflare platform Worker', () => {
  it('declares one daily retention Cron Trigger and carries no name, account or secret', () => {
    expect(artefact().directory).toBe('cloudflare');
    expect(JSON.parse(fileOf(CLOUDFLARE_CONFIG_FILE))).toEqual({
      main: CLOUDFLARE_WORKER_FILE,
      compatibility_date: '2026-10-01',
      workers_dev: false,
      triggers: { crons: ['0 3 * * *'] },
    });
    expect(CLOUDFLARE_RETENTION_CRON_PATH).toBe('/api/cron/retention');
  });

  it.each(['aws', 'gcp', 'azure', 'local', 'vercel'] as const)(
    'renders nothing for %s',
    (cloud) => {
      expect(
        renderCloudflareProject(defaultProfile({ cloud, projectName: 'a' }), images),
      ).toBeNull();
    },
  );

  describe('the scheduled handler', retentionHandlerCases);
});

describe('the runner manager Worker', () => {
  it.each([
    ['cloudflare-sandbox', 'CLOUDFLARE_SANDBOX_BRIDGE_URL', 'EXTERNAL_PROVIDER'],
    ['external', 'EXTERNAL_PROVIDER', 'CLOUDFLARE_SANDBOX_BRIDGE_URL'],
  ] as const)('with driver %s also requires %s, not %s', (driver, needed, other) => {
    const profile = defaultProfile({ cloud: 'cloudflare', projectName: 'a' });
    const rendered = renderCloudflareProject({ ...profile, runtime: { default: driver } }, images);
    const module =
      rendered?.files.find(({ fileName }) => fileName === 'manager-worker.mjs')?.contents ?? '';
    const required = /const REQUIRED_SECRETS = \[([^\]]*)\]/u.exec(module)?.[1] ?? '';

    expect(required).toContain(`'${needed}'`);
    expect(required).not.toContain(`'${other}'`);
  });
});

describe('the Cloudflare frontend Worker', () => {
  it('serves the built web/ output as a single-page app after running the project build', () => {
    expect(cloudflareFrontendConfiguration('/p/web', '/p/web/dist')).toEqual({
      compatibility_date: '2026-10-01',
      workers_dev: true,
      build: { command: 'npm run build', cwd: '/p/web' },
      assets: { directory: '/p/web/dist', not_found_handling: 'single-page-application' },
    });
  });
});

// The committed golden, which `artefacts.test.ts` pins byte-for-byte to the rendered Worker.
async function handler() {
  const module = await import('../fixtures/cloudflare/deploy-cloudflare-retention-worker.mjs');
  return module.default.scheduled;
}
const env = { CONTROL_PLANE_URL: 'https://app.example', CRON_SECRET: 'cron-secret' };

function retentionHandlerCases(): void {
  it('calls the retention and schedule trigger routes with the bearer', async () => {
    const fetchStub = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchStub);
    try {
      await (
        await handler()
      )(undefined, env);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchStub.mock.calls.map(([url]) => url)).toEqual([
      'https://app.example/api/cron/retention',
      'https://app.example/api/cron/triggers',
    ]);
    expect(fetchStub.mock.calls[0]?.[1]?.headers).toEqual({
      authorization: 'Bearer cron-secret',
    });
  });

  it('still calls the schedule trigger route when the retention route fails', async () => {
    // The retention route is called first.
    const fetchStub = vi
      .fn<typeof fetch>(() => Promise.resolve(new Response('{}')))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetchStub);
    try {
      await expect((await handler())(undefined, env)).rejects.toThrow(
        'The /api/cron/retention route answered 500',
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchStub.mock.calls.map(([url]) => url)).toEqual([
      'https://app.example/api/cron/retention',
      'https://app.example/api/cron/triggers',
    ]);
  });

  retentionRefusalCase();
}

function retentionRefusalCase(): void {
  it('fails the invocation when the route refuses, and when it is unconfigured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 401 }))),
    );
    try {
      await expect((await handler())(undefined, env)).rejects.toThrow('answered 401');
    } finally {
      vi.unstubAllGlobals();
    }
    await expect((await handler())(undefined, { ...env, CRON_SECRET: '' })).rejects.toThrow(
      'CRON_SECRET is not set',
    );
    await expect((await handler())(undefined, { ...env, CONTROL_PLANE_URL: '' })).rejects.toThrow(
      'CONTROL_PLANE_URL is not set',
    );
  });
}
