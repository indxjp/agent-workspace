import { ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import { RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
import { TOKEN, withManager, allocate } from './manager.fixture.test-support.js';

it(
  'runner manager Docker lifecycle > [US-STO-06][unit][run] passes a /files archive whose tar framing exceeds the payload limit',
  { timeout: 120_000 },
  async () => {
    await withManager(async (base, _fixture, proxy) => {
      let received = 0;
      proxy.mockImplementation(async (input, init) => {
        const upstreamBody = init?.body;
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname !== '/files' || !(upstreamBody instanceof ReadableStream)) {
          return Response.json({ status: 'ok' });
        }
        for await (const chunk of upstreamBody as AsyncIterable<Uint8Array>) {
          received += chunk.byteLength;
        }
        return new Response(null, { status: 204 });
      });
      const created = await allocate(base);
      const value = (await created.json()) as { runnerUrl: string };
      // One RUN_FILES_MAX_BYTES file: its header and the trailer are on top of the payload.
      const archiveBytes = RUN_FILES_MAX_BYTES + 512 + 1024;
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= archiveBytes) {
            controller.close();
            return;
          }
          const size = Math.min(1024 * 1024, archiveBytes - sent);
          sent += size;
          controller.enqueue(new Uint8Array(size));
        },
      });
      const answer = await fetch(`${value.runnerUrl}/files`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-tar' },
        body,
        duplex: 'half',
      });
      expect(answer.status).toBe(204);
      expect(received).toBe(archiveBytes);
    });
  },
);

it('runner manager Docker lifecycle > [US-STO-06][unit][run] a client that disconnects mid-body is dropped without a failure log', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  // Only the manager's catch destroys this response, once it has decided whether to log.
  const drop = vi.spyOn(ServerResponse.prototype, 'destroy');
  try {
    await withManager(async (base, _fixture, proxy) => {
      const socket = new Socket();
      let settled: () => void = () => undefined;
      const proxied = new Promise<void>((resolve) => {
        settled = resolve;
      });
      proxy.mockImplementation(async (_input, init) => {
        const upstreamBody = init?.body;
        if (!(upstreamBody instanceof ReadableStream)) return Response.json({ status: 'ok' });
        try {
          const reader = (upstreamBody as ReadableStream<Uint8Array>).getReader();
          await reader.read();
          // The first chunk has reached the runtime; the client then goes away mid-body.
          socket.destroy();
          for (;;) if ((await reader.read()).done) break;
          return new Response(null, { status: 204 });
        } finally {
          settled();
        }
      });
      const created = await allocate(base);
      const files = new URL(`${((await created.json()) as { runnerUrl: string }).runnerUrl}/files`);
      socket.connect(Number(files.port), files.hostname);
      socket.write(
        `POST ${files.pathname} HTTP/1.1\r\nHost: ${files.host}\r\nAuthorization: Bearer ${TOKEN}\r\n` +
          'Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n',
      );
      await proxied;
      // The manager's catch drops the response once `forward` has rejected; the log is read after.
      await vi.waitFor(() => {
        expect(drop).toHaveBeenCalled();
      });
    });
    const logged = stderr.mock.calls.map(([line]) => String(line)).join('');
    expect(logged).not.toContain('runner manager request failed');
  } finally {
    drop.mockRestore();
    stderr.mockRestore();
  }
});

it('runner manager Docker lifecycle > [US-STO-06][unit][run] a runtime that fails mid-response is logged as a manager failure', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await withManager(async (base, _fixture, proxy) => {
      let statusReceived: () => void = () => undefined;
      const answered = new Promise<void>((resolve) => {
        statusReceived = resolve;
      });
      proxy.mockImplementation((input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname !== '/files') return Promise.resolve(Response.json({ status: 'ok' }));
        // The runtime answers 200 and sends part of the download; it dies once the client has
        // the status line, so the failure comes after the manager's headers are sent.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(64 * 1024));
            void answered.then(() => {
              controller.error(new Error('the runtime went away'));
            });
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      });
      const created = await allocate(base);
      const { runnerUrl } = (await created.json()) as { runnerUrl: string };
      const answer = await fetch(`${runnerUrl}/files`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(answer.status).toBe(200);
      statusReceived();
      await expect(answer.arrayBuffer()).rejects.toThrow();
      await vi.waitFor(() => {
        const logged = stderr.mock.calls.map(([line]) => String(line)).join('');
        expect(logged).toContain('runner manager request failed: the runtime went away');
      });
    });
  } finally {
    stderr.mockRestore();
  }
});
