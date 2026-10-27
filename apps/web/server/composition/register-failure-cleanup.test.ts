import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import { readGatewayIssuerSettings } from '../gateway/issuer';
import { STORAGE_WRITEBACK_DEADLINE_MS } from '../runs/launcher';
import { STALE_RUN_SWEEP_MARGIN_MS } from '../runs/stale-sweep';
import { maximumRunDurationMs } from './config';

const injected = vi.hoisted(() => ({
  registrationFailure: new Error('RF-002 injected post-database registration failure'),
  installFailure: new Error('fix-boot-timers injected failure after the background drivers start'),
  /** `telemetry` (the first installer) or `install` (the last step). */
  failAt: 'telemetry',
  /** Each background driver's stop, as `register()` received it. */
  stops: new Map<string, ReturnType<typeof vi.fn>>(),
  /** The stale-run sweep's threshold, and the environment it was started in. */
  sweep: { staleAfterMs: 0, env: {} as NodeJS.ProcessEnv },
}));

vi.mock('../telemetry/runtime', async (importActual) => {
  const actual = await importActual<typeof import('../telemetry/runtime')>();
  return {
    ...actual,
    configureTelemetryRuntime: (...args: Parameters<typeof actual.configureTelemetryRuntime>) =>
      injected.failAt === 'telemetry'
        ? Promise.reject(injected.registrationFailure)
        : actual.configureTelemetryRuntime(...args),
  };
});

// The last step of `register()`: everything, the background drivers included, is already running.
vi.mock('../application-context', async (importActual) => {
  const actual = await importActual<typeof import('../application-context')>();
  return {
    ...actual,
    installApplicationContext: (...args: Parameters<typeof actual.installApplicationContext>) => {
      if (injected.failAt === 'install') throw injected.installFailure;
      actual.installApplicationContext(...args);
    },
  };
});

vi.mock('../runs/stale-sweep', async (importActual) => {
  const actual = await importActual<typeof import('../runs/stale-sweep')>();
  return {
    ...actual,
    startStaleRunSweeper: (deps: Parameters<typeof actual.startStaleRunSweeper>[0]) => {
      injected.sweep = { staleAfterMs: deps.staleAfterMs, env: { ...process.env } };
      const stop = vi.fn(actual.startStaleRunSweeper(deps));
      injected.stops.set('stale-run sweeper', stop);
      return stop;
    },
  };
});

vi.mock('../triggers/schedule-pass', async (importActual) => {
  const actual = await importActual<typeof import('../triggers/schedule-pass')>();
  return {
    ...actual,
    startSchedulePassScheduler: (deps: Parameters<typeof actual.startSchedulePassScheduler>[0]) => {
      const stop = vi.fn(actual.startSchedulePassScheduler(deps));
      injected.stops.set('trigger scheduler', stop);
      return stop;
    },
  };
});

vi.mock('../sessions/retention', async (importActual) => {
  const actual = await importActual<typeof import('../sessions/retention')>();
  return {
    ...actual,
    startSessionRetentionScheduler: (
      input: Parameters<typeof actual.startSessionRetentionScheduler>[0],
    ) => {
      const scheduler = actual.startSessionRetentionScheduler(input);
      const stop = vi.fn(() => scheduler.stop());
      injected.stops.set('session retention', stop);
      return { ...scheduler, stop };
    },
  };
});

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[composition/register-failure-cleanup.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so ' +
      'cleanup after an unexpected composition failure was not verified against PostgreSQL.',
  );
}

const CONTROLLED_ENV = [
  'CRON_SECRET',
  'DATABASE_URL',
  'GATEWAY_TOKEN_SECRET',
  'MODEL_GATEWAY_URL',
  'NEXT_RUNTIME',
  'RUNNER_URL',
  'SESSION_SECRET',
] as const;

/** Register against a fresh database with `configure`'s environment; `expected` is the rejection. */
async function expectRegisterToFail(expected: Error, configure: () => void): Promise<void> {
  let isolated: IsolatedTestDatabase | undefined;
  let cleanupAttempted = false;
  const previousEnv = Object.fromEntries(
    CONTROLLED_ENV.map((key) => [key, process.env[key]]),
  ) as Record<(typeof CONTROLLED_ENV)[number], string | undefined>;

  try {
    isolated = await createIsolatedTestDatabase('aw_register_failure_cleanup');
    for (const key of CONTROLLED_ENV) delete process.env[key];
    process.env['DATABASE_URL'] = isolated.url;
    process.env['SESSION_SECRET'] = 'register-failure-cleanup-test-secret-at-least-32-characters';
    configure();

    const { register } = await import('./register');
    await expect(register()).rejects.toBe(expected);

    cleanupAttempted = true;
    await expect(isolated.close()).resolves.toBeUndefined();
  } finally {
    for (const key of CONTROLLED_ENV) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (isolated !== undefined && !cleanupAttempted) await isolated.close();
  }
}

describe.skipIf(!hasDatabase)('register failure cleanup ownership', () => {
  afterEach(() => {
    injected.failAt = 'telemetry';
    injected.stops.clear();
  });

  it('closes the database root before rethrowing an unexpected installer failure', async () => {
    await expectRegisterToFail(injected.registrationFailure, () => {});
  }, 180_000);

  it('stops every background driver it started when a later step fails', async () => {
    injected.failAt = 'install';
    await expectRegisterToFail(injected.installFailure, () => {
      // Enough for the run API (and so the stale-run sweeper and the trigger scheduler) to start.
      process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
      process.env['MODEL_GATEWAY_URL'] = 'http://127.0.0.1:9';
      process.env['GATEWAY_TOKEN_SECRET'] = 'register-failure-cleanup-gateway-secret-32-bytes';
    });

    expect([...injected.stops.keys()].sort()).toEqual([
      'session retention',
      'stale-run sweeper',
      'trigger scheduler',
    ]);
    for (const stop of injected.stops.values()) expect(stop).toHaveBeenCalledOnce();
    // A completed run stays `running` through its write-back; the sweep must not fail it mid-save.
    const gateway = readGatewayIssuerSettings(injected.sweep.env);
    if (!gateway.ok) throw new Error('the gateway settings did not parse');
    expect(injected.sweep.staleAfterMs).toBeGreaterThanOrEqual(
      maximumRunDurationMs(injected.sweep.env, gateway.settings.ttlSeconds) +
        STORAGE_WRITEBACK_DEADLINE_MS +
        STALE_RUN_SWEEP_MARGIN_MS,
    );
  }, 180_000);
});
