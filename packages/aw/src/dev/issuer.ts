/**
 * Issue #2075, ADR-0161's 2026-11-01 amendment (DI1 to DI7): `aw dev`'s development OIDC issuer,
 * so a generated app signs a person in and acts as them by the platform's unchanged token exchange
 * on a developer's machine. It is a tool of the CLI and runs inside the `aw dev` process; the
 * platform never imports it, and the production posture refuses any non-`https:` issuer.
 *
 * - One `node:http` listener on `127.0.0.1` only, on the first free port from the web port + 200.
 *   A request whose `Host` is not exactly `127.0.0.1:<port>` is refused `421`.
 * - Four endpoints: discovery, the JWKS, `/authorize` (the code flow, S256 PKCE and `state`
 *   required, `query` or `form_post`) and `/token` (`client_secret_basic` only, single-use codes
 *   that live 60 seconds). Every other path is `404`.
 * - One Ed25519 key pair per process from `node:crypto`, held in memory only; ID tokens are
 *   compact EdDSA JWS signed with `node:crypto.sign`. No cryptography of its own beyond base64url.
 * - The person types a member's email and the local console password. The issuer reads no
 *   database: membership stays the platform's decision.
 *
 * Nothing it answers or logs carries a password, a code, a client secret or a token, except the
 * code in the redirect and the tokens in `/token`'s `200`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { CommandRefusedError } from '../io.js';

import { jsonAnswer, oauthError, type IssuerAnswer } from './issuer-answer.js';
import { DEV_ISSUER_SESSION_COOKIE } from './issuer-authorize.js';
import { createDevIssuerCore, type DevIssuerCore } from './issuer-core.js';

export { DEV_ISSUER_SESSION_COOKIE } from './issuer-authorize.js';
export { devIssuerSubject } from './issuer-crypto.js';
export { formLocale } from './issuer-form.js';

/** How far past the web port the issuer's port starts, and how many ports are tried (DI1). */
export const DEV_ISSUER_PORT_OFFSET = 200;
export const DEV_ISSUER_PORT_SEARCH_LIMIT = 50;

const MAX_BODY_BYTES = 16 * 1024;

/** The value of `name` in a `Cookie` header, or `undefined`. */
function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

class BodyTooLargeError extends Error {}

/** The request's body as text, refused past {@link MAX_BODY_BYTES}. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError('body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A form body's parameters, each named once; `undefined` when it is not form-encoded. */
async function formParameters(
  request: IncomingMessage,
): Promise<Record<string, string> | undefined> {
  const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') return undefined;
  return singleValued(new URLSearchParams(await readBody(request)));
}

/** The parameters, or `undefined` when one is named twice. */
function singleValued(search: URLSearchParams): Record<string, string> | undefined {
  const parameters: Record<string, string> = {};
  for (const [name, value] of search) {
    if (Object.hasOwn(parameters, name)) return undefined;
    parameters[name] = value;
  }
  return parameters;
}

async function answerAuthorize(
  core: DevIssuerCore,
  request: IncomingMessage,
  url: URL,
  method: 'GET' | 'POST',
): Promise<IssuerAnswer> {
  const parameters =
    method === 'GET' ? singleValued(url.searchParams) : await formParameters(request);
  if (parameters === undefined) return oauthError(400, 'invalid_request');
  return core.authorize({
    method,
    parameters,
    sessionId: cookieValue(request.headers.cookie, DEV_ISSUER_SESSION_COOKIE),
    acceptLanguage: request.headers['accept-language'],
  });
}

async function answerToken(core: DevIssuerCore, request: IncomingMessage): Promise<IssuerAnswer> {
  const parameters = await formParameters(request);
  if (parameters === undefined) return oauthError(400, 'invalid_request');
  return core.token(request.headers.authorization, parameters);
}

async function answer(
  core: DevIssuerCore,
  host: string,
  request: IncomingMessage,
): Promise<IssuerAnswer> {
  if (request.headers.host !== host) return jsonAnswer(421, { error: 'dev_issuer_wrong_host' });
  const url = new URL(request.url ?? '/', `http://${host}`);
  const method = request.method ?? 'GET';
  const route = `${method} ${url.pathname}`;
  switch (route) {
    case 'GET /.well-known/openid-configuration':
      return core.discovery();
    case 'GET /jwks':
      return core.jwks();
    case 'GET /authorize':
      return answerAuthorize(core, request, url, 'GET');
    case 'POST /authorize':
      return answerAuthorize(core, request, url, 'POST');
    case 'POST /token':
      return answerToken(core, request);
    default:
      return jsonAnswer(404, { error: 'not_found' });
  }
}

function send(response: ServerResponse, value: IssuerAnswer): void {
  response.writeHead(value.status, value.headers);
  response.end(value.body);
}

/** `aw dev`'s running issuer. */
export interface DevIssuer {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly port: number;
  /** Register (or replace) a client; returns its secret, which is never printed. */
  registerClient(clientId: string, redirectUri: string): string;
  close(): Promise<void>;
}

export interface StartDevIssuerOptions {
  readonly webPort: number;
  readonly defaultEmail: string;
  readonly readPassword: () => Promise<string | undefined>;
  readonly now?: () => number;
}

function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Start the issuer on `127.0.0.1`, on the first free port from `webPort + 200` (50 tried), or
 * refuse with `dev_issuer_port_unavailable` (DI1).
 */
export async function startDevIssuer(options: StartDevIssuerOptions): Promise<DevIssuer> {
  let core: DevIssuerCore | undefined;
  let host = '';
  const server = createServer((request, response) => {
    if (core === undefined) {
      send(response, jsonAnswer(503, { error: 'temporarily_unavailable' }));
      return;
    }
    answer(core, host, request).then(
      (value) => {
        send(response, value);
      },
      (error: unknown) => {
        send(
          response,
          oauthError(error instanceof BodyTooLargeError ? 413 : 500, 'invalid_request'),
        );
      },
    );
  });
  for (let step = 0; step < DEV_ISSUER_PORT_SEARCH_LIMIT; step += 1) {
    const port = options.webPort + DEV_ISSUER_PORT_OFFSET + step;
    if (port > 65_535) break;
    if (!(await listen(server, port))) continue;
    host = `127.0.0.1:${String(port)}`;
    const url = `http://${host}`;
    const started = createDevIssuerCore({
      issuer: url,
      defaultEmail: options.defaultEmail,
      readPassword: options.readPassword,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    core = started;
    return {
      url,
      port,
      registerClient: (clientId, redirectUri) => started.registerClient(clientId, redirectUri),
      close: () =>
        new Promise((resolve) => {
          server.close(() => {
            resolve();
          });
          server.closeAllConnections();
        }),
    };
  }
  const first = options.webPort + DEV_ISSUER_PORT_OFFSET;
  throw new CommandRefusedError(
    `dev_issuer_port_unavailable: no free port from ${String(first)} to ${String(first + DEV_ISSUER_PORT_SEARCH_LIMIT - 1)} for the development OIDC issuer`,
    'stop what holds those ports, or start aw dev on another --port',
  );
}
