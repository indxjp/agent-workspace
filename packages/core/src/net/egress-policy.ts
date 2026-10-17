/**
 * `#127`'s one egress policy: every server-side fetch this platform makes on a caller's behalf —
 * the model-connection probe, model discovery, and every gateway provider adapter — decides
 * whether a URL may be reached through {@link checkEgress}, and (where the caller has not
 * substituted its own transport, which every existing unit test does) issues the request through
 * {@link guardedFetch} rather than a bare `fetch()` call.
 *
 * Default-deny, by resolved address rather than by hostname string, because a hostname is
 * whatever DNS says it is at request time: unspecified, loopback, RFC1918, RFC6598
 * (carrier-grade NAT), link-local (which is where every major cloud's metadata endpoint lives —
 * 169.254.169.254 for AWS/GCP/Azure/DigitalOcean, and RFC6598 space for Alibaba Cloud's
 * 100.100.100.200 — so no
 * separate "metadata address" list is needed once those two ranges are covered), IPv6 unique-local
 * and link-local, `::1`, and the IPv4-mapped IPv6 spelling of any of those. HTTPS is required
 * unless the target is a loopback address reached under a local (non-production) deployment
 * posture (`docs/operations/W9-PROV-127-egress-policy.md` documents the exact variables; contract
 * C2 adds `AW_DEPLOYMENT_POSTURE`), which is what lets the fixture
 * servers this package's own tests spin up on `127.0.0.1` keep working. Redirects are refused,
 * not followed — `guardedFetch` always requests with `redirect: 'error'` — so a compromised or
 * misconfigured upstream cannot retarget a request that already carries a provider credential to
 * a different origin.
 *
 * `checkEgress` resolves the host once and validates every address DNS returned before the
 * request is made. `guardedFetch` goes one step further for a plain-`http:` target reached with
 * the real network transport (never for a caller-supplied test double, and never for `https:`,
 * where substituting a literal address would make TLS validate the upstream's certificate against
 * an IP no certificate lists): it connects to the address it just checked instead of leaving a
 * second, independent lookup to happen mid-flight. That closes the practical DNS-rebinding window
 * between check and connect; it is not the socket-level pinning a custom transport would give
 * every caller unconditionally, which is `docs/adr/W9-PROV-127-*.md`'s gap G-1.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { readDeploymentPosture } from '../posture.js';

/** The exact environment variable name `docs/operations/W9-PROV-127-egress-policy.md` documents. */
export const EGRESS_ALLOW_HOSTS_ENV = 'EGRESS_ALLOW_HOSTS';

export type EgressPolicyConfig = {
  /**
   * The production posture (`readDeploymentPosture(env) === 'production'`, contract C2). Only a
   * non-production (local) posture tolerates a loopback HTTP target.
   */
  readonly production: boolean;
  /** Lower-cased exact hostnames exempted from the default-deny range check, never from HTTPS. */
  readonly allowHosts: readonly string[];
};

export type EgressResolvedAddress = {
  readonly address: string;
  readonly family: 4 | 6;
};

export type EgressAllowed = {
  readonly ok: true;
  readonly url: URL;
  readonly host: string;
  readonly addresses: readonly EgressResolvedAddress[];
};

export type EgressRefused = {
  readonly ok: false;
  /** The hostname only — never the full URL, which may carry query-string secrets. */
  readonly host: string;
  readonly reason: string;
};

export type EgressDecision = EgressAllowed | EgressRefused;

/** {@link checkHostEgress}'s answer for a bare host, such as a TCP target with no URL scheme. */
export type EgressHostDecision =
  | {
      readonly ok: true;
      readonly host: string;
      readonly addresses: readonly EgressResolvedAddress[];
      /** Plaintext is tolerated: a local posture and every address loopback. */
      readonly plaintextAllowed: boolean;
    }
  | EgressRefused;

export type EgressResolver = (hostname: string) => Promise<readonly EgressResolvedAddress[]>;

/**
 * Read the policy from the process environment: the deployment posture (`AW_DEPLOYMENT_POSTURE`,
 * derived from `NODE_ENV` when unset) and `EGRESS_ALLOW_HOSTS`. Throws `DeploymentPostureError`
 * on an invalid posture, or on a `local` posture with a non-loopback HOST.
 */
export function loadEgressPolicyFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EgressPolicyConfig {
  const raw = env[EGRESS_ALLOW_HOSTS_ENV] ?? '';
  const allowHosts = raw
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
  return { production: readDeploymentPosture(env) === 'production', allowHosts };
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

type BlockedCategory = 'unspecified' | 'loopback' | 'private' | 'link-local' | 'unique-local';

type IPv4Bytes = readonly [number, number, number, number];

function ipv4Bytes(address: string): IPv4Bytes | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
  return bytes as unknown as IPv4Bytes;
}

