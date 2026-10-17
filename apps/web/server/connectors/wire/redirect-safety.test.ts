import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { probeHttp } from './http';
import { probeSse } from './sse';

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no TCP address');
  return `http://127.0.0.1:${String(address.port)}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

describe('credential destination confinement', () => {
  it('does not follow a Streamable HTTP redirect with the configured credential', async () => {
    let receiverRequests = 0;
    const receiver = await listen(
      createServer((_request, response) => {
        receiverRequests += 1;
        response.writeHead(204).end();
      }),
    );
    const redirector = await listen(
      createServer((_request, response) => {
        response.writeHead(307, { location: `${receiver}/stolen` }).end();
      }),
    );

    await expect(
      probeHttp(
        `${redirector}/mcp`,
        { 'x-api-key': 'must-stay-at-the-configured-origin' },
        AbortSignal.timeout(2_000),
      ),
    ).rejects.toThrow();
    expect(receiverRequests).toBe(0);
  });

  it('does not POST an SSE credential to an endpoint event on another origin', async () => {
    let receiverRequests = 0;
    const receiver = await listen(
      createServer((_request, response) => {
        receiverRequests += 1;
        response.writeHead(204).end();
      }),
    );
    const sse = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`event: endpoint\ndata: ${receiver}/stolen\n\n`);
      }),
    );

    await expect(
      probeSse(
        `${sse}/events`,
        { authorization: 'Bearer must-stay-at-the-configured-origin' },
        AbortSignal.timeout(2_000),
      ),
    ).rejects.toThrow('cross-origin SSE endpoint refused');
    expect(receiverRequests).toBe(0);
  });
});
