import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
import { expect, it, vi } from 'vitest';
import {
  generatedBody,
  MiB,
  peakRssGrowth,
  warmHttpTransport,
} from '../../../tests/load/flat-memory.js';
import { ClientAbortedError, forward } from './manager-support.js';
import {
  RSS_BOUND,
  TOOL_REQUEST_BYTES,
  listen,
  startUpstream,
  startFront,
  post,
  completionSignal,
  partialChunkedRequest,
} from './manager-support.fixture.test-support.js';

it(
  'forward > [US-STO-06][unit][run] forward streams a 128 MiB body with flat memory',
  { timeout: 120_000 },
  async () => {
    const { promise: arrived, resolve: delivered } = completionSignal();
    const upstream = await startUpstream((bytes) => {
      if (bytes === RUN_FILES_MAX_BYTES) delivered();
    });
    const front = await startFront(upstream.url, RUN_FILES_MAX_BYTES);
    // The shared transport warm-up skips `forward`, so a `forward` that buffers holds nothing
    // before the baseline. With this setup the streaming `forward` reads 0.9-1.1 MiB, and one
    // that buffers the body before calling the upstream reads 257-383 MiB (Linux, Node 24).
    await warmHttpTransport();
    // And 1 MiB through `forward`, so its own code is loaded before the baseline. A fixed buffer,
    // not `generatedBody`, whose 16 MiB ring would outlive the warm-up into the baseline.
    await (await fetch(front, { method: 'POST', body: new Uint8Array(MiB) })).arrayBuffer();
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

it('forward > [US-STO-06][unit][run] forward refuses a body over the limit', async () => {
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

it('forward > [US-STO-06][unit][run] forward passes a 4 MiB tool request intact', async () => {
  const upstream = await startUpstream();
  const front = await startFront(upstream.url, TOOL_REQUEST_BYTES);
  const { body, sha256 } = generatedBody(TOOL_REQUEST_BYTES);
  const answer = await post(front, body);
  expect(answer.status).toBe(204);
  expect(upstream.seen[0]?.bytes).toBe(TOOL_REQUEST_BYTES);
  expect(answer.headers.get('x-body-sha256')).toBe(await sha256);
});

it('forward > [US-STO-06][unit][run] forward aborts the upstream when the client disconnects', async () => {
  const socket = new Socket();
  // The client disconnects once its first chunk has reached the upstream, mid-body.
  const upstream = await startUpstream(() => socket.destroy());
  const front = new URL(await startFront(upstream.url, MiB));
  socket.connect(Number(front.port), front.hostname);
  socket.write(partialChunkedRequest(front));
  await vi.waitFor(() => {
    expect(upstream.finished).toHaveLength(1);
  });
  const [entry] = await Promise.all(upstream.finished);
  expect(entry?.complete).toBe(false);
});

it('forward > [US-STO-06][unit][run] forward aborts the upstream when the client disconnects after its body', async () => {
  const { promise: closed, resolve: upstreamClosed } = completionSignal();
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

it('forward > [US-STO-06][unit][run] forward sends no body for a GET', async () => {
  const upstream = await startUpstream();
  const front = await startFront(upstream.url, MiB);
  const answer = await fetch(front);
  expect(answer.status).toBe(204);
  expect(upstream.seen[0]?.method).toBe('GET');
  expect(upstream.seen[0]?.bytes).toBe(0);
  expect(upstream.seen[0]?.headers['transfer-encoding']).toBeUndefined();
});

it('forward > [US-STO-06][unit][run] forward passes the client content-length instead of chunking', async () => {
  const upstream = await startUpstream();
  const front = await startFront(upstream.url, MiB);
  const answer = await fetch(front, { method: 'POST', body: new Uint8Array(4096) });
  expect(answer.status).toBe(204);
  expect(upstream.seen[0]?.headers['content-length']).toBe('4096');
  expect(upstream.seen[0]?.headers['transfer-encoding']).toBeUndefined();
  expect(upstream.seen[0]?.bytes).toBe(4096);
});

it('forward > [US-STO-06][unit][run] forward refuses a declared content-length over the limit before the upstream is called', async () => {
  const doFetch = vi.fn<typeof fetch>();
  const req = new IncomingMessage(new Socket());
  req.method = 'POST';
  req.headers = { 'content-length': String(MiB + 1) };
  await expect(
    forward(req, new ServerResponse(req), 'http://upstream.invalid/', doFetch, {}, MiB),
  ).rejects.toMatchObject({ code: 'request_too_large' });
  expect(doFetch).not.toHaveBeenCalled();
});

it('forward > [US-STO-06][unit][run] forward survives a second request error and leaves no listener behind', async () => {
  const req = new IncomingMessage(new Socket());
  req.method = 'POST';
  req.headers = {};
  const doFetch = vi.fn<typeof fetch>(async (_url, init) => {
    req.emit('error', new Error('the first request error'));
    req.emit('error', new Error('the second request error'));
    await new Response(init?.body).arrayBuffer();
    return new Response(null, { status: 204 });
  });
  await expect(
    forward(req, new ServerResponse(req), 'http://upstream.invalid/', doFetch),
  ).rejects.toBeInstanceOf(ClientAbortedError);
  expect(req.listenerCount('error')).toBe(0);
});

it('forward > [US-STO-06][unit][run] forward reports a client that disconnects mid-body as a client abort', async () => {
  const thrown: unknown[] = [];
  const socket = new Socket();
  const upstream = await startUpstream(() => socket.destroy());
  const front = new URL(
    await startFront(upstream.url, MiB, (error) => {
      thrown.push(error);
    }),
  );
  socket.connect(Number(front.port), front.hostname);
  socket.write(partialChunkedRequest(front));
  await vi.waitFor(() => {
    expect(thrown).toHaveLength(1);
  });
  expect(thrown[0]).toBeInstanceOf(ClientAbortedError);
});

it('forward > [US-STO-06][unit][run] forward reports an upstream that fails mid-response as the transport error', async () => {
  const thrown: unknown[] = [];
  // The upstream answers 200, sends part of its body, then dies.
  const upstream = await listen(
    createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(Buffer.alloc(64 * 1024, 1), () => res.socket?.destroy());
    }),
  );
  const front = await startFront(upstream, MiB, (error) => {
    thrown.push(error);
  });
  const answer = await fetch(front);
  expect(answer.status).toBe(200);
  await expect(answer.arrayBuffer()).rejects.toThrow();
  await vi.waitFor(() => {
    expect(thrown).toHaveLength(1);
  });
  expect(thrown[0]).not.toBeInstanceOf(ClientAbortedError);
  expect(thrown[0]).toBeInstanceOf(Error);
});

it('forward > [US-STO-06][unit][run] forward reports a client that leaves mid-response as a client abort', async () => {
  const thrown: unknown[] = [];
  const socket = new Socket();
  // The upstream keeps its response open; the client leaves once the first bytes arrive.
  const upstream = await listen(
    createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(Buffer.alloc(64 * 1024, 1));
    }),
  );
  const front = new URL(
    await startFront(upstream, MiB, (error) => {
      thrown.push(error);
    }),
  );
  socket.once('data', () => socket.destroy());
  socket.connect(Number(front.port), front.hostname);
  socket.write(`GET / HTTP/1.1\r\nHost: ${front.host}\r\n\r\n`);
  await vi.waitFor(() => {
    expect(thrown).toHaveLength(1);
  });
  expect(thrown[0]).toBeInstanceOf(ClientAbortedError);
});

it('forward > [US-STO-06][unit][run] a GET body is discarded, so the next request on a kept-alive socket is answered', async () => {
  const upstream = await startUpstream();
  const front = new URL(await startFront(upstream.url, MiB));
  const socket = new Socket();
  let received = '';
  socket.on('data', (chunk: Buffer) => {
    received += chunk.toString('latin1');
  });
  socket.connect(Number(front.port), front.hostname);
  const head = `Host: ${front.host}\r\nConnection: keep-alive`;
  socket.write(`GET /first HTTP/1.1\r\n${head}\r\nContent-Length: ${String(MiB)}\r\n\r\n`);
  socket.write(Buffer.alloc(MiB, 7));
  socket.write(`GET /second HTTP/1.1\r\n${head}\r\n\r\n`);
  try {
    await vi.waitFor(() => {
      expect(received.match(/HTTP\/1\.1 204/gu)).toHaveLength(2);
    });
    expect(upstream.seen.map((entry) => [entry.method, entry.bytes])).toEqual([
      ['GET', 0],
      ['GET', 0],
    ]);
  } finally {
    socket.destroy();
  }
});

it(
  'forward > [US-STO-06][unit][run] forward streams a 128 MiB response with flat memory',
  { timeout: 120_000 },
  async () => {
    const chunk = Buffer.alloc(64 * 1024, 7);
    const upstream = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        void pipeline(
          Readable.from(
            (function* () {
              for (let left = RUN_FILES_MAX_BYTES; left > 0; left -= chunk.byteLength) yield chunk;
            })(),
          ),
          res,
        ).catch(() => undefined);
      }),
    );
    const front = await startFront(upstream, RUN_FILES_MAX_BYTES);
    // The streaming `forward` reads 0.4-0.6 MiB here; one that buffers the response reads about
    // 257 MiB (Linux, Node 24).
    await warmHttpTransport();
    let received = 0;
    const growth = await peakRssGrowth(async (sample) => {
      const answer = await fetch(front);
      expect(answer.status).toBe(200);
      if (answer.body === null) throw new Error('the forwarded response has no body');
      for await (const part of answer.body as AsyncIterable<Uint8Array>) {
        const before = received;
        received += part.byteLength;
        // Every 4 MiB (bound/16), so socket-read garbage is not read as growth.
        if (Math.floor(received / (4 * MiB)) > Math.floor(before / (4 * MiB))) sample();
      }
    });
    expect(received).toBe(RUN_FILES_MAX_BYTES);
    expect(growth).toBeLessThan(RSS_BOUND);
  },
);
