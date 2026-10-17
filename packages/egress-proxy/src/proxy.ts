import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { classifyAddress, type DeniedAddressReason } from './address.js';
import { isHostAllowed, normalizeHost, type Allowlist } from './allowlist.js';

export type DenialReason =
  | DeniedAddressReason
  | 'host_not_allowed'
  | 'port_not_allowed'
  | 'resolves_to_denied_address'
  | 'resolution_failed'
  | 'bad_request';

export interface EgressProxyOptions {
  readonly sessionId: string;
  readonly allowlist: Allowlist;
  /** Ports a sandbox may reach on an allowed host. Defaults to 80 and 443. */
  readonly allowedPorts?: readonly number[];
  /** Every address `host` resolves to. Called at most once per request. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  /** Opens the upstream connection to an already-checked address. */
  readonly dial?: (address: string, port: number) => Socket;
  /** Receives one JSON line per denial. Defaults to standard output. */
  readonly writeLog?: (line: string) => void;
}

type Decision =
  | { readonly allowed: true; readonly address: string }
  | { readonly allowed: false; readonly reason: DenialReason };

const DEFAULT_PORTS: readonly number[] = [80, 443];
const IDLE_TIMEOUT_MS = 120_000;
const HEADERS_TIMEOUT_MS = 15_000;
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
const CONNECT_AUTHORITY = /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]/@?#\s]+)):(\d{1,5})$/u;

const STATUS: Readonly<Record<DenialReason, number>> = {
  address_loopback: 403,
  address_private: 403,
  address_link_local: 403,
  address_unique_local: 403,
  address_reserved: 403,
  host_not_allowed: 403,
  port_not_allowed: 403,
  resolves_to_denied_address: 403,
  resolution_failed: 502,
  bad_request: 400,
};

async function defaultResolve(host: string): Promise<readonly string[]> {
  const records = await dnsLookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function defaultDial(address: string, port: number): Socket {
  return connect({ host: address, port });
}

function withoutHopByHop(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const named = String(headers['connection'] ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase());
  const forwarded: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.includes(name) && !named.includes(name)) forwarded[name] = value;
  }
  return forwarded;
}

/**
 * One HTTP forward + CONNECT proxy for one sandbox session (docs/adr/0117).
 *
 * The decision is made once per request: the host is normalised, checked against the port list and
 * the allowlist, resolved once, and every resolved address must be public. The upstream connection
 * goes to that checked address and never to the name, so there is no second DNS answer to rebind.
 * TLS is not inspected: the allowlist matches the CONNECT authority, not the SNI.
 */
