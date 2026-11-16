/**
 * The tool sandbox's HTTP file intake (ADR-0118 TS2-TS5; BYOC on Google Cloud).
 *
 * Cloud Run has no `docker exec` and no file API, and a container that does not listen on `$PORT`
 * never becomes Ready. With `AW_TOOL_INTAKE_KEY` set this process therefore listens at once and
 * takes the two files the runner would have written, `manifest.json` and `tokens.json`, over
 * `PUT /files/<name>`. The manifest goes through `runSandbox` unchanged (so the secrets still live
 * only in the host's environment); once the host is ready every other request is proxied to it on
 * a loopback port. Nothing here logs a header, a token, the key or a manifest value.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';

import type { ToolHost } from '@indx-workspace/aw/tools/host';

import {
  MANIFEST_FILE,
  parseManifest,
  runSandbox,
  TOKENS_FILE,
  type SandboxOptions,
} from './sandbox.js';

export const INTAKE_KEY_VARIABLE = 'AW_TOOL_INTAKE_KEY';
const INTAKE_KEY_HEADER = 'x-aw-tool-intake';
export const INTAKE_KEY_MIN_LENGTH = 32;
const INTAKE_MAX_BODY_BYTES = 64 * 1024 * 1024;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface IntakeOptions extends SandboxOptions {
  /** The shared secret the runner presents; at least {@link INTAKE_KEY_MIN_LENGTH} characters. */
  readonly intakeKey: string;
  /** The body cap of one file; 64 MiB by default. */
  readonly maxBodyBytes?: number;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

function sendError(response: ServerResponse, status: number, error: string): void {
  response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  response.end(JSON.stringify({ error }));
}

function forwardable(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const kept: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name) && name !== INTAKE_KEY_HEADER) kept[name] = value;
  }
  return kept;
}

/** The body, or `undefined` once it is over the cap (the caller has then been answered). */
function readBody(
  req: IncomingMessage,
  response: ServerResponse,
  limit: number,
): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      sendError(response, 413, 'tool_intake_too_large');
      resolve(undefined);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        req.removeAllListeners('data');
        req.resume();
        sendError(response, 413, 'tool_intake_too_large');
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

function proxy(req: IncomingMessage, response: ServerResponse, port: number): void {
  const upstream = request(
    {
      host: '127.0.0.1',
      port,
      method: req.method,
      path: req.url,
      headers: forwardable(req.headers),
      agent: false,
    },
    (answer) => {
      const headers: OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (!HOP_BY_HOP.has(name)) headers[name] = value;
      }
      response.writeHead(answer.statusCode ?? 502, headers);
      answer.pipe(response);
      answer.on('error', () => response.destroy());
    },
  );
  upstream.on('error', () => {
    if (response.headersSent) response.destroy();
    else sendError(response, 502, 'tool_host_unavailable');
  });
  response.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

/**
 * Listen at once, take `manifest.json` and `tokens.json` over HTTP, start the hosted tool host
 * through `runSandbox` on a loopback port, and proxy to it once it is ready.
 */
export async function runIntakeSandbox(options: IntakeOptions): Promise<ToolHost> {
  const { intakeKey, maxBodyBytes = INTAKE_MAX_BODY_BYTES, ...sandbox } = options;
  const { directory, host, port } = sandbox;
  const keyDigest = digest(intakeKey);
  let internalPort = 0;
  let ready = false;
  let manifestTaken = false;

  const put = async (req: IncomingMessage, response: ServerResponse, name: string) => {
    const presented = req.headers[INTAKE_KEY_HEADER];
    if (typeof presented !== 'string' || !timingSafeEqual(digest(presented), keyDigest)) {
      sendError(response, 401, 'tool_intake_unauthorized');
      req.resume();
      return;
    }
    if (name === MANIFEST_FILE && manifestTaken) {
      sendError(response, 409, 'tool_intake_manifest_taken');
      req.resume();
      return;
    }
    const body = await readBody(req, response, maxBodyBytes);
    if (body === undefined) return;
    const text = body.toString('utf8');
    if (name === MANIFEST_FILE) {
      try {
        parseManifest(text);
      } catch {
        sendError(response, 400, 'tool_intake_manifest_invalid');
        return;
      }
      if (manifestTaken) {
        sendError(response, 409, 'tool_intake_manifest_taken');
        return;
      }
      manifestTaken = true;
    } else {
      let tokens: unknown;
      try {
        tokens = JSON.parse(text);
      } catch {
        tokens = undefined;
      }
      if (!Array.isArray(tokens) || !tokens.every((token) => typeof token === 'string')) {
        sendError(response, 400, 'tool_intake_tokens_invalid');
        return;
      }
    }
    const target = path.join(directory, name);
    const partial = `${target}.tmp`;
    try {
      await writeFile(partial, body, { mode: 0o600 });
      await rename(partial, target);
    } catch (error) {
      if (name === MANIFEST_FILE) manifestTaken = false;
      throw error;
    }
    response.writeHead(204).end();
  };

  const server: Server = createServer((req, response) => {
    const route = (): Promise<void> | void => {
      const url = new URL(req.url ?? '/', 'http://intake.invalid');
      if (req.method === 'PUT' && url.pathname === `/files/${MANIFEST_FILE}`) {
        return put(req, response, MANIFEST_FILE);
      }
      if (req.method === 'PUT' && url.pathname === `/files/${TOKENS_FILE}`) {
        return put(req, response, TOKENS_FILE);
      }
      // Liveness only, ready or not: Cloud Run's startup probe needs a 2xx before `create` returns.
      if (req.method === 'GET' && url.pathname === '/ping') {
        response.writeHead(200).end();
        req.resume();
        return;
      }
      if (!ready) {
        sendError(response, 503, 'tool_host_not_ready');
        req.resume();
        return;
      }
      proxy(req, response, internalPort);
    };
    Promise.resolve()
      .then(route)
      .catch(() => {
        if (response.headersSent) response.destroy();
        else sendError(response, 500, 'tool_intake_failed');
      });
  });

  // No provider mounts the directory on Cloud Run: made here, before the listener, so a directory
  // the host cannot create stops the container instead of failing every upload with a 500.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const stopServer = (): void => {
    server.close();
    server.closeAllConnections();
  };

  try {
    internalPort = await freeLoopbackPort();
    const started = await runSandbox({ ...sandbox, host: '127.0.0.1', port: internalPort });
    ready = true;
    const closed = started.closed.finally(stopServer);
    return { url: `http://${host}:${String(port)}/mcp`, tools: started.tools, closed };
  } catch (error) {
    stopServer();
    throw error;
  }
}
