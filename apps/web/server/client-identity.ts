/**
 * What the per-client rate limits and the runnable public links need to tell one caller from
 * another (refactoring part 03, step 2): the proxies trusted to append `X-Forwarded-For`, and the
 * secret that keys the address into an opaque visitor key. The composition root installs it once,
 * from the settings it parsed at start-up; the readers take it as a parameter that defaults to the
 * installed value, so none of them reads the environment.
 */
import { readSessionSecret } from './auth/session';
import { defineSlot } from './runtime-slot';
import { parseTrustedProxyHops, type SettingsEnvironment } from './settings';

export interface ClientIdentitySettings {
  /** Proxies in front of web that append `X-Forwarded-For`; `null` trusts no chain. */
  readonly trustedProxyHops: number | null;
  /** The deployment's session secret; `null` when it is not configured. */
  readonly sessionSecret: string | null;
}

/** Nothing installed: no client can be identified, so every caller shares one bucket. */
export const NO_CLIENT_IDENTITY: ClientIdentitySettings = {
  trustedProxyHops: null,
  sessionSecret: null,
};

/**
 * The client-identity settings an environment holds, failing closed: a malformed proxy count or a
 * missing or short secret reads as not configured. The composition root has already refused a
 * malformed count (`readWebSettings`); this also serves a caller's own test environment.
 */
export function clientIdentityFromEnvironment(env: SettingsEnvironment): ClientIdentitySettings {
  const hops = parseTrustedProxyHops(env['AW_TRUSTED_PROXY_HOPS']);
  const secret = readSessionSecret(env);
  return {
    trustedProxyHops: hops.ok ? hops.value : null,
    sessionSecret: secret.ok ? secret.secret : null,
  };
}

const slot = defineSlot<ClientIdentitySettings>('__agentWorkspaceClientIdentity__');

/** Install the parsed settings. Called once by the composition root. */
export function installClientIdentity(identity: ClientIdentitySettings): void {
  slot.set(identity);
}

/** Remove the installed settings; the composition root's `close()` calls it. */
export function clearClientIdentity(): void {
  slot.clear();
}

/** The installed settings, or {@link NO_CLIENT_IDENTITY} when nothing is installed. */
export function installedClientIdentity(): ClientIdentitySettings {
  return slot.current() ?? NO_CLIENT_IDENTITY;
}
