import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LockOutcome } from '@agent-workspace/core/db';
import type { Logger } from '@agent-workspace/core/telemetry';

import { GET } from '../../app/api/cron/storage-cleanup/route';
import type { CleanupReport } from './cleanup';
import {
  getStorageCleanupCron,
  readStorageCleanupMode,
  resetStorageCleanupCron,
  runCleanupTick,
  startStorageCleanup,
} from './cleanup-cron';

const HOUR_MS = 60 * 60 * 1000;
const SECRET = 'cron-secret-value-0123456789abcdef';

const REPORT: CleanupReport = {
  mode: 'report',
  scanned: 3,
  orphans: 1,
  stalePendingReady: 0,
  stalePendingDeleted: 0,
  deletingFinished: 0,
  skippedYoung: 2,
  deleted: 0,
};

function recordingLog() {
  const lines: { level: string; message: string; fields: unknown }[] = [];
  const log: Logger = {
    info: (message, fields) => lines.push({ level: 'info', message, fields }),
    warn: (message, fields) => lines.push({ level: 'warn', message, fields }),
    error: (message, fields) => lines.push({ level: 'error', message, fields }),
    child: () => log,
  };
  return { log, lines };
}

/** A lock that is free, or held by another server. */
const lockOf =
  (held: boolean) =>
  async <R>(_name: string, work: () => Promise<R>): Promise<LockOutcome<R>> =>
    held ? { acquired: false } : { acquired: true, value: await work() };

describe('AW_STORAGE_CLEANUP', () => {
  // @story US-STO-14
  it.each([null, 'report'])('[US-STO-14][unit][sdk] %j means report', (raw) => {
    expect(readStorageCleanupMode(raw)).toBe('report');
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] delete is accepted', () => {
    expect(readStorageCleanupMode('delete')).toBe('delete');
  });

  // @story US-STO-14
  it.each(['Delete', 'purge-everything', 'true'])(
    '[US-STO-14][unit][sdk] %j is refused with a message that names only the variable',
    (raw) => {
      expect(() => readStorageCleanupMode(raw)).toThrow(
        'AW_STORAGE_CLEANUP must be report or delete.',
      );
      expect(() => readStorageCleanupMode(raw)).not.toThrow(raw);
    },
  );
});

describe('the cleanup schedule', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    resetStorageCleanupCron();
  });

  const start = (options: {
    held?: boolean;
    cronSecret?: string;
    pass?: () => Promise<CleanupReport>;
  }) => {
    const stops: (() => void)[] = [];
    const pass = vi.fn(options.pass ?? (() => Promise.resolve(REPORT)));
    const { log, lines } = recordingLog();
    const started = startStorageCleanup({
      cronSecret: options.cronSecret ?? null,
      stopOnClose: (stop) => stops.push(stop),
      lock: lockOf(options.held ?? false),
      pass,
      log,
    });
    return { started, stops, pass, lines };
  };

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] without CRON_SECRET one pass runs each hour until the server closes', async () => {
    const { started, stops, pass } = start({});
    expect(started).toBe('interval');
    expect(pass).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(pass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(pass).toHaveBeenCalledTimes(2);

    stops.forEach((stop) => stop());
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(pass).toHaveBeenCalledTimes(2);
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] with CRON_SECRET no timer starts and the cron route is installed', async () => {
    const { started, stops, pass } = start({ cronSecret: SECRET });

    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);

    expect(started).toBe('cron');
    expect(getStorageCleanupCron()?.secret).toBe(SECRET);
    expect(stops).toEqual([]);
    expect(pass).not.toHaveBeenCalled();
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] a held lock skips the pass and logs one line', async () => {
    const { pass, lines } = start({ held: true });

    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(pass).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] a pass that fails logs the error name only and the timer keeps running', async () => {
    const failing = () =>
      Promise.reject(
        Object.assign(new Error('https://bucket.example/signed?token=abc'), { name: 'Boom' }),
      );
    const { pass, lines } = start({ pass: failing });

    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);

    expect(pass).toHaveBeenCalledTimes(2);
    expect(lines.map((line) => line.fields)).toEqual([{ name: 'Boom' }, { name: 'Boom' }]);
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] a tick returns what the pass returned', async () => {
    const { log } = recordingLog();
    await expect(
      runCleanupTick({ lock: lockOf(false), pass: () => Promise.resolve(7), log }),
    ).resolves.toEqual({ acquired: true, value: 7 });
  });
});

describe('GET /api/cron/storage-cleanup', () => {
  afterEach(() => resetStorageCleanupCron());

  const request = (authorization?: string) =>
    GET(
      new Request('https://example.test/api/cron/storage-cleanup', {
        method: 'GET',
        ...(authorization === undefined ? {} : { headers: { authorization } }),
      }),
    );

  /** Install the cron as the composition root does, with an in-memory lock one caller holds. */
  function install(pass: () => Promise<CleanupReport>) {
    let held = false;
    const lock = async <R>(_name: string, work: () => Promise<R>): Promise<LockOutcome<R>> => {
      if (held) return { acquired: false };
      held = true;
      try {
        return { acquired: true, value: await work() };
      } finally {
        held = false;
      }
    };
    const spy = vi.fn(pass);
    startStorageCleanup({
      cronSecret: SECRET,
      stopOnClose: () => undefined,
      lock,
      pass: spy,
      log: recordingLog().log,
    });
    return spy;
  }

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] is a 404 while no cron is installed (CRON_SECRET unset)', async () => {
    const response = await request(`Bearer ${SECRET}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'not_found', message: expect.any(String) as unknown },
    });
  });

  // @story US-STO-14
  it.each([
    ['no authorization header', undefined],
    ['a wrong bearer', `Bearer ${SECRET}x`],
    ['a bearer of another length', 'Bearer x'],
    ['the secret without the Bearer scheme', SECRET],
  ])('[US-STO-14][unit][sdk] is a 401 and runs no pass with %s', async (_name, authorization) => {
    const pass = install(() => Promise.resolve(REPORT));

    const response = await request(authorization);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'unauthenticated', message: expect.any(String) as unknown },
    });
    expect(pass).not.toHaveBeenCalled();
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] runs one pass with the exact bearer and answers its counts', async () => {
    const pass = install(() => Promise.resolve(REPORT));

    const response = await request(`Bearer ${SECRET}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ alreadyRunning: false, ...REPORT });
    expect(pass).toHaveBeenCalledOnce();
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] a second concurrent call answers already running and runs no second pass', async () => {
    let finish: (report: CleanupReport) => void = () => undefined;
    const pass = install(
      () =>
        new Promise<CleanupReport>((resolve) => {
          finish = resolve;
        }),
    );

    const first = request(`Bearer ${SECRET}`);
    await vi.waitFor(() => expect(pass).toHaveBeenCalledOnce());
    const second = await request(`Bearer ${SECRET}`);
    finish(REPORT);

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ alreadyRunning: true });
    expect((await first).status).toBe(200);
    expect(pass).toHaveBeenCalledOnce();
  });

  // @story US-STO-14
  it('[US-STO-14][unit][sdk] a failed pass is a 500 that names no storage detail', async () => {
    install(() =>
      Promise.reject(new Error('https://bucket.example/workspace/secret-key?token=abc')),
    );

    const response = await request(`Bearer ${SECRET}`);

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('bucket.example');
  });
});
