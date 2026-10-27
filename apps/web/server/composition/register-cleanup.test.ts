import { describe, expect, it } from 'vitest';

import {
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import {
  applicationContext,
  clearApplicationContext,
  type ApplicationContext,
} from '../application-context';
import { clearWebRuntimeRegistry } from '../runtimes/registry';
import { register, type RegisteredComposition } from './register';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[composition/register-cleanup.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so cleanup ' +
      'handles for partially installed composition roots were not verified against PostgreSQL.',
  );
}

const CONTROLLED_ENV = [
  'AW_RUNTIME_VERIFICATION_FILE',
  'DATABASE_URL',
  'NEXT_RUNTIME',
  'RUNNER_MANAGER_TOKEN',
  'RUNNER_MANAGER_URL',
  'RUNNER_URL',
  'SESSION_SECRET',
] as const;

type ControlledEnv = (typeof CONTROLLED_ENV)[number];

async function exerciseSkippedRunApi(
  prefix: string,
  configure: () => void,
): Promise<{
  readonly composition: RegisteredComposition | undefined;
  readonly context: ApplicationContext | null;
}> {
  let isolated: IsolatedTestDatabase | undefined;
  let composition: RegisteredComposition | undefined;
  const previousEnv = Object.fromEntries(
    CONTROLLED_ENV.map((key) => [key, process.env[key]]),
  ) as Record<ControlledEnv, string | undefined>;

  try {
    isolated = await createIsolatedTestDatabase(prefix);
    process.env['DATABASE_URL'] = isolated.url;
    process.env['SESSION_SECRET'] = 'register-cleanup-test-secret-at-least-32-characters';
    delete process.env['NEXT_RUNTIME'];
    delete process.env['RUNNER_MANAGER_TOKEN'];
    delete process.env['RUNNER_MANAGER_URL'];
    delete process.env['RUNNER_URL'];
    delete process.env['AW_RUNTIME_VERIFICATION_FILE'];
    clearWebRuntimeRegistry();
    clearApplicationContext();
    configure();

    composition = await register();
    return { composition, context: applicationContext() };
  } finally {
    clearApplicationContext();
    for (const key of CONTROLLED_ENV) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearWebRuntimeRegistry();
    if (isolated !== undefined) {
      await closeIsolatedTestResources(
        isolated,
        ...(composition === undefined ? [] : [composition]),
      );
    }
  }
}

describe.skipIf(!hasDatabase)('register composition cleanup ownership', () => {
  it('returns a cleanup handle when no runtime can install the run API', async () => {
    const { composition, context } = await exerciseSkippedRunApi(
      'aw_register_cleanup_runtime',
      () => {},
    );

    expect(composition).toBeDefined();
    // One install, after everything is built: the run domains are `disabled`, the rest serve.
    expect(context).not.toBeNull();
    expect({
      a2a: context?.a2a,
      runs: context?.runs,
      surfaces: context?.surfaces,
      tokens: context?.tokens,
      toolEndpoint: context?.toolEndpoint,
      triggers: context?.triggers,
    }).toEqual({
      a2a: { kind: 'disabled' },
      runs: { kind: 'disabled' },
      surfaces: { kind: 'disabled' },
      tokens: { kind: 'disabled' },
      toolEndpoint: { kind: 'disabled' },
      triggers: { kind: 'disabled' },
    });
    expect(context?.projects).toBeDefined();
  }, 180_000);

  it('returns a cleanup handle when the runtime registry cannot be installed', async () => {
    const { composition, context } = await exerciseSkippedRunApi(
      'aw_register_cleanup_registry',
      () => {
        process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
        // A directory is not a readable verification-cache document. `installDriverRegistry`
        // reports the failure and intentionally leaves the registry absent.
        process.env['AW_RUNTIME_VERIFICATION_FILE'] = process.cwd();
      },
    );

    expect(composition).toBeDefined();
    expect(context?.runs).toEqual({ kind: 'disabled' });
  }, 180_000);
});
