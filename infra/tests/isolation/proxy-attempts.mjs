/**
 * The attempts a sandbox makes through the shared egress proxy, which it reaches at a private address
 * with a proxy URL the runner manager minted: an absolute-URI forward request and a CONNECT tunnel
 * with an optional TLS handshake. Nothing here judges an attempt (see proxy-evaluation.mjs), and no
 * attempt throws.
 */
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';

import { MAX_BODY_BYTES, TIMEOUT_MS, requestAttempt } from './attempts.mjs';

const PROXY_DEFAULT_PORT = 3128;

/** @typedef {import('./proxy-evaluation.mjs').ProxyAttempt} ProxyAttempt */

/**
 * The proxy's address and credentials out of a proxy URL. Pure. It throws a message that never echoes
 * the URL.
 *
 * @param {string} proxyUrl
 * @returns {{ host: string; port: number; credentials?: string }}
 */
export function parseProxyUrl(proxyUrl) {
  let url;
  try {
    url = new URL(proxyUrl);
  } catch {
    throw new Error('ISOLATION_PROXY_URL is not a valid URL');
  }
  const credentials =
    url.username === '' && url.password === ''
      ? undefined
      : `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return {
    host: url.hostname,
    port: Number(url.port || PROXY_DEFAULT_PORT),
    ...(credentials === undefined ? {} : { credentials }),
  };
}

/**
 * The same credentials with the first signature character changed (a forged signature). A middle
 * character carries all six data bits, unlike the last, whose unused low bits decode away. Pure.
 */
export function forgeCredentials(credentials) {
  if (credentials === undefined || credentials === '') return 'aw:forged';
  const at = Math.max(credentials.indexOf(':'), credentials.lastIndexOf('.')) + 1;
  const char = credentials.charAt(at);
  return `${credentials.slice(0, at)}${char === 'A' ? 'B' : 'A'}${credentials.slice(at + 1)}`;
}

const proxyAuthorization = (credentials) =>
  credentials === undefined
    ? {}
    : { 'Proxy-Authorization': `Basic ${Buffer.from(credentials).toString('base64')}` };

/**
 * An absolute-URI forward request through the proxy. Never throws.
 *
 * @param {{ host: string; port: number; credentials?: string }} proxy @param {string} targetUrl
 * @returns {Promise<ProxyAttempt>}
 */
export function proxyForward(proxy, targetUrl, headers = {}) {
  return requestAttempt(
    httpRequest,
    {
      host: proxy.host,
      port: proxy.port,
      method: 'GET',
      path: targetUrl,
      headers: {
        Host: new URL(targetUrl).host,
        ...proxyAuthorization(proxy.credentials),
        ...headers,
      },
    },
    undefined,
    { readBody: true },
  );
}

/** A completed TLS handshake with the target over an open tunnel; the certificate is not under test. */
function handshakeThroughTunnel(tunnel, servername, finish) {
  const secure = tlsConnect({ socket: tunnel, servername, rejectUnauthorized: false });
  secure.once('secureConnect', () => finish({ tls: true }));
  secure.once('error', (error) =>
    finish({ tls: false, code: error.code, error: 'TLS handshake failed' }),
  );
}

/** A refusal carries its JSON body on the tunnel socket: read it up to its Content-Length. */
function readRefusalBody({ headers, tunnel, head, chunks }, settle) {
  const expected = Number(headers['content-length'] ?? Number.NaN);
  let size = head.length;
  chunks.push(head);
  if (size >= expected) {
    settle();
    return;
  }
  tunnel.on('data', (chunk) => {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    if (size >= expected) settle();
  });
  tunnel.once('end', settle);
  tunnel.once('close', settle);
  tunnel.once('error', settle);
}

/**
 * A CONNECT tunnel to `authority` (host:port) through the proxy. With `tlsServername` a 200 tunnel is
 * followed by a TLS handshake with the target, which is only checked for completing (the certificate is
 * not what is under test). Never throws.
 *
 * @param {{ host: string; port: number; credentials?: string }} proxy @param {string} authority
 * @returns {Promise<ProxyAttempt>}
 */
export function proxyConnect(
  proxy,
  authority,
  { tlsServername = undefined, timeoutMs = TIMEOUT_MS } = {},
) {
  return new Promise((resolve) => {
    let connected = false;
    let timedOut = false;
    let settled = false;
    let status;
    let socket;
    const chunks = [];
    const bodyText = () => Buffer.concat(chunks).toString('utf8');
    const finish = (attempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      req.destroy();
      resolve({ connected, timedOut, ...(status === undefined ? {} : { status }), ...attempt });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      finish(status === undefined ? { error: 'timed out' } : { body: bodyText() });
    }, timeoutMs);
    const req = httpRequest({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers: { Host: authority, ...proxyAuthorization(proxy.credentials) },
      agent: false,
    });
    req.once('socket', (opened) => {
      opened.once('connect', () => {
        connected = true;
      });
    });
    req.once('error', (error) => finish({ code: error.code, error: error.message }));
    req.once('connect', (res, tunnel, head) => {
      socket = tunnel;
      status = res.statusCode;
      if (status !== 200) {
        readRefusalBody({ headers: res.headers, tunnel, head, chunks }, () =>
          finish({ body: bodyText() }),
        );
      } else if (tlsServername === undefined) {
        finish({});
      } else {
        handshakeThroughTunnel(tunnel, tlsServername, finish);
      }
    });
    req.end();
  });
}

/** Run named probes in parallel (each silent one waits the full timeout) and keep their names. */
export async function settleAll(probes) {
  const names = Object.keys(probes);
  const settled = await Promise.all(Object.values(probes));
  return Object.fromEntries(names.map((name, index) => [name, settled[index]]));
}

export const authorityOf = (host, port) => `${host}:${String(port)}`;

/** CONNECT and forward probes of host:port. A forward needs HTTP semantics, so it is `http://`. */
export function tunnelAndForward(proxy, host, port, headers = {}) {
  const authority = authorityOf(host, port);
  return {
    [`CONNECT ${authority}`]: proxyConnect(proxy, authority),
    [`GET http://${authority}`]: proxyForward(proxy, `http://${authority}/`, headers),
  };
}