/** RFC1918, RFC6598 (which is also where Alibaba Cloud's metadata address lives) and link-local
 * (which is where every other cloud's metadata address lives), on top of loopback. */
function categorizeIPv4(bytes: IPv4Bytes): BlockedCategory | null {
  const [a, b] = bytes;
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  return null;
}

function embedIPv4AsHexPair(bytes: IPv4Bytes): string {
  const hi = ((bytes[0] << 8) | bytes[1]).toString(16);
  const lo = ((bytes[2] << 8) | bytes[3]).toString(16);
  return `${hi}:${lo}`;
}

/**
 * Expand a textual IPv6 address (`::` shorthand and an optional trailing dotted-quad both
 * handled) into its 16 bytes, or `null` if it is not well-formed.
 */
function ipv6ToBytes(input: string): Uint8Array | null {
  let address = input;
  const lastColon = address.lastIndexOf(':');
  if (lastColon === -1) return null;
  const tail = address.slice(lastColon + 1);
  if (tail.includes('.')) {
    const embedded = ipv4Bytes(tail);
    if (embedded === null) return null;
    address = address.slice(0, lastColon + 1) + embedIPv4AsHexPair(embedded);
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const first = halves[0] ?? '';
  const second = halves[1] ?? '';
  const head = first === '' ? [] : first.split(':');
  const tailGroups = halves.length === 2 ? (second === '' ? [] : second.split(':')) : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tailGroups.length;
    if (missing < 0) return null;
    groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tailGroups];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    if (group.length === 0 || group.length > 4) return null;
    const value = Number.parseInt(group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    bytes[index * 2] = (value >> 8) & 0xff;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

const NAT64_PREFIX = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0] as const;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

/**
 * The IPv4 address an IPv6 address carries and a network may route to: IPv4-mapped
 * `::ffff:a.b.c.d`, IPv4-compatible `::a.b.c.d`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16`.
 */
function embeddedIPv4(bytes: Uint8Array): IPv4Bytes | null {
  const at = (offset: number): IPv4Bytes => [
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  ];
  const zeros = new Array<number>(10).fill(0);
  if (startsWith(bytes, [...zeros, 0xff, 0xff])) return at(12);
  if (startsWith(bytes, [...zeros, 0, 0]) || startsWith(bytes, NAT64_PREFIX)) return at(12);
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return at(2);
  return null;
}

/** `fc00::/7` unique-local, `fe80::/10` link-local, `::1`, `::`, and any IPv6 form that embeds
 * an IPv4-blocked address ({@link embeddedIPv4}). */
function categorizeIPv6(bytes: Uint8Array): BlockedCategory | null {
  const isUnspecified = bytes.every((byte) => byte === 0);
  if (isUnspecified) return 'unspecified';
  const isLoopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  if (isLoopback) return 'loopback';
  const embedded = embeddedIPv4(bytes);
  if (embedded !== null) return categorizeIPv4(embedded);
  const first = bytes[0] ?? 0;
  if ((first & 0xfe) === 0xfc) return 'unique-local';
  if (first === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return 'link-local';
  return null;
}

function categorizeAddress(address: EgressResolvedAddress): BlockedCategory | null {
  if (address.family === 4) {
    const bytes = ipv4Bytes(address.address);
    return bytes === null ? null : categorizeIPv4(bytes);
  }
  const bytes = ipv6ToBytes(address.address);
  return bytes === null ? null : categorizeIPv6(bytes);
}

async function defaultResolve(hostname: string): Promise<EgressResolvedAddress[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({
    address: record.address,
    family: record.family === 6 ? 6 : 4,
  }));
}

const DNS_FAILED_REASON = 'DNS resolution failed.';
/** `EAI_AGAIN`: the resolver could not answer right now (typical of WSL waking). Not a DNS failure
 * in the {@link EgressRefusedError.dnsFailed} sense, so a caller treats it as transient. */
const DNS_TEMPORARY_REASON = 'DNS resolution temporarily failed.';

function isTemporaryDnsFailure(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'EAI_AGAIN'
  );
}

/** What {@link guardedFetch} throws for a request the policy refused. `dnsFailed` tells a host
 * whose name did not resolve (the provider cannot be reached from here at all) apart from a refusal
 * by rule, without matching on the message text. */
export class EgressRefusedError extends Error {
  constructor(
    message: string,
    readonly dnsFailed: boolean,
  ) {
    super(message);
    this.name = 'EgressRefusedError';
  }
}

function refuse(host: string, reason: string): EgressRefused {
  return { ok: false, host, reason };
}

