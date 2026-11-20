import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { classifyAddress, type DeniedAddressReason } from './address.js';
import { isHostAllowed, normalizeHost, type Allowlist } from './allowlist.js';
import { verifyCredential, type CredentialRefusal } from './credential.js';

export type DenialReason =
  | DeniedAddressReason
  | 'host_not_allowed'
  | 'port_not_allowed'
  | 'resolves_to_denied_address'
  | 'resolution_failed'
  | 'bad_request'
  | CredentialRefusal;

interface CommonOptions {
  /** Ports a sandbox may reach on an allowed host. Defaults to 80 and 443. */
  readonly allowedPorts?: readonly number[];
  /** Every address `host` resolves to. Called at most once per request. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  /** Opens the upstream connection to an already-checked address. */
  readonly dial?: (address: string, port: number) => Socket;
  /** Receives one JSON line per denial. Defaults to standard output. */
  readonly writeLog?: (line: string) => void;
}

/** One proxy per session: the allowlist is fixed at start. */
interface SessionProxyOptions extends CommonOptions {
  readonly sessionId: string;
  readonly allowlist: Allowlist;
}

/** One proxy for every session: each request carries a credential signed with this key. */
interface SharedProxyOptions extends CommonOptions {
  readonly credentialKey: Buffer;
  /** Unix seconds; defaults to the wall clock. */
  readonly now?: () => number;
}

export type EgressProxyOptions = SessionProxyOptions | SharedProxyOptions;

type Principal =
  | { readonly ok: true; readonly sid: string; readonly allowlist: Allowlist }
  | { readonly ok: false; readonly reason: CredentialRefusal };

type Decision =
  | { readonly allowed: true; readonly address: string }
  | { readonly allowed: false; readonly reason: DenialReason };

export const DEFAULT_PORTS: readonly number[] = [80, 443];
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
  credential_required: 407,
  credential_invalid: 407,
  credential_expired: 407,
};
const PROXY_AUTHENTICATE = 'Basic realm="aw-egress"';

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

/** The resolved options and collaborators every request handler shares. */
interface ProxyRuntime {
  readonly allowedPorts: readonly number[];
  readonly resolve: (host: string) => Promise<readonly string[]>;
  readonly dial: (address: string, port: number) => Socket;
  readonly writeLog: (line: string) => void;
  readonly authenticate: (req: http.IncomingMessage) => Principal;
}

/** A request that passed authentication and names a host and port to reach. */
interface EgressRequest {
  readonly principal: Principal & { readonly ok: true };
  readonly rawHost: string;
  readonly port: number;
}

const UPSTREAM_UNAVAILABLE = JSON.stringify({ error: 'upstream_unavailable' });

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

