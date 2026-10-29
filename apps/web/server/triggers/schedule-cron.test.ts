import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../../app/api/cron/triggers/route';
import {
  getTriggerScheduleCron,
  handleTriggerScheduleCron,
  installTriggerScheduleCron,
  resetTriggerScheduleCron,
  runTriggerCronPass,
  type TriggerScheduleCronPass,
  wireTriggerSchedule,
} from './schedule-cron';

const SECRET = 'cron-secret-value-0123456789abcdef';
const request = (authorization?: string) =>
  new Request('https://example.test/api/cron/triggers', {
    method: 'GET',
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  });
const RESULT = { leaseHeld: false, workspaces: 2, fired: 1, skipped: 1, failed: 0 } as const;
const passReturning = () => vi.fn<TriggerScheduleCronPass>(() => Promise.resolve(RESULT));
const quietLog = () => ({ error: vi.fn() });

afterEach(() => {
  resetTriggerScheduleCron();
  vi.restoreAllMocks();
});

describe('GET /api/cron/triggers', () => {
  it('is a 404 while no cron is installed (CRON_SECRET unset)', async () => {
    const response = await handleTriggerScheduleCron(request(`Bearer ${SECRET}`), null);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'not_found', message: expect.any(String) as unknown },
    });
  });

  it.each([
    ['no authorization header', undefined],
    ['a wrong bearer', `Bearer ${SECRET}x`],
    ['a bearer of another length', 'Bearer x'],
    ['the secret without the Bearer scheme', SECRET],
    ['an empty bearer', 'Bearer '],
  ])('is a 401 and runs nothing with %s', async (_name, authorization) => {
    const pass = passReturning();

    const response = await handleTriggerScheduleCron(request(authorization), {
      secret: SECRET,
      pass,
      log: quietLog(),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'unauthenticated', message: expect.any(String) as unknown },
    });
    expect(pass).not.toHaveBeenCalled();
  });

  it('runs the pass with the exact bearer and returns what it did', async () => {
    const pass = passReturning();

    const response = await handleTriggerScheduleCron(request(`Bearer ${SECRET}`), {
      secret: SECRET,
      pass,
      log: quietLog(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(RESULT);
    expect(pass).toHaveBeenCalledOnce();
  });

  it('answers 500 without the failure text and logs it to the injected log', async () => {
    const log = quietLog();

    const response = await handleTriggerScheduleCron(request(`Bearer ${SECRET}`), {
      secret: SECRET,
      pass: () => Promise.reject(new Error('relation "triggers" does not exist')),
      log,
    });

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain('internal_error');
    expect(text).not.toContain('triggers"');
    expect(log.error).toHaveBeenCalledExactlyOnceWith('[trigger-schedule-cron] pass failed', {
      error: new Error('relation "triggers" does not exist'),
    });
  });

  it('is served by the route module from the installed cron, not the environment', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    expect((await GET(request(`Bearer ${SECRET}`))).status).toBe(404);
    vi.unstubAllEnvs();

    const pass = passReturning();
    installTriggerScheduleCron({ secret: SECRET, pass, log: quietLog() });

    expect((await GET(request())).status).toBe(401);
    expect((await GET(request(`Bearer ${SECRET}`))).status).toBe(200);
    expect(pass).toHaveBeenCalledOnce();
  });
});

describe('wireTriggerSchedule', () => {
  it('installs the cron and starts no scheduler while CRON_SECRET is set', () => {
    const runPass = passReturning();
    const log = quietLog();
    const startScheduler = vi.fn();
    const installCron = vi.fn();

    const driver = wireTriggerSchedule({
      cronSecret: SECRET,
      runPass,
      log,
      startScheduler,
      installCron,
    });

    expect(driver).toBe('cron');
    expect(installCron).toHaveBeenCalledExactlyOnceWith({ secret: SECRET, pass: runPass, log });
    expect(startScheduler).not.toHaveBeenCalled();
  });

  it('installs the cron the route reads by default', () => {
    const runPass = passReturning();

    wireTriggerSchedule({
      cronSecret: SECRET,
      runPass,
      log: quietLog(),
      startScheduler: vi.fn(),
    });

    expect(getTriggerScheduleCron()).toMatchObject({ secret: SECRET, pass: runPass });
  });

  it.each([undefined, ''])(
    'starts the scheduler and installs nothing while CRON_SECRET is %j',
    (value) => {
      const startScheduler = vi.fn();
      const installCron = vi.fn();

      const driver = wireTriggerSchedule({
        cronSecret: value,
        runPass: passReturning(),
        log: quietLog(),
        startScheduler,
        installCron,
      });

      expect(driver).toBe('interval');
      expect(startScheduler).toHaveBeenCalledOnce();
      expect(installCron).not.toHaveBeenCalled();
      expect(getTriggerScheduleCron()).toBeNull();
    },
  );
});

describe('runTriggerCronPass', () => {
  const SWEEP = {
    leaseHeld: false,
    throttled: false,
    workspaces: 2,
    archived: 3,
    failed: 0,
  } as const;

  it('reports the schedule pass and the archive sweep of one delivery', async () => {
    const result = await runTriggerCronPass({
      schedule: () => Promise.resolve(RESULT),
      archive: () => Promise.resolve(SWEEP),
      log: quietLog(),
    });

    expect(result).toEqual({ ...RESULT, archive: SWEEP });
  });

  it('keeps the schedule result and logs when the sweep throws', async () => {
    const log = quietLog();
    const failure = new Error('lease unavailable');

    const result = await runTriggerCronPass({
      schedule: () => Promise.resolve(RESULT),
      archive: () => Promise.reject(failure),
      log,
    });

    expect(result).toEqual({ ...RESULT, archive: null });
    expect(log.error).toHaveBeenCalledExactlyOnceWith('[agent-archive] sweep failed', {
      error: failure,
    });
  });

  it('does not sweep when the schedule pass throws', async () => {
    const archive = vi.fn(() => Promise.resolve(SWEEP));

    await expect(
      runTriggerCronPass({
        schedule: () => Promise.reject(new Error('the run API is not installed')),
        archive,
        log: quietLog(),
      }),
    ).rejects.toThrow('the run API is not installed');
    expect(archive).not.toHaveBeenCalled();
  });
});
