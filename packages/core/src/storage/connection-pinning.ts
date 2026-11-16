/**
 * Which `ConnectionTransport` an endpoint that passed the egress check gets: sockets pinned to the
 * addresses the check saw, or the outbound proxy that applies to it. Kept apart from
 * `connection-transport.ts`, which builds the agents with `https-proxy-agent`, so the storage
 * barrel reaching `connection-store.ts` loads no proxy library.
 */
import type { LookupFunction } from 'node:net';

import type { EgressResolvedAddress } from '../net/egress-policy.js';
import { outboundProxyFor, type OutboundProxyConfig } from '../net/outbound-proxy.js';
import type { ConnectionTransport } from './connection-transport.js';

/**
 * A `lookup` that answers every hostname with the addresses that were checked, never a new query.
 * A request for one address family (Happy Eyeballs asks for 4 and 6 separately) is answered only
 * from that family, and with `ENOTFOUND` when none was checked.
 */
export function pinnedLookup(addresses: readonly EgressResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = familyOf(options.family);
    const answers =
      family === undefined ? addresses : addresses.filter((address) => address.family === family);
    const [first] = answers;
    if (first === undefined) {
      callback(Object.assign(new Error('no checked address'), { code: 'ENOTFOUND' }), '', 0);
    } else if (options.all === true) {
      callback(null, [...answers], undefined);
    } else {
      callback(null, first.address, first.family);
    }
  };
}

/** The address family a lookup asks for; 0 and an absent family mean either. */
function familyOf(family: number | 'IPv4' | 'IPv6' | undefined): 4 | 6 | undefined {
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  return undefined;
}

/** Through the proxy that applies to `target`, else on sockets pinned to the checked `addresses`. */
export function transportFor(
  target: URL,
  addresses: readonly EgressResolvedAddress[],
  proxy: OutboundProxyConfig | undefined,
): ConnectionTransport {
  const proxyUrl = proxy === undefined ? null : outboundProxyFor(target, proxy);
  return proxyUrl === null
    ? { kind: 'pinned', lookup: pinnedLookup(addresses) }
    : { kind: 'proxy', proxyUrl };
}
