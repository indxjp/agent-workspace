/**
 * What the docker and kubernetes drivers share about the per-session egress proxy of ADR-0117
 * (`packages/egress-proxy`): the allowlist a run's policy asks for, the environment that points a
 * sandbox at the proxy, and the image check. Placement stays with each driver (decision 7).
 */
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

import type { RuntimeRunSpec } from './driver.js';

/** The port `packages/egress-proxy` listens on by default. */
export const EGRESS_PROXY_PORT = 3128;

const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/u;
/** A host name or `*.suffix`; a comma, space or `=` could not be told from a second entry. */
const ALLOWED_DOMAIN = /^(?:\*\.)?[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/u;
const BYPASS_HOST = /^[A-Za-z0-9_.:[\]-]+$/u;

export function requireEgressProxyImage(
  driver: string,
  image: string,
  requireDigest: boolean,
): string {
  if (image.trim().length === 0 || /\s/u.test(image)) {
    throw new Error(`${driver} runtime: egressProxyImage must be a non-empty image reference.`);
  }
  if (requireDigest && !DIGEST_PINNED.test(image)) {
    throw new Error(
      `${driver} runtime: production images must be pinned by sha256 digest; egressProxyImage is not.`,
    );
  }
  return image;
}

export function requireProxyBypass(driver: string, hosts: readonly string[]): readonly string[] {
  for (const host of hosts) {
    if (!BYPASS_HOST.test(host)) {
      throw new Error(`${driver} runtime: proxyBypass entries must be host names or addresses.`);
    }
  }
  return hosts;
}

/**
 * The `EGRESS_ALLOWLIST` a run needs, or `null` when the run needs no proxy.
 *
 * `open` is the allowlist `*` (public internet, ADR-0117 decision 8). `restricted` is
 * `allowedDomains`; with none listed nothing is allowed, so the sandbox keeps only the gateway and
 * no proxy starts (the proxy refuses an empty allowlist). `*` is refused inside `allowedDomains`:
 * it would silently turn `restricted` into `open`, which is a different permission (ADR-0117
 * decision 9). Domains attached to any other policy are refused, never ignored.
 */
export function egressAllowlist(
  driver: string,
  policy: RuntimeRunSpec['networkPolicy'],
  allowedDomains: readonly string[] | undefined,
): string | null {
  const domains = allowedDomains ?? [];
  if (policy !== 'restricted' && domains.length > 0) {
    throw new Error(
      `${driver} runtime: allowedDomains applies only to the restricted network policy.`,
    );
  }
  if (policy === 'open') return '*';
  if (policy === 'none' || domains.length === 0) return null;
  for (const domain of domains) {
    if (!ALLOWED_DOMAIN.test(domain)) {
      throw new Error(
        `${driver} runtime: allowedDomains entries must be host names or *.suffix; ${JSON.stringify(domain)} is not.`,
      );
    }
  }
  for (const domain of domains) assertProxyAccepts(driver, domain);
  return domains.join(',');
}

const PROXY_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/u;

/** The rules `parseAllowlist` applies in the proxy: a credential with a host it refuses is void. */
function assertProxyAccepts(driver: string, domain: string): void {
  const host = (domain.startsWith('*.') ? domain.slice(2) : domain).toLowerCase();
  const wildcardWithoutDot = domain.startsWith('*.') && !host.includes('.');
  if (
    isIP(host) !== 0 ||
    wildcardWithoutDot ||
    !host.split('.').every((l) => PROXY_LABEL.test(l))
  ) {
    throw new Error(
      `${driver} runtime: allowedDomains entry ${JSON.stringify(domain)} would be refused by the egress proxy: use a DNS name (labels up to 63 characters), not an IP address, and *.suffix with at least two labels.`,
    );
  }
}

/** The variables of a proxied sandbox. `NO_PROXY` keeps the gateway (and loopback) off the proxy. */
export function egressProxyEnvironment(
  proxyUrl: string,
  bypass: readonly string[],
): Record<string, string> {
  const noProxy = ['localhost', '127.0.0.1', ...bypass].join(',');
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: '1',
  };
}

const MIN_EGRESS_KEY_LENGTH = 32;

/**
 * The per-session credential a sandbox presents to the shared egress proxy on Google Cloud:
 * `<p>.<s>`, `p` = base64url of the JSON claims (keys in the order `sid`, `exp`, `hosts`) and
 * `s` = base64url HMAC-SHA256 of `p`. No padding; the format is the one `packages/egress-proxy`
 * verifies.
 */
export function signEgressCredential(
  key: string,
  claims: Readonly<{ sid: string; exp: number; hosts: readonly string[] }>,
): string {
  if (key.length < MIN_EGRESS_KEY_LENGTH) {
    throw new Error(
      `egress credential key must be at least ${String(MIN_EGRESS_KEY_LENGTH)} characters.`,
    );
  }
  const payload = Buffer.from(
    JSON.stringify({ sid: claims.sid, exp: claims.exp, hosts: claims.hosts }),
    'utf8',
  ).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(key, 'utf8'))
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

/** `proxyUrl` with the credential as userinfo (`aw:<token>`); a URL that has its own is refused. */
export function proxyUrlWithCredential(proxyUrl: string, token: string): string {
  const url = new URL(proxyUrl);
  if (url.protocol !== 'http:') {
    throw new Error('egress proxy URL must use http:.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('egress proxy URL must not already carry credentials.');
  }
  url.username = 'aw';
  url.password = token;
  return url.toString().replace(/\/$/u, '');
}
