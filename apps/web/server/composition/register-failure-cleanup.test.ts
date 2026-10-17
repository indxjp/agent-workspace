import { describe, expect, it, vi } from 'vitest';

import {
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

const injected = vi.hoisted(() => ({
  registrationFailure: new Error('RF-002 injected post-database registration failure'),
}));

vi.mock('../telemetry/runtime', () => ({
  configureTelemetryRuntime: () => Promise.reject(injected.registrationFailure),
  recordRunTelemetry: vi.fn(),
}));

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[composition/register-failure-cleanup.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so ' +
      'cleanup after an unexpected composition failure was not verified against PostgreSQL.',
  );
}

const CONTROLLED_ENV = ['DATABASE_URL', 'NEXT_RUNTIME', 'SESSION_SECRET'] as const;

describe.skipIf(!hasDatabase)('register failure cleanup ownership', () => {
  it('closes the database root before rethrowing an unexpected installer failure', async () => {
    let isolated: IsolatedTestDatabase | undefined;
    let cleanupAttempted = false;
    const previousEnv = Object.fromEntries(
      CONTROLLED_ENV.map((key) => [key, process.env[key]]),
    ) as Record<(typeof CONTROLLED_ENV)[number], string | undefined>;

    try {
      isolated = await createIsolatedTestDatabase('aw_register_failure_cleanup');
      process.env['DATABASE_URL'] = isolated.url;
      process.env['SESSION_SECRET'] = 'register-failure-cleanup-test-secret-at-least-32-characters';
      delete process.env['NEXT_RUNTIME'];

      const { register } = await import('./register');
      await expect(register()).rejects.toBe(injected.registrationFailure);

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
  }, 180_000);
});
