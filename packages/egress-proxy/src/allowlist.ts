import { isIP } from 'node:net';

export interface Allowlist {
  /** `*`: any host, still subject to the address policy. This is the `open` network policy. */
  readonly anyHost: boolean;
  readonly exact: ReadonlySet<string>;
  /** `*.example.com` entries, stored as `.example.com`: strict subdomains, never the apex. */
  readonly suffixes: readonly string[];
}

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/u;
const MAX_HOST_LENGTH = 253;

/**
 * The comparable form of a host: lower case, no trailing dot, no IPv6 brackets. Returns null for
 * anything that is neither an IP address nor an ASCII DNS name (internationalised names must
 * arrive as punycode), so a malformed or ambiguous host is never matched or resolved.
 */
export function normalizeHost(raw: string): string | null {
  let host = raw.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  else if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '' || host.length > MAX_HOST_LENGTH) return null;
  if (isIP(host) !== 0) return host;
  return host.split('.').every((label) => LABEL.test(label)) ? host : null;
}

export class AllowlistError extends Error {
  override readonly name = 'AllowlistError';
}

/** Parses `example.com`, `*.example.com` and `*`. IP addresses and other wildcards are refused. */
export function parseAllowlist(entries: readonly string[]): Allowlist {
  let anyHost = false;
  const exact = new Set<string>();
  const suffixes: string[] = [];
  for (const entry of entries) {
    if (entry === '*') {
      anyHost = true;
      continue;
    }
    const wildcard = entry.startsWith('*.');
    const host = normalizeHost(wildcard ? entry.slice(2) : entry);
    if (host === null || isIP(host) !== 0 || (wildcard && !host.includes('.'))) {
      throw new AllowlistError(
        `allowlist entry ${JSON.stringify(entry)} must be a host name, *.suffix with at least two labels, or *`,
      );
    }
    if (wildcard) suffixes.push(`.${host}`);
    else exact.add(host);
  }
  if (!anyHost && exact.size === 0 && suffixes.length === 0) {
    throw new AllowlistError('the allowlist is empty; use * to allow every public host');
  }
  return { anyHost, exact, suffixes };
}

/** @param host a value already returned by {@link normalizeHost} */
export function isHostAllowed(allowlist: Allowlist, host: string): boolean {
  return (
    allowlist.anyHost ||
    allowlist.exact.has(host) ||
    allowlist.suffixes.some((suffix) => host.endsWith(suffix))
  );
}
