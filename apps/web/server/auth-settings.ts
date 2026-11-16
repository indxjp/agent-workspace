/**
 * The sign-in settings (refactoring part 03, step 3): the session secret, the cookie instance id,
 * the bootstrap administrator and the OIDC client. The composition root parses them once, at
 * start-up, and installs them here; the routes and `auth/index.ts` read them from here, so none of
 * them reads the environment. The parsers stay in `auth/session.ts` and `auth/oidc.ts`, which
 * import nothing (W1-CP-06), and the proxy, which has its own module graph, still passes its
 * environment to them.
 *
 * Nothing is refused that was not refused before: a missing or short secret, an unusable
 * bootstrap administrator and a partial OIDC client keep the answers they had, because the installer
 * renders an issuer with the other three OIDC values left for the operator to fill in.
 */
import { readOidcConfiguration, type DiscoverableOidcConfiguration } from './auth/oidc.ts';
import {
  cookieInstanceId,
  DEFAULT_SESSION_COOKIE_NAME,
  MIN_BOOTSTRAP_PASSWORD_LENGTH,
  MIN_SESSION_SECRET_LENGTH,
  readBootstrapAdmin,
  readSessionSecret,
  scopedCookieName,
  type BootstrapAdminResult,
  type SecretResult,
} from './auth/session.ts';
import { defineSlot } from './runtime-slot.ts';
import type { SettingDescription, SettingsEnvironment } from './settings.ts';

/** The OIDC client, `null` when none is configured, or the error a partial one raises when used. */
export type OidcSetting =
  | { readonly ok: true; readonly configuration: DiscoverableOidcConfiguration | null }
  | { readonly ok: false; readonly error: Error };

export interface AuthSettings {
  readonly sessionSecret: SecretResult;
  /** The cookie-name suffix `AW_INSTANCE_ID` gives, or `undefined` for the default names. */
  readonly instanceId: string | undefined;
  readonly bootstrapAdmin: BootstrapAdminResult;
  readonly oidc: OidcSetting;
}

/** The variables {@link authSettingsFromEnvironment} reads, for the generated settings table. */
export const AUTH_SETTINGS: readonly SettingDescription[] = [
  {
    name: 'SESSION_SECRET',
    default: 'none: every /api/** request is refused',
    meaning: `The key sign-in sessions are signed with, at least ${String(MIN_SESSION_SECRET_LENGTH)} characters. Changing it signs everyone out.`,
  },
  {
    name: 'AW_INSTANCE_ID',
    default: 'unset: the default cookie names',
    meaning:
      'Scopes the sign-in cookies to this deployment, so two deployments on one host do not sign each other out.',
  },
  {
    name: 'BOOTSTRAP_ADMIN',
    default: 'none: password sign-in is refused',
    meaning: 'The email address of the first workspace owner, who signs in with a password.',
  },
  {
    name: 'BOOTSTRAP_ADMIN_PASSWORD',
    default: 'none: password sign-in is refused',
    meaning: `That owner's password, at least ${String(MIN_BOOTSTRAP_PASSWORD_LENGTH)} characters. Never stored.`,
  },
  {
    name: 'WORKSPACE_SLUG',
    default: '`default`',
    meaning: 'The workspace this deployment serves: lower-case letters, digits and `-`, up to 63.',
  },
  {
    name: 'OIDC_ISSUER_URL',
    default: 'unset: no single sign-on',
    meaning:
      'The single sign-on provider. Set all four `OIDC_*` values together, or sign-in through it fails.',
  },
  {
    name: 'OIDC_CLIENT_ID',
    default: 'unset',
    meaning: 'The client id this deployment has at the provider.',
  },
  { name: 'OIDC_CLIENT_SECRET', default: 'unset', meaning: 'The client secret for that id.' },
  {
    name: 'OIDC_REDIRECT_URI',
    default: 'unset',
    meaning: "This deployment's `/api/auth/callback` URL, as registered at the provider.",
  },
  {
    name: 'AW_DEPLOYMENT_POSTURE',
    default: '`production` when `NODE_ENV` is `production`, otherwise `local`',
    meaning:
      'Read here only for a plain-`http` loopback issuer: provider discovery may use `http` only under `local`.',
  },
  {
    name: 'NODE_ENV',
    default: 'unset',
    meaning: 'Decides the posture above when `AW_DEPLOYMENT_POSTURE` is unset.',
  },
  {
    name: 'HOST',
    default: 'unset',
    meaning: 'The host web listens on; a `local` posture must listen on a loopback host.',
  },
];

/** Parse the sign-in settings an environment holds. Never throws. */
export function authSettingsFromEnvironment(env: SettingsEnvironment): AuthSettings {
  let oidc: OidcSetting;
  try {
    oidc = { ok: true, configuration: readOidcConfiguration(env) };
  } catch (error) {
    oidc = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
  return {
    sessionSecret: readSessionSecret(env),
    instanceId: cookieInstanceId(env),
    bootstrapAdmin: readBootstrapAdmin(env),
    oidc,
  };
}

const NOT_INSTALLED_REASON =
  'The sign-in settings were not installed: the server did not finish starting. See the start-up log.';

/** Nothing installed: no session can be signed or verified, so every sign-in is refused. */
export const NO_AUTH_SETTINGS: AuthSettings = {
  sessionSecret: { ok: false, reason: NOT_INSTALLED_REASON },
  instanceId: undefined,
  bootstrapAdmin: { ok: false, reason: NOT_INSTALLED_REASON },
  oidc: { ok: true, configuration: null },
};

const slot = defineSlot<() => AuthSettings>('__agentWorkspaceAuthSettings__');

/** Install the settings parsed at start-up. Called once by the composition root. */
export function installAuthSettings(settings: AuthSettings): void {
  slot.set(() => settings);
}

/**
 * Install a reader called on every read. For the web test setup only, which reads the test
 * process's environment each time, so a test that sets a variable sees it at once.
 */
export function installAuthSettingsReader(read: () => AuthSettings): void {
  slot.set(read);
}

/** Remove the installed settings; the composition root's `close()` calls it. */
export function clearAuthSettings(): void {
  slot.clear();
}

/** The installed settings, or {@link NO_AUTH_SETTINGS} when nothing is installed. */
export function installedAuthSettings(): AuthSettings {
  return slot.current()?.() ?? NO_AUTH_SETTINGS;
}

/** The installed session secret, or why there is none. */
export function installedSessionSecret(): SecretResult {
  return installedAuthSettings().sessionSecret;
}

/** An auth cookie's name for this deployment (issue #394), from the installed instance id. */
export function installedScopedCookieName(base: string): string {
  return scopedCookieName(base, installedAuthSettings().instanceId);
}

/** The session cookie's name for this deployment. */
export function installedSessionCookieName(): string {
  return installedScopedCookieName(DEFAULT_SESSION_COOKIE_NAME);
}

/** The OIDC client, or `null`; a partial client throws the same error it always did. */
export function installedOidcConfiguration(): DiscoverableOidcConfiguration | null {
  const oidc = installedAuthSettings().oidc;
  if (!oidc.ok) throw oidc.error;
  return oidc.configuration;
}
