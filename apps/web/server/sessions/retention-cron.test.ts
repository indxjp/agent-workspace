import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../../app/api/cron/retention/route';
import {
  getRetentionCronPass,
  handleRetentionCron,
  installRetentionCronPass,
  resetRetentionCronPass,
  type RetentionCronPass,
  wireSessionRetention,
} from './retention-cron';

const SECRET = 'cron-secret-value-0123456789abcdef';
const request = (authorization?: string) =>
  new Request('https://example.test/api/cron/retention', {
    method: 'GET',
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  });
const PURGED = {
  kind: 'purged',
  cutoff: new Date('2026-09-01T00:00:00Z'),
  transcripts: 2,
  stateEntries: 3,
  stateBlobs: 1,
} as const;

afterEach(() => {
  resetRetentionCronPass();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GET /api/cron/retention', () => {
  it.each([undefined, ''])('is a 404 and runs nothing while CRON_SECRET is %j', async (value) => {
    const pass = vi.fn<RetentionCronPass>(() => Promise.resolve([]));

    const response = await handleRetentionCron(request(`Bearer ${SECRET}`), {
      env: value === undefined ? {} : { CRON_SECRET: value },
      pass,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'not_found', message: expect.any(String) as unknown },
    });
    expect(pass).not.toHaveBeenCalled();
  });

  it.each([
    ['no authorization header', undefined],
    ['a wrong bearer', `Bearer ${SECRET}x`],
    ['a bearer of another length', 'Bearer x'],
    ['the secret without the Bearer scheme', SECRET],
    ['an empty bearer', 'Bearer '],
  ])('is a 401 and runs nothing with %s', async (_name, authorization) => {
    const pass = vi.fn<RetentionCronPass>(() => Promise.resolve([]));

    const response = await handleRetentionCron(request(authorization), {
      env: { CRON_SECRET: SECRET },
      pass,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'unauthenticated', message: expect.any(String) as unknown },
    });
    expect(pass).not.toHaveBeenCalled();
  });

  it('runs the pass with the exact bearer and counts what each workspace did', async () => {
    const pass = vi.fn<RetentionCronPass>(() =>
      Promise.resolve([PURGED, { kind: 'lease-held' }, { kind: 'dry-run', cutoff: new Date(0) }]),
    );

    const response = await handleRetentionCron(request(`Bearer ${SECRET}`), {
      env: { CRON_SECRET: SECRET },
      pass,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspaces: 3, purged: 1, dryRun: 1, leaseHeld: 1 });
    expect(pass).toHaveBeenCalledOnce();
  });

  it('answers 503 in the standard envelope when no pass is installed', async () => {
    const response = await handleRetentionCron(request(`Bearer ${SECRET}`), {
      env: { CRON_SECRET: SECRET },
      pass: null,
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'retention_not_configured', message: expect.any(String) as unknown },
    });
  });

  it('answers 500 without the failure text when the pass throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await handleRetentionCron(request(`Bearer ${SECRET}`), {
      env: { CRON_SECRET: SECRET },
      pass: () => Promise.reject(new Error('relation "secrets" does not exist')),
    });

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain('internal_error');
    expect(text).not.toContain('secrets');
  });

  it('is served by the route module from process.env and the installed pass', async () => {
    const pass = vi.fn<RetentionCronPass>(() => Promise.resolve([PURGED]));
    installRetentionCronPass(pass);
    expect(getRetentionCronPass()).toBe(pass);

    vi.stubEnv('CRON_SECRET', '');
    expect((await GET(request(`Bearer ${SECRET}`))).status).toBe(404);

    vi.stubEnv('CRON_SECRET', SECRET);
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request(`Bearer ${SECRET}`))).status).toBe(200);
    expect(pass).toHaveBeenCalledOnce();
  });
});

describe('wireSessionRetention', () => {
  it('installs the cron pass and starts no scheduler while CRON_SECRET is set', () => {
    const runPass = vi.fn<RetentionCronPass>(() => Promise.resolve([]));
    const startScheduler = vi.fn();
    const installPass = vi.fn();

    const driver = wireSessionRetention({
      env: { CRON_SECRET: SECRET },
      runPass,
      startScheduler,
      installPass,
    });

    expect(driver).toBe('cron');
    expect(installPass).toHaveBeenCalledExactlyOnceWith(runPass);
    expect(startScheduler).not.toHaveBeenCalled();
  });

  it('installs the pass the cron route reads by default', () => {
    const runPass = vi.fn<RetentionCronPass>(() => Promise.resolve([]));

    wireSessionRetention({ env: { CRON_SECRET: SECRET }, runPass, startScheduler: vi.fn() });

    expect(getRetentionCronPass()).toBe(runPass);
  });

  it.each([undefined, ''])(
    'starts the scheduler and installs nothing while CRON_SECRET is %j',
    (value) => {
      const startScheduler = vi.fn();
      const installPass = vi.fn();

      const driver = wireSessionRetention({
        env: value === undefined ? {} : { CRON_SECRET: value },
        runPass: vi.fn<RetentionCronPass>(() => Promise.resolve([])),
        startScheduler,
        installPass,
      });

      expect(driver).toBe('interval');
      expect(startScheduler).toHaveBeenCalledOnce();
      expect(installPass).not.toHaveBeenCalled();
      expect(getRetentionCronPass()).toBeNull();
    },
  );
});