async function resolveChecked(runtime: ProxyRuntime, host: string): Promise<Decision> {
  let addresses: readonly string[];
  try {
    addresses = await runtime.resolve(host);
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

async function decide(
  runtime: ProxyRuntime,
  allowlist: Allowlist,
  rawHost: string,
  port: number,
): Promise<Decision> {
  const host = normalizeHost(rawHost);
  if (host === null || !isValidPort(port)) return { allowed: false, reason: 'bad_request' };
  if (!runtime.allowedPorts.includes(port)) return { allowed: false, reason: 'port_not_allowed' };
  const literal = isIP(host) !== 0;
  if (literal) {
    const reason = classifyAddress(host);
    if (reason !== null) return { allowed: false, reason };
  }
  if (!isHostAllowed(allowlist, host)) return { allowed: false, reason: 'host_not_allowed' };
  if (literal) return { allowed: true, address: host };
  return resolveChecked(runtime, host);
}

/** Who is asking: the configured session, or the session the signed credential names. */
function authenticatorFor(options: EgressProxyOptions): (req: http.IncomingMessage) => Principal {
  if ('credentialKey' in options) {
    const { credentialKey, now } = options;
    return (req) =>
      verifyCredential(
        req.headers['proxy-authorization'],
        credentialKey,
        now?.() ?? Math.floor(Date.now() / 1000),
      );
  }
  const principal: Principal = { ok: true, sid: options.sessionId, allowlist: options.allowlist };
  return () => principal;
}

/** Logs the denial and returns the JSON body to send back. */
function denialBody(
  runtime: ProxyRuntime,
  sid: string | null,
  host: string | null,
  port: number | null,
  reason: DenialReason,
): string {
  runtime.writeLog(JSON.stringify({ event: 'egress_denied', sessionId: sid, host, port, reason }));
  return JSON.stringify({ error: 'egress_denied', reason });
}

/** Parses an absolute-form `http:` request target, or returns null when it is anything else. */
function parseForwardTarget(requestUrl: string): URL | null {
  if (requestUrl.startsWith('/')) return null;
  try {
    const target = new URL(requestUrl);
    return target.protocol === 'http:' ? target : null;
  } catch {
    return null;
  }
}

function forward(runtime: ProxyRuntime, req: http.IncomingMessage, res: http.ServerResponse): void {
  const requestUrl = req.url ?? '';
  if (req.method === 'GET' && requestUrl === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  const principal = runtime.authenticate(req);
  if (!principal.ok) {
    respond(res, 407, denialBody(runtime, null, null, null, principal.reason), {
      'proxy-authenticate': PROXY_AUTHENTICATE,
    });
    return;
  }
  const target = parseForwardTarget(requestUrl);
  if (target === null) {
    respond(res, 400, denialBody(runtime, principal.sid, null, null, 'bad_request'));
    return;
  }
  const port = target.port === '' ? 80 : Number(target.port);
  void decide(runtime, principal.allowlist, target.hostname, port).then(
    (decision) => {
      if (!decision.allowed) {
        const host = normalizeHost(target.hostname);
        const body = denialBody(runtime, principal.sid, host, port, decision.reason);
        respond(res, STATUS[decision.reason], body);
        return;
      }
      relay(runtime, { req, res, target, port, address: decision.address });
    },
    () => respond(res, 502, UPSTREAM_UNAVAILABLE),
  );
}

interface RelayRequest {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly target: URL;
  readonly port: number;
  readonly address: string;
}

function relay(runtime: ProxyRuntime, { req, res, target, port, address }: RelayRequest): void {
  const upstream = http.request({
    method: req.method,
    host: address,
    port,
    path: `${target.pathname}${target.search}`,
    // The client's Host header is never trusted to name a different site than the one checked.
    headers: { ...withoutHopByHop(req.headers), host: target.host },
    timeout: IDLE_TIMEOUT_MS,
    createConnection: () => runtime.dial(address, port),
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
    else respond(res, 502, UPSTREAM_UNAVAILABLE);
  };
  upstream.on('error', fail);
  upstream.on('timeout', fail);
  req.on('error', () => upstream.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

/** Writes a complete HTTP/1.1 refusal to a CONNECT client and closes the socket. */
function refuseConnect(client: Duplex, status: number, body: string, extraHeaders = ''): void {
  client.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\n${extraHeaders}` +
      `content-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n` +
      `connection: close\r\n\r\n${body}`,
  );
}

/** Authenticates a CONNECT request and parses its authority; refuses the client on failure. */
function readConnectRequest(
  runtime: ProxyRuntime,
  req: http.IncomingMessage,
  client: Duplex,
): EgressRequest | null {
  const principal = runtime.authenticate(req);
  if (!principal.ok) {
    refuseConnect(
      client,
      407,
      denialBody(runtime, null, null, null, principal.reason),
      `proxy-authenticate: ${PROXY_AUTHENTICATE}\r\n`,
    );
    return null;
  }
  const match = CONNECT_AUTHORITY.exec(req.url ?? '');
  if (match === null) {
    refuseConnect(client, 400, denialBody(runtime, principal.sid, null, null, 'bad_request'));
    return null;
  }
  return { principal, rawHost: match[1] ?? match[2] ?? '', port: Number(match[3]) };
}

/** Joins the client to the checked upstream address, answering 200 once the upstream connects. */
function openTunnel(
  runtime: ProxyRuntime,
  client: Duplex,
  head: Buffer,
  target: { readonly address: string; readonly port: number },
): void {
  const upstream = runtime.dial(target.address, target.port);
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
    refuseConnect(client, 502, UPSTREAM_UNAVAILABLE);
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
}

function tunnel(
  runtime: ProxyRuntime,
  req: http.IncomingMessage,
  client: Duplex,
  head: Buffer,
): void {
  client.on('error', () => client.destroy());
  const request = readConnectRequest(runtime, req, client);
  if (request === null) return;
  const { principal, rawHost, port } = request;
  // The server keeps half-open sockets, so a sandbox that drops the CONNECT while the name is
  // resolving only shows up as 'end'; it must not be given an upstream connection.
  const abandon = (): void => {
    client.destroy();
  };
  client.once('end', abandon);
  void decide(runtime, principal.allowlist, rawHost, port).then(
    (decision) => {
      client.off('end', abandon);
      if (!decision.allowed) {
        const body = denialBody(
          runtime,
          principal.sid,
          normalizeHost(rawHost),
          port,
          decision.reason,
        );
        refuseConnect(client, STATUS[decision.reason], body);
        return;
      }
      if (client.destroyed) return;
      openTunnel(runtime, client, head, { address: decision.address, port });
    },
    () => refuseConnect(client, 502, UPSTREAM_UNAVAILABLE),
  );
}

/**
 * One HTTP forward + CONNECT proxy for one sandbox session, or for all of them when each request
 * carries a signed credential (docs/adr/0117).
 *
 * The decision is made once per request: the host is normalised, checked against the port list and
 * the allowlist, resolved once, and every resolved address must be public. The upstream connection
 * goes to that checked address and never to the name, so there is no second DNS answer to rebind.
 * TLS is not inspected: the allowlist matches the CONNECT authority, not the SNI.
 */
export function createEgressProxy(options: EgressProxyOptions): http.Server {
  const runtime: ProxyRuntime = {
    allowedPorts: options.allowedPorts ?? DEFAULT_PORTS,
    resolve: options.resolve ?? defaultResolve,
    dial: options.dial ?? defaultDial,
    writeLog: options.writeLog ?? ((line: string) => process.stdout.write(`${line}\n`)),
    authenticate: authenticatorFor(options),
  };
  const server = http.createServer((req, res) => forward(runtime, req, res));
  server.on('connect', (req: http.IncomingMessage, client: Duplex, head: Buffer) =>
    tunnel(runtime, req, client, head),
  );
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}

function respond(
  res: http.ServerResponse,
  status: number,
  body: string,
  headers: http.OutgoingHttpHeaders = {},
): void {
  res
    .writeHead(status, { 'content-type': 'application/json', connection: 'close', ...headers })
    .end(body);
}
