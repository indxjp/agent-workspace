import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearAuthSettings,
  installedSessionCookieName,
  installedSessionSecret,
} from '../auth-settings';
import { register } from './register';

const SECRET = 'a-session-secret-of-at-least-32-characters';

describe('register() and the sign-in settings (refactoring part 03, step 3)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clearAuthSettings();
  });

  it('installs them before the database opens, read once from the environment', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('SESSION_SECRET', SECRET);
    vi.stubEnv('AW_INSTANCE_ID', 'acme-ai');
    // No reachable database: register() stops after installing the settings.
    vi.stubEnv('DATABASE_URL', 'postgres://nobody:nothing@127.0.0.1:1/none');
    await register();
    vi.stubEnv('SESSION_SECRET', '');
    vi.stubEnv('AW_INSTANCE_ID', 'other');
    expect(installedSessionSecret()).toEqual({ ok: true, secret: SECRET });
    expect(installedSessionCookieName()).toBe('__Host-aw_session_acme-ai');
  });

  it('installs a missing secret with its reason, so a route still says why', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('SESSION_SECRET', '');
    await register();
    vi.stubEnv('SESSION_SECRET', SECRET);
    const secret = installedSessionSecret();
    expect(secret.ok).toBe(false);
    if (!secret.ok) expect(secret.reason).toContain('SESSION_SECRET is not set');
  });
});
