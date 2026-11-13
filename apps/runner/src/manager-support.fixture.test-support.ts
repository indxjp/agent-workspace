import { createHash } from 'node:crypto';
import { createServer, IncomingMessage, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterEach } from 'vitest';
import { MiB } from '../../../tests/load/flat-memory.js';
import { ClientAbortedError, forward, json, ManagerRequestError } from './manager-support.js';

export const RSS_BOUND = 64 * MiB;

export // The tool-request limit of `manager.ts`; it is not a storage limit.
const TOOL_REQUEST_BYTES = 4 * MiB;

type Seen = {
  method: string | undefined;
  headers: IncomingMessage['headers'];
  bytes: number;
  complete: boolean;
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
          server.closeAllConnections();
        }),
    ),
  );
});

export async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

/** An upstream that discards its body, hashing and counting it, and answers 204 once it ends. */
export async function startUpstream(onData: (bytes: number) => void = () => undefined) {
  const seen: Seen[] = [];
  const finished: Promise<Seen>[] = [];
  const url = await listen(
    createServer((req, res) => {
      const hash = createHash('sha256');
      const entry: Seen = { method: req.method, headers: req.headers, bytes: 0, complete: false };
      seen.push(entry);
      finished.push(
        new Promise<Seen>((resolve) => {
          req.on('close', () => {
            entry.complete = req.complete;
            resolve(entry);
          });
        }),
      );
      req.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        entry.bytes += chunk.byteLength;
        onData(entry.bytes);
      });
      req.on('end', () => {
        res.writeHead(204, { 'x-body-sha256': hash.digest('hex') }).end();
      });
    }),
  );
  return { url, seen, finished };
}

/**
 * A front server that proxies through `forward`, answering a `ManagerRequestError` as `manager.ts`.
 * `onError` sees each error `forward` throws.
 */
export async function startFront(
  upstreamUrl: string,
  limit: number,
  onError: (thrown: unknown) => void = () => undefined,
): Promise<string> {
  return listen(
    createServer((req, res) => {
      forward(req, res, upstreamUrl, fetch, {}, limit).catch((thrown: unknown) => {
        onError(thrown);
        if (thrown instanceof ClientAbortedError || res.headersSent) res.destroy();
        else if (thrown instanceof ManagerRequestError) {
          json(res, 400, { error: thrown.code, message: thrown.message });
        } else json(res, 500, { error: 'internal_error' });
      });
    }),
  );
}

export function post(url: string, body: ReadableStream<Uint8Array>): Promise<Response> {
  return fetch(url, { method: 'POST', body, duplex: 'half' });
}

export function completionSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export function partialChunkedRequest(target: URL): string {
  return `POST / HTTP/1.1\r\nHost: ${target.host}\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n`;
}
