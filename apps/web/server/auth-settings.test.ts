import { afterEach, describe, expect, it } from 'vitest';

import {
  authSettingsFromEnvironment,
  clearAuthSettings,
  installAuthSettings,
  installedAuthSettings,
  installedOidcConfiguration,
  installedScopedCookieName,
  installedSessionCookieName,
  installedSessionSecret,
  NO_AUTH_SETTINGS,
} from './auth-settings';

const SECRET = 'a-session-secret-of-at-least-32-characters';
const OIDC = {
  OIDC_ISSUER_URL: 'https://identity.example',
  OIDC_CLIENT_ID: 'client',
  OIDC_CLIENT_SECRET: 'client-secret',
  OIDC_REDIRECT_URI: 'https://console.example/api/auth/callback',
};

afterEach(() => {
  clearAuthSettings();
});

describe('the sign-in settings (refactoring part 03, step 3)', () => {
  it('parses the secret, the instance id, the bootstrap administrator and the OIDC client', () => {
    const settings = authSettingsFromEnvironment({
      SESSION_SECRET: SECRET,
      AW_INSTANCE_ID: 'acme-ai',
      BOOTSTRAP_ADMIN: 'Admin@Example.com',
      BOOTSTRAP_ADMIN_PASSWORD: 'a-long-enough-password',
      ...OIDC,
    });
    expect(settings.sessionSecret).toEqual({ ok: true, secret: SECRET });
    expect(settings.instanceId).toBe('acme-ai');
    expect(settings.bootstrapAdmin).toMatchObject({
      ok: true,
      admin: { email: 'admin@example.com' },
    });
    expect(settings.oidc).toMatchObject({ ok: true, configuration: { clientId: 'client' } });
  });

  it('keeps every failure it had: a missing secret, no administrator, no OIDC', () => {
    const settings = authSettingsFromEnvironment({});
    const { sessionSecret, bootstrapAdmin } = settings;
    expect(sessionSecret.ok).toBe(false);
    if (!sessionSecret.ok) expect(sessionSecret.reason).toContain('SESSION_SECRET is not set');
    expect(settings.instanceId).toBeUndefined();
    expect(bootstrapAdmin.ok).toBe(false);
    if (!bootstrapAdmin.ok) expect(bootstrapAdmin.reason).toContain('BOOTSTRAP_ADMIN is not set');
    expect(settings.oidc).toEqual({ ok: true, configuration: null });
  });

  it('does not refuse a partial OIDC client; using it throws the error it always did', () => {
    // The installer renders the issuer and leaves the other three for the operator to fill in.
    const settings = authSettingsFromEnvironment({ OIDC_ISSUER_URL: OIDC.OIDC_ISSUER_URL });
    expect(settings.oidc.ok).toBe(false);
    installAuthSettings(settings);
    expect(() => installedOidcConfiguration()).toThrow(
      'OIDC requires OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_REDIRECT_URI together.',
    );
  });

  it('reads what was installed, parsed once: a later environment change is not seen', () => {
    const env: Record<string, string | undefined> = {
      SESSION_SECRET: SECRET,
      AW_INSTANCE_ID: 'one',
      ...OIDC,
    };
    installAuthSettings(authSettingsFromEnvironment(env));
    env['SESSION_SECRET'] = undefined;
    env['AW_INSTANCE_ID'] = 'two';
    expect(installedSessionSecret()).toEqual({ ok: true, secret: SECRET });
    expect(installedSessionCookieName()).toBe('__Host-aw_session_one');
    expect(installedScopedCookieName('aw_oidc_transaction')).toBe('aw_oidc_transaction_one');
    expect(installedOidcConfiguration()).toMatchObject({ issuer: OIDC.OIDC_ISSUER_URL });
  });

  it('with nothing installed, refuses every sign-in and names the reason', () => {
    clearAuthSettings();
    expect(installedAuthSettings()).toBe(NO_AUTH_SETTINGS);
    const secret = installedSessionSecret();
    expect(secret.ok).toBe(false);
    if (!secret.ok) expect(secret.reason).toContain('did not finish starting');
    expect(installedSessionCookieName()).toBe('__Host-aw_session');
    expect(installedOidcConfiguration()).toBeNull();
  });
});