/**
 * The address half of the policy, for a host reached without a URL (a TCP connection such as a
 * PostgreSQL tool connector's). Resolves `host` once (unless it is already a literal address, with
 * or without IPv6 brackets) and checks **every** address the resolver returned, so a multi-answer
 * record cannot hide one unsafe target behind a safe one. Never throws: a failed lookup comes back
 * as a refusal. The caller connects to one of `addresses`, never to the name, so no second lookup
 * can rebind it.
 */
export async function checkHostEgress(
  host: string,
  policy: EgressPolicyConfig,
  resolve: EgressResolver = defaultResolve,
): Promise<EgressHostDecision> {
  const literalHost = stripBrackets(host);
  const ipFamily = isIP(literalHost);
  let addresses: EgressResolvedAddress[];
  if (ipFamily !== 0) {
    addresses = [{ address: literalHost, family: ipFamily as 4 | 6 }];
  } else {
    try {
      addresses = [...(await resolve(literalHost))];
    } catch (error) {
      return refuse(host, isTemporaryDnsFailure(error) ? DNS_TEMPORARY_REASON : DNS_FAILED_REASON);
    }
    if (addresses.length === 0) return refuse(host, 'DNS resolution returned no addresses.');
  }

  const explicitlyAllowed = policy.allowHosts.includes(literalHost.toLowerCase());
  const categories = addresses.map((address) => categorizeAddress(address));

  if (!explicitlyAllowed) {
    for (const category of categories) {
      if (category === null) continue;
      const devLoopbackException = category === 'loopback' && !policy.production;
      if (!devLoopbackException) {
        const article = category === 'unspecified' ? 'an' : 'a';
        return refuse(
          host,
          `Target resolves to ${article} ${category} address, refused by policy.`,
        );
      }
    }
  }

  const allLoopback = categories.length > 0 && categories.every((c) => c === 'loopback');
  return {
    ok: true,
    host: literalHost,
    addresses,
    plaintextAllowed: !policy.production && allLoopback,
  };
}

/**
 * Decide whether `rawUrl` may be reached from this process: {@link checkHostEgress} on its host,
 * plus HTTPS unless plaintext is tolerated. Never throws: a malformed URL or a failed lookup comes
 * back as a refusal like any other. The refusal `reason` never repeats the query string or
 * `userinfo` — only the hostname and the rule that fired.
 */
export async function checkEgress(
  rawUrl: string,
  policy: EgressPolicyConfig,
  resolve: EgressResolver = defaultResolve,
): Promise<EgressDecision> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return refuse('(unparseable)', 'The URL could not be parsed.');
  }
  const host = url.hostname;
  if (url.username !== '' || url.password !== '') {
    return refuse(host, 'URL userinfo is not permitted.');
  }
  const decision = await checkHostEgress(host, policy, resolve);
  if (!decision.ok) return decision;
  if (url.protocol !== 'https:' && !decision.plaintextAllowed) {
    return refuse(host, 'HTTPS is required.');
  }
  return { ok: true, url, host: decision.host, addresses: decision.addresses };
}

/** For an `http:` target reached with the real transport, connect to the address just checked
 * instead of leaving a second lookup to run during the request. Left untouched for `https:`
 * (substituting a literal address would break certificate hostname validation against every real
 * provider) and for a caller-supplied transport (there is no wire request left to pin — a test
 * double receives whatever URL it asked to observe). */
function pinnedTarget(decision: EgressAllowed): string {
  if (decision.url.protocol !== 'http:') return decision.url.toString();
  const address = decision.addresses[0];
  if (address === undefined) return decision.url.toString();
  const pinned = new URL(decision.url.toString());
  pinned.hostname = address.family === 6 ? `[${address.address}]` : address.address;
  return pinned.toString();
}

/**
 * The one call site every probe and every gateway provider adapter routes an outbound request
 * through. Refuses (throws, with a redacted message) anything {@link checkEgress} refuses, then
 * issues the request with `redirect: 'error'` so a redirect is refused rather than followed.
 *
 * `transport` is compared against the real global `fetch` by reference, not merely checked for
 * being provided: every existing provider test supplies its own `fetch` double and asserts the
 * exact URL string it was called with, so pinning only ever applies to the real network path.
 */
export async function guardedFetch(
  rawUrl: string,
  init: RequestInit,
  policy: EgressPolicyConfig,
  transport: typeof fetch = fetch,
  resolve: EgressResolver = defaultResolve,
): Promise<Response> {
  const decision = await checkEgress(rawUrl, policy, resolve);
  if (!decision.ok) {
    throw new EgressRefusedError(
      `Egress policy refused a request to ${decision.host}: ${decision.reason}`,
      decision.reason === DNS_FAILED_REASON,
    );
  }
  if (transport !== fetch) {
    return transport(rawUrl, { ...init, redirect: 'error' });
  }
  return fetch(pinnedTarget(decision), { ...init, redirect: 'error' });
}
