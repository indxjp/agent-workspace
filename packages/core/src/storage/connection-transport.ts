/**
 * How a storage connection's client reaches its endpoint, decided by `connection-store.ts` after
 * the endpoint passed the egress check: on sockets pinned to the addresses that check saw, or
 * through the deployment's outbound proxy, which then resolves the name itself (so the pinning is
 * the proxy's, and the check before it still applies).
 */
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

import { HttpsProxyAgent } from 'https-proxy-agent';

export type ConnectionTransport =
  | {
      readonly kind: 'pinned';
      /** Answers every hostname with the checked addresses, never a new query. */
      readonly lookup: LookupFunction;
    }
  | {
      readonly kind: 'proxy';
      /** The `http:` or `https:` proxy every request is tunnelled through with `CONNECT`. */
      readonly proxyUrl: string;
    };

interface ConnectionAgents {
  readonly http: http.Agent;
  /** For an `https:` target; an `HttpsProxyAgent` upgrades its tunnel to TLS itself. */
  readonly https: http.Agent;
}

/**
 * The agents a client sends every request with. A proxy tunnels a plaintext target with `CONNECT`
 * too, so no request line or header of either kind is ever readable by the proxy.
 */
export function connectionAgents(
  transport: ConnectionTransport,
  options: Pick<http.AgentOptions, 'maxSockets'> = {},
): ConnectionAgents {
  if (transport.kind === 'pinned') {
    return {
      http: new http.Agent({ keepAlive: true, ...options, lookup: transport.lookup }),
      https: new https.Agent({ keepAlive: true, ...options, lookup: transport.lookup }),
    };
  }
  return {
    http: new HttpsProxyAgent(transport.proxyUrl, { keepAlive: true, ...options }),
    https: new HttpsProxyAgent(transport.proxyUrl, { keepAlive: true, ...options }),
  };
}
