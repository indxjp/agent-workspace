import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import { installedAuthSettings, NO_AUTH_SETTINGS } from '../auth-settings';
import { installedClientIdentity, NO_CLIENT_IDENTITY } from '../client-identity';
import type { RegisteredComposition } from './register';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

const CONTROLLED_ENV = [
  'DATABASE_URL',
  'MASTER_ENCRYPTION_KEY',
  'SESSION_SECRET',
  'RUNNER_URL',
  'NEXT_RUNTIME',
  'AW_TRUSTED_PROXY_HOPS',
] as const;
const SESSION_SECRET = 'register-client-identity-secret-at-least-32-chars';

describe.skipIf(!hasDatabase)('register() installs the client identity it parsed', () => {
  let isolated: IsolatedTestDatabase;
  let composition: RegisteredComposition | undefined;
  let previousEnv: Record<(typeof CONTROLLED_ENV)[number], string | undefined>;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_register_client_identity');
    previousEnv = Object.fromEntries(
      CONTROLLED_ENV.map((key) => [key, process.env[key]]),
    ) as typeof previousEnv;
    process.env['DATABASE_URL'] = isolated.url;
    process.env['MASTER_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');
    process.env['SESSION_SECRET'] = SESSION_SECRET;
    process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
    process.env['AW_TRUSTED_PROXY_HOPS'] = '2';
    delete process.env['NEXT_RUNTIME'];
  }, 180_000);

  afterAll(async () => {
    for (const key of CONTROLLED_ENV) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await composition?.close();
    await isolated.close();
  });

  it('installs the proxy count and the secret, and close() removes them', async () => {
    const { register } = await import('./register');
    composition = await register();
    expect(composition).toBeDefined();
    expect(installedClientIdentity()).toEqual({
      trustedProxyHops: 2,
      sessionSecret: SESSION_SECRET,
    });
    expect(installedAuthSettings().sessionSecret).toEqual({ ok: true, secret: SESSION_SECRET });
    await composition?.close();
    expect(installedClientIdentity()).toEqual(NO_CLIENT_IDENTITY);
    // The sign-in settings go with them (refactoring part 03, step 3).
    expect(installedAuthSettings()).toBe(NO_AUTH_SETTINGS);
  }, 180_000);
});