export function createEgressProxy(options: EgressProxyOptions): http.Server {
  const allowedPorts = options.allowedPorts ?? DEFAULT_PORTS;
  const resolve = options.resolve ?? defaultResolve;
  const dial = options.dial ?? defaultDial;
  const writeLog = options.writeLog ?? ((line: string) => process.stdout.write(`${line}\n`));

  async function decide(rawHost: string, port: number): Promise<Decision> {
    const host = normalizeHost(rawHost);
    if (host === null || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { allowed: false, reason: 'bad_request' };
    }
    if (!allowedPorts.includes(port)) return { allowed: false, reason: 'port_not_allowed' };
    const literal = isIP(host) !== 0;
    if (literal) {
      const reason = classifyAddress(host);
      if (reason !== null) return { allowed: false, reason };
    }
    if (!isHostAllowed(options.allowlist, host))
      return { allowed: false, reason: 'host_not_allowed' };
    if (literal) return { allowed: true, address: host };
    let addresses: readonly string[];
    try {
      addresses = await resolve(host);
    } catch {
      return { allowed: false, reason: 'resolution_failed' };
    }
    const [address] = addresses;
    if (address === undefined) return { allowed: false, reason: 'resolution_failed' };
    if (addresses.some((candidate) => classifyAddress(candidate) !== null)) {
      return { allowed: false, reason: 'resolves_to_denied_address' };
    }
    return { allowed: true, address };
  }

  function logDenial(host: string | null, port: number | null, reason: DenialReason): void {
    writeLog(
      JSON.stringify({ event: 'egress_denied', sessionId: options.sessionId, host, port, reason }),
    );
  }

  function deny(host: string | null, port: number | null, reason: DenialReason): string {
    logDenial(host, port, reason);
    return JSON.stringify({ error: 'egress_denied', reason });
  }

  function forward(req: http.IncomingMessage, res: http.ServerResponse): void {
    const requestUrl = req.url ?? '';
    if (requestUrl.startsWith('/')) {
      if (req.method === 'GET' && requestUrl === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
      }
      respond(res, 400, deny(null, null, 'bad_request'));
      return;
    }
    let target: URL;
    try {
      target = new URL(requestUrl);
    } catch {
      respond(res, 400, deny(null, null, 'bad_request'));
      return;
    }
    if (target.protocol !== 'http:') {
      respond(res, 400, deny(null, null, 'bad_request'));
      return;
    }
    const port = target.port === '' ? 80 : Number(target.port);
    void decide(target.hostname, port).then(
      (decision) => {
        if (!decision.allowed) {
          const host = normalizeHost(target.hostname);
          respond(res, STATUS[decision.reason], deny(host, port, decision.reason));
          return;
        }
        relay(req, res, target, port, decision.address);
      },
      () => respond(res, 502, JSON.stringify({ error: 'upstream_unavailable' })),
    );
  }

  function relay(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: URL,
    port: number,
    address: string,
  ): void {
    const upstream = http.request({
      method: req.method,
      host: address,
      port,
      path: `${target.pathname}${target.search}`,
      // The client's Host header is never trusted to name a different site than the one checked.
      headers: { ...withoutHopByHop(req.headers), host: target.host },
      timeout: IDLE_TIMEOUT_MS,
      createConnection: () => dial(address, port),
    });
    upstream.on('response', (response) => {
      res.writeHead(
        response.statusCode ?? 502,
        response.statusMessage,
        withoutHopByHop(response.headers),
      );
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    const fail = (): void => {
      upstream.destroy();
      if (res.headersSent) res.destroy();
      else respond(res, 502, JSON.stringify({ error: 'upstream_unavailable' }));
    };
    upstream.on('error', fail);
    upstream.on('timeout', fail);
    req.on('error', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }

  function tunnel(req: http.IncomingMessage, client: Duplex, head: Buffer): void {
    client.on('error', () => client.destroy());
    const refuse = (status: number, body: string): void => {
      client.end(
        `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\n` +
          `content-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n` +
          `connection: close\r\n\r\n${body}`,
      );
    };
    const match = CONNECT_AUTHORITY.exec(req.url ?? '');
    if (match === null) {
      refuse(400, deny(null, null, 'bad_request'));
      return;
    }
    const rawHost = match[1] ?? match[2] ?? '';
    const port = Number(match[3]);
    // The server keeps half-open sockets, so a sandbox that drops the CONNECT while the name is
    // resolving only shows up as 'end'; it must not be given an upstream connection.
    const abandon = (): void => {
      client.destroy();
    };
    client.once('end', abandon);
    void decide(rawHost, port).then(
      (decision) => {
        client.off('end', abandon);
        if (!decision.allowed) {
          refuse(STATUS[decision.reason], deny(normalizeHost(rawHost), port, decision.reason));
          return;
        }
        if (client.destroyed) return;
        const upstream = dial(decision.address, port);
        let established = false;
        const close = (): void => {
          upstream.destroy();
          client.destroy();
        };
        upstream.on('error', () => {
          if (established) {
            close();
            return;
          }
          upstream.destroy();
          refuse(502, JSON.stringify({ error: 'upstream_unavailable' }));
        });
        upstream.setTimeout(IDLE_TIMEOUT_MS, close);
        upstream.once('connect', () => {
          established = true;
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length > 0) upstream.write(head);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        client.on('close', close);
        upstream.on('close', close);
      },
      () => refuse(502, JSON.stringify({ error: 'upstream_unavailable' })),
    );
  }

  const server = http.createServer(forward);
  server.on('connect', tunnel);
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}

function respond(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }).end(body);
}
