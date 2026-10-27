// @story US-STO-06
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo, Socket } from 'node:net';

import { RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  generatedBody,
  MiB,
  peakRssGrowth,
  warmHttpTransport,
} from '../../../tests/load/flat-memory.js';
import { forward, json, ManagerRequestError } from './manager-support.js';

const RSS_BOUND = 64 * MiB;
// The tool-request limit of `manager.ts`; it is not a storage limit.
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

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

/** An upstream that discards its body, hashing and counting it, and answers 204 once it ends. */
async function startUpstream(onData: (bytes: number) => void = () => undefined) {
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

/** A front server that proxies through `forward`, answering a `ManagerRequestError` as `manager.ts`. */
async function startFront(upstreamUrl: string, limit: number): Promise<string> {
  return listen(
    createServer((req, res) => {
      forward(req, res, upstreamUrl, fetch, {}, limit).catch((thrown: unknown) => {
        if (thrown instanceof ManagerRequestError) {
          json(res, 400, { error: thrown.code, message: thrown.message });
        } else json(res, 500, { error: 'internal_error' });
      });
    }),
  );
}

function post(url: string, body: ReadableStream<Uint8Array>): Promise<Response> {
  return fetch(url, { method: 'POST', body, duplex: 'half' });
}

describe('forward', () => {
  it(
    '[US-STO-06][unit][run] forward streams a 128 MiB body with flat memory',
    { timeout: 120_000 },
    async () => {
      let delivered: () => void = () => undefined;
      const arrived = new Promise<void>((resolve) => {
        delivered = resolve;
      });
      const upstream = await startUpstream((bytes) => {
        if (bytes === RUN_FILES_MAX_BYTES) delivered();
      });
      const front = await startFront(upstream.url, RUN_FILES_MAX_BYTES);
      // The shared transport warm-up skips `forward`, so a `forward` that buffers holds nothing
      // before the baseline (one through `forward` let a buffering one read 63 MiB, not 120-158).
      await warmHttpTransport();
      // And 1 MiB through `forward`, so its own code is loaded before the baseline.
      await (await post(front, generatedBody(MiB).body)).arrayBuffer();
      upstream.seen.length = 0;
      const { body, sha256 } = generatedBody(RUN_FILES_MAX_BYTES);
      let sent = 0;
      let answer: Promise<Response> | undefined;
      const growth = await peakRssGrowth(async (sample) => {
        const sampled = body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              sent += chunk.byteLength;
              // Each hop allocates a fresh buffer per socket read, and V8 lets that garbage reach
              // about 64 MiB of external memory before it collects on its own; glibc keeps the
              // pages, so sampling every 32 MiB read up to 67 MiB on Linux with ~8 MiB in flight.
              // Collecting every 4 MiB keeps garbage out of the reading; nothing retained is freed.
              if (sent % (4 * MiB) === 0) sample();
              controller.enqueue(chunk);
            },
          }),
        );
        // The reading ends once the upstream holds every byte. The 204 that follows carries no
        // body, yet RSS rose 14-26 MiB while the client took it in, at 32 MiB as at 128 MiB, with
        // no V8 heap or ArrayBuffer growth (Linux, Node 24, with and without coverage).
        answer = post(front, sampled);
        await Promise.race([arrived, answer]);
      });
      const response = await answer;
      expect(response?.status).toBe(204);
      expect(upstream.seen[0]?.bytes).toBe(RUN_FILES_MAX_BYTES);
      expect(response?.headers.get('x-body-sha256')).toBe(await sha256);
      expect(growth).toBeLessThan(RSS_BOUND);
    },
  );

  it('[US-STO-06][unit][run] forward refuses a body over the limit', async () => {
    const upstream = await startUpstream();
    const front = await startFront(upstream.url, MiB);
    const { body } = generatedBody(4 * MiB);
    const answer = await post(front, body);
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error: string }).error).toBe('request_too_large');
    const [entry] = await Promise.all(upstream.finished);
    expect(entry?.complete).toBe(false);
    expect(entry?.bytes).toBeLessThan(4 * MiB);
  });

  it('[US-STO-06][unit][run] forward passes a 4 MiB tool request intact', async () => {
    const upstream = await startUpstream();
    const front = await startFront(upstream.url, TOOL_REQUEST_BYTES);
    const { body, sha256 } = generatedBody(TOOL_REQUEST_BYTES);
    const answer = await post(front, body);
    expect(answer.status).toBe(204);
    expect(upstream.seen[0]?.bytes).toBe(TOOL_REQUEST_BYTES);
    expect(answer.headers.get('x-body-sha256')).toBe(await sha256);
  });

  it('[US-STO-06][unit][run] forward aborts the upstream when the client disconnects', async () => {
    const socket = new Socket();
    // The client disconnects once its first chunk has reached the upstream, mid-body.
    const upstream = await startUpstream(() => socket.destroy());
    const front = new URL(await startFront(upstream.url, MiB));
    socket.connect(Number(front.port), front.hostname);
    socket.write(
      `POST / HTTP/1.1\r\nHost: ${front.host}\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n`,
    );
    await vi.waitFor(() => {
      expect(upstream.finished).toHaveLength(1);
    });
    const [entry] = await Promise.all(upstream.finished);
    expect(entry?.complete).toBe(false);
  });

  it('[US-STO-06][unit][run] forward aborts the upstream when the client disconnects after its body', async () => {
    let upstreamClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const socket = new Socket();
    // The upstream reads the whole body and never answers; the client then goes away.
    const upstream = await listen(
      createServer((req) => {
        req.socket.once('close', upstreamClosed);
        req.resume();
        req.once('end', () => socket.destroy());
      }),
    );
    const front = new URL(await startFront(upstream, MiB));
    socket.connect(Number(front.port), front.hostname);
    socket.write(`POST / HTTP/1.1\r\nHost: ${front.host}\r\nContent-Length: 5\r\n\r\nhello`);
    await closed;
  });

  it('[US-STO-06][unit][run] forward sends no body for a GET', async () => {
    const upstream = await startUpstream();
    const front = await startFront(upstream.url, MiB);
    const answer = await fetch(front);
    expect(answer.status).toBe(204);
    expect(upstream.seen[0]?.method).toBe('GET');
    expect(upstream.seen[0]?.bytes).toBe(0);
    expect(upstream.seen[0]?.headers['transfer-encoding']).toBeUndefined();
  });
});
